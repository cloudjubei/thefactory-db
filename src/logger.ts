import { LogLevel, Logger } from './types.js'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

/**
 * Creates a new logger instance with the specified log level.
 * Messages with a severity lower than the configured level will be ignored.
 * @param level - The minimum log level to output messages for. Defaults to 'info'.
 * @returns A logger instance.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const logLevel = LOG_LEVELS[level]

  const log = (messageLevel: LogLevel, ...args: unknown[]) => {
    if (logLevel <= LOG_LEVELS[messageLevel]) {
      switch (messageLevel) {
        case 'debug':
          console.debug(...args)
          break
        case 'info':
          console.info(...args)
          break
        case 'warn':
          console.warn(...args)
          break
        case 'error':
          console.error(...args)
          break
      }
    }
  }

  return {
    debug: (...args: unknown[]) => log('debug', ...args),
    info: (...args: unknown[]) => log('info', ...args),
    warn: (...args: unknown[]) => log('warn', ...args),
    error: (...args: unknown[]) => log('error', ...args),
  }
}
