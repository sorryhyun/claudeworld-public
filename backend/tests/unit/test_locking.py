"""
Unit tests for infrastructure.locking (P0-2).

The Windows-specific failure modes are simulated by forcing the module's
platform flags, since CI runs on POSIX.
"""

import os
import threading
from unittest.mock import patch

import pytest
from infrastructure import locking
from infrastructure.locking import file_lock, safe_append_line, safe_read_file


@pytest.fixture
def tmp_file(tmp_path):
    path = tmp_path / "config.md"
    path.write_text("original content\n", encoding="utf-8")
    return str(path)


class TestPlatformFlags:
    @pytest.mark.unit
    def test_has_msvcrt_is_always_defined(self):
        """It used to be bound only in the ImportError branch — a latent NameError."""
        assert isinstance(locking.HAS_MSVCRT, bool)
        assert isinstance(locking.HAS_FCNTL, bool)


class TestSafeReadFile:
    @pytest.mark.unit
    def test_reads_real_content(self, tmp_file):
        assert safe_read_file(tmp_file) == "original content\n"

    @pytest.mark.unit
    def test_missing_file_is_distinguishable_from_empty_file(self, tmp_path):
        missing = str(tmp_path / "nope.md")
        empty = tmp_path / "empty.md"
        empty.write_text("", encoding="utf-8")

        assert safe_read_file(missing) is None
        assert safe_read_file(str(empty)) == ""

    @pytest.mark.unit
    def test_unreadable_file_raises_instead_of_returning_empty(self, tmp_path):
        """Returning "" for a failed read is indistinguishable from an empty file."""
        path = tmp_path / "locked.md"
        path.write_text("secret\n", encoding="utf-8")
        os.chmod(path, 0o000)
        try:
            if os.access(path, os.R_OK):
                pytest.skip("running as a user that bypasses file permissions")
            with pytest.raises(OSError):
                safe_read_file(str(path))
        finally:
            os.chmod(path, 0o644)

    @pytest.mark.unit
    def test_windows_read_does_not_attempt_a_lock(self, tmp_file):
        """msvcrt.locking needs a writable handle; on a read handle it raises."""
        exploding_msvcrt = _ExplodingMsvcrt()
        with patch.object(locking, "HAS_FCNTL", False), patch.object(locking, "HAS_MSVCRT", True), patch.object(
            locking, "msvcrt", exploding_msvcrt
        ):
            assert safe_read_file(tmp_file) == "original content\n"
        assert exploding_msvcrt.lock_calls == 0


class TestFileLockWriteMode:
    @pytest.mark.unit
    def test_write_mode_does_not_truncate_before_the_block_completes(self, tmp_file):
        """open(path, "w") used to destroy the file before any lock was taken."""
        with file_lock(tmp_file, "w") as f:
            f.write("new content\n")
            # The target still holds the old content mid-write
            with open(tmp_file, encoding="utf-8") as reader:
                assert reader.read() == "original content\n"

        assert safe_read_file(tmp_file) == "new content\n"

    @pytest.mark.unit
    def test_failed_write_leaves_the_original_intact(self, tmp_path):
        path = str(tmp_path / "config.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("original content\n")

        with pytest.raises(ValueError):
            with file_lock(path, "w") as f:
                f.write("half a file")
                raise ValueError("boom")

        assert safe_read_file(path) == "original content\n"
        # And no temp file was left behind
        assert [p.name for p in tmp_path.iterdir()] == ["config.md"]

    @pytest.mark.unit
    def test_temp_file_does_not_match_config_globs(self, tmp_path):
        """Directories here are scanned with globs like *.md / *.yaml."""
        path = str(tmp_path / "config.md")
        with file_lock(path, "w") as f:
            during = [p.name for p in tmp_path.iterdir()]
            f.write("x")

        assert not [name for name in during if name.endswith(".md")]

    @pytest.mark.unit
    def test_write_preserves_existing_permissions(self, tmp_path):
        path = tmp_path / "config.md"
        path.write_text("original\n", encoding="utf-8")
        os.chmod(path, 0o644)

        with file_lock(str(path), "w") as f:
            f.write("new\n")

        assert os.stat(path).st_mode & 0o777 == 0o644


class TestConcurrentAppends:
    @pytest.mark.unit
    def test_concurrent_appenders_all_land(self, tmp_path):
        path = str(tmp_path / "recent_events.md")
        writers = 20

        barrier = threading.Barrier(writers)

        def append(i):
            barrier.wait()
            safe_append_line(path, f"line-{i}")

        threads = [threading.Thread(target=append, args=(i,)) for i in range(writers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        lines = [line for line in safe_read_file(path).splitlines() if line]
        assert sorted(lines) == sorted(f"line-{i}" for i in range(writers))

    @pytest.mark.unit
    def test_windows_append_locks_a_shared_byte_range(self, tmp_path):
        """msvcrt locks N bytes from the current position; in "a" mode that is
        EOF, so two appenders would lock different ranges and neither would
        block. Every locker must target byte 0."""
        path = str(tmp_path / "recent_events.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("x" * 100)

        recorder = _RecordingMsvcrt()
        with patch.object(locking, "HAS_FCNTL", False), patch.object(locking, "HAS_MSVCRT", True), patch.object(
            locking, "msvcrt", recorder
        ):
            assert safe_append_line(path, "appended")

        assert recorder.lock_positions == [0]
        assert recorder.unlock_positions == [0]
        assert safe_read_file(path).endswith("appended\n")


class _ExplodingMsvcrt:
    """Stands in for msvcrt, failing the way it does on a read-only handle."""

    LK_LOCK = 1
    LK_UNLCK = 0

    def __init__(self):
        self.lock_calls = 0

    def locking(self, _fd, mode, _nbytes):
        self.lock_calls += 1
        raise OSError(13, "Permission denied")


class _RecordingMsvcrt:
    """Stands in for msvcrt, recording the file position of each lock call."""

    LK_LOCK = 1
    LK_UNLCK = 0

    def __init__(self):
        self.lock_positions: list[int] = []
        self.unlock_positions: list[int] = []

    def locking(self, fd, mode, _nbytes):
        position = os.lseek(fd, 0, os.SEEK_CUR)
        if mode == self.LK_LOCK:
            self.lock_positions.append(position)
        else:
            self.unlock_positions.append(position)
