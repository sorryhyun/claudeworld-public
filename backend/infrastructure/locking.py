"""
File locking utilities for safe concurrent file writes.

This module provides thread-safe and process-safe file locking mechanisms
to prevent race conditions when multiple agents write to the same config files.

Platform Support:
- POSIX systems (Linux, macOS): Uses fcntl for process-safe file locking
- Windows: Uses msvcrt for file locking, or threading.Lock as fallback

Windows notes (msvcrt.locking differs from fcntl.flock in three ways):
- It requires a handle opened for writing, so read-only opens are not locked.
- It locks N bytes from the *current file position*, not the whole file, so a
  lock is only mutually exclusive if every party locks the same byte range.
  Everything here locks byte 0.
- It has no shared (reader) lock.
"""

import logging
import os
import sys
import tempfile
import threading
from contextlib import contextmanager
from typing import Any

# Platform-specific imports
# Type stubs for conditional imports
fcntl: Any = None
msvcrt: Any = None

# Defined unconditionally: HAS_FCNTL short-circuits every use today, but a
# conditional definition is a NameError one refactor away.
HAS_FCNTL = False
HAS_MSVCRT = False

try:
    import fcntl

    HAS_FCNTL = True
except ImportError:
    # Windows fallback
    if sys.platform == "win32":
        try:
            import msvcrt

            HAS_MSVCRT = True
        except ImportError:
            pass

logger = logging.getLogger("FileLocking")

# Fallback lock for systems without fcntl or msvcrt
_file_locks: dict[str, threading.Lock] = {}
_locks_lock = threading.Lock()


def _get_thread_lock(file_path: str) -> threading.Lock:
    """Get or create a threading.Lock for the given file path."""
    with _locks_lock:
        if file_path not in _file_locks:
            _file_locks[file_path] = threading.Lock()
        return _file_locks[file_path]


def _is_read_only(mode: str) -> bool:
    """True if the mode opens the file without write access."""
    return "r" in mode and "+" not in mode


def _ensure_parent_dir(file_path: str) -> None:
    """Create the parent directory of file_path if it has one."""
    parent = os.path.dirname(file_path)
    if parent:
        os.makedirs(parent, exist_ok=True)


@contextmanager
def _msvcrt_lock(f):
    """Lock byte 0 of an open (writable) file on Windows.

    Always byte 0, never "1 byte at the current position": in append mode the
    position is EOF, so two appenders would lock different ranges and both
    proceed. Appending writes still go to EOF regardless of the seek position.
    """
    position = f.tell()
    try:
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
    except OSError as e:
        f.seek(position)
        logger.warning(f"Could not lock {f.name}, proceeding unlocked: {e}")
        yield
        return

    f.seek(position)
    try:
        yield
    finally:
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass  # May already be unlocked on close
        finally:
            f.seek(position)


@contextmanager
def file_lock(file_path: str, mode: str = "a"):
    """
    Context manager for cross-platform file locking.

    This prevents race conditions when multiple agents try to write to the
    same file concurrently (e.g., memory.md, recent_events.md).

    Platform-specific implementation:
    - POSIX (Linux, macOS): Uses fcntl for process-safe locking
    - Windows: Uses msvcrt for file locking; read-only opens are not locked
      because msvcrt.locking needs a writable handle
    - Fallback: Uses threading.Lock (thread-safe only, not process-safe)

    Truncating modes ('w', 'wb') are written atomically: the caller writes to a
    temp file in the same directory, which replaces the target on clean exit.
    A concurrent reader therefore sees either the old file or the new one, never
    a half-written or empty one. If the block raises, the target is left alone.

    Usage:
        with file_lock('/path/to/file.txt', 'a') as f:
            f.write('new content\\n')

    Args:
        file_path: Path to the file to lock
        mode: File open mode ('a' for append, 'w' for write, 'r' for read,
            'r+' for read+write)

    Yields:
        File handle with exclusive lock

    Raises:
        OSError: If the file cannot be opened
    """
    read_only = _is_read_only(mode)
    if not read_only:
        _ensure_parent_dir(file_path)

    if mode.startswith("w"):
        with _atomic_write(file_path, mode) as f:
            yield f
        return

    # Get threading lock as fallback
    thread_lock = None
    if not HAS_FCNTL and not HAS_MSVCRT:
        thread_lock = _get_thread_lock(file_path)
        thread_lock.acquire()
        logger.debug(f"Acquired thread lock on {file_path} (fallback mode)")

    try:
        encoding = None if "b" in mode else "utf-8"
        with open(file_path, mode, encoding=encoding) as f:
            if HAS_FCNTL:
                # POSIX: shared lock for reads, exclusive for writes
                lock_type = fcntl.LOCK_SH if read_only else fcntl.LOCK_EX
                try:
                    fcntl.flock(f.fileno(), lock_type)
                    logger.debug(f"Acquired fcntl lock on {file_path}")
                except OSError as e:
                    # Some filesystems (older NFS, some FUSE mounts) refuse flock.
                    # A missing lock is better than a failed read.
                    logger.warning(f"Could not lock {file_path}, proceeding unlocked: {e}")
                    yield f
                    return
                try:
                    yield f
                finally:
                    try:
                        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                    except OSError as e:
                        logger.warning(f"Error releasing file lock on {file_path}: {e}")
            elif HAS_MSVCRT and not read_only:
                with _msvcrt_lock(f):
                    yield f
            else:
                # Read-only on Windows: msvcrt.locking needs a writable handle,
                # so locking here would raise instead of protecting anything.
                # Writes are atomic (see _atomic_write), so an unlocked reader
                # still never sees a half-written file.
                # Or: the thread-lock fallback acquired above.
                yield f
    finally:
        if thread_lock:
            thread_lock.release()
            logger.debug(f"Released thread lock on {file_path}")


@contextmanager
def _atomic_write(file_path: str, mode: str):
    """Yield a handle to a temp file that replaces file_path on clean exit.

    os.replace() is atomic on POSIX and Windows, so this needs no lock: a reader
    never observes a partially written file. Locking could not provide that —
    open(path, "w") truncates before any lock can be taken.
    """
    directory = os.path.dirname(file_path) or "."
    encoding = None if "b" in mode else "utf-8"
    # ".tmp" suffix, never the target's: directories here are scanned with
    # globs like "*.yaml"/"*.md", and a temp file left by a crash must not match.
    fd, temp_path = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(file_path)}-",
        suffix=".tmp",
    )

    try:
        with os.fdopen(fd, mode, encoding=encoding) as f:
            yield f
            f.flush()
            os.fsync(f.fileno())
        # mkstemp creates 0600; keep whatever the target already had.
        try:
            os.chmod(temp_path, os.stat(file_path).st_mode & 0o777)
        except OSError:
            pass  # New file — 0600 is a fine default
        os.replace(temp_path, file_path)
        logger.debug(f"Atomically wrote {file_path}")
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def safe_append_line(file_path: str, line: str) -> bool:
    """
    Safely append a line to a file with file locking.

    Args:
        file_path: Path to the file
        line: Line to append (newline will be added automatically)

    Returns:
        True if successful, False otherwise
    """
    try:
        with file_lock(file_path, "a") as f:
            # Ensure line ends with newline
            if not line.endswith("\n"):
                line += "\n"
            f.write(line)
        return True
    except Exception as e:
        logger.error(f"Error appending to {file_path}: {e}")
        return False


def safe_read_file(file_path: str) -> str | None:
    """
    Safely read a file with a shared lock where the platform supports one.

    A failed read is never reported as empty content: an unreadable file raises,
    a missing file returns None, and "" means the file really is empty.

    Args:
        file_path: Path to the file

    Returns:
        File contents, or None if the file does not exist

    Raises:
        OSError: If the file exists but cannot be read
    """
    if not os.path.exists(file_path):
        return None

    with file_lock(file_path, "r") as f:
        return f.read()
