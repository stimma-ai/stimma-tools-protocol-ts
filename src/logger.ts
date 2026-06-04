/**
 * Minimal stderr logger (no external dependencies).
 *
 * All output goes to stderr because stdout is reserved for JSON-RPC in stdio mode.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARNING]: "WARNING",
  [LogLevel.ERROR]: "ERROR",
};

let globalLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

export function parseLogLevel(s: string): LogLevel {
  switch (s.toUpperCase()) {
    case "DEBUG":
      return LogLevel.DEBUG;
    case "INFO":
      return LogLevel.INFO;
    case "WARNING":
      return LogLevel.WARNING;
    case "ERROR":
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class Logger {
  constructor(public readonly name: string) {}

  private _log(level: LogLevel, message: string): void {
    if (level < globalLevel) return;
    const ts = formatTimestamp();
    const lvl = LEVEL_NAMES[level];
    process.stderr.write(`${ts} [${lvl}] ${this.name}: ${message}\n`);
  }

  debug(message: string): void {
    this._log(LogLevel.DEBUG, message);
  }

  info(message: string): void {
    this._log(LogLevel.INFO, message);
  }

  warning(message: string): void {
    this._log(LogLevel.WARNING, message);
  }

  error(message: string): void {
    this._log(LogLevel.ERROR, message);
  }
}

export function getLogger(name: string): Logger {
  return new Logger(name);
}
