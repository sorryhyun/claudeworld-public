/**
 * Named, leveled application logging.
 *
 * Ported from `backend/core/logging.py`. Python gets named loggers, a global
 * level and a fixed line format from the stdlib; none of that exists in Bun, so
 * it is reproduced here — deliberately small, because the only properties any
 * caller depends on are the name prefix and the level gate.
 *
 * The line format is copied verbatim from `setup_logging()`:
 *
 *     2026-08-21 14:03:11 | INFO     | AppFactory | 🚀 Application startup...
 *
 * so `make dev` output reads the same whichever backend produced it.
 */

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
}

/** Python pads `%(levelname)-8s`; the widest name is "CRITICAL". */
const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG   ',
  info: 'INFO    ',
  warning: 'WARNING ',
  error: 'ERROR   ',
}

/**
 * Start at INFO rather than WARNING.
 *
 * `setup_logging()` is called from the entrypoint before anything else logs, so
 * Python's own default never shows. Here module-level code can log during
 * import — before {@link setupLogging} runs — and those lines are exactly the
 * startup diagnostics worth seeing.
 */
let currentLevel: LogLevel = 'info'

/** Sink indirection so tests can capture lines without touching stdout. */
export type LogSink = (line: string, level: LogLevel) => void

let sink: LogSink = (line, level) => {
  if (level === 'error') console.error(line)
  else if (level === 'warning') console.warn(line)
  else console.log(line)
}

/** `%Y-%m-%d %H:%M:%S` in local time, matching Python's `datefmt`. */
function formatTimestamp(now: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

export interface Logger {
  readonly name: string
  debug(message: string): void
  info(message: string): void
  warning(message: string): void
  /** Alias for {@link Logger.warning}; `console`-shaped call sites read better. */
  warn(message: string): void
  error(message: string): void
  /** Log at ERROR with an exception's message and stack appended. */
  exception(message: string, error: unknown): void
}

function emit(name: string, level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  sink(`${formatTimestamp(new Date())} | ${LEVEL_LABEL[level]} | ${name} | ${message}`, level)
}

const loggers = new Map<string, Logger>()

/**
 * Get (or create) the logger with this name.
 *
 * Cached per name like `logging.getLogger`, so `getLogger('Auth')` from two
 * modules is one object and the identity is stable across hot reloads.
 */
export function getLogger(name: string): Logger {
  const existing = loggers.get(name)
  if (existing) return existing

  const logger: Logger = {
    name,
    debug: (message) => emit(name, 'debug', message),
    info: (message) => emit(name, 'info', message),
    warning: (message) => emit(name, 'warning', message),
    warn: (message) => emit(name, 'warning', message),
    error: (message) => emit(name, 'error', message),
    exception: (message, error) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      emit(name, 'error', `${message}\n${detail}`)
    },
  }

  loggers.set(name, logger)
  return logger
}

export interface SetupLoggingOptions {
  /** `DEBUG_AGENTS`: INFO when true, WARNING when false. */
  debugMode?: boolean
  /** Explicit level, overriding `debugMode`. */
  level?: LogLevel
}

/**
 * Configure application-wide logging. Call once at startup.
 *
 * Python's `SuppressPollingLogsFilter` has no counterpart because there is no
 * uvicorn access log to filter: Hono does not log requests unless middleware
 * says to, so the polling endpoints are quiet by construction.
 */
export function setupLogging({ debugMode = false, level }: SetupLoggingOptions = {}): void {
  currentLevel = level ?? (debugMode ? 'info' : 'warning')
  getLogger('Logging').info(`Logging configured with level: ${currentLevel.toUpperCase()}`)
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

/** Replace the output sink. Returns a function that restores the previous one. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink
  sink = next
  return () => {
    sink = previous
  }
}
