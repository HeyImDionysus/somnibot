/**
 * Structured logger — replaces raw console.* calls.
 *
 * In production: JSON-formatted output (one line per entry) for log aggregators.
 * In development: Human-readable colored output for local debugging.
 *
 * Usage:
 *   import { createLogger } from '@somnibot/shared';
 *   const log = createLogger('ModLog');
 *   log.info('Case opened', { caseId: 42, userId: '123' });
 *
 * Output (production):
 *   {"level":"info","service":"ModLog","msg":"Case opened","caseId":42,"userId":"123","ts":"2026-06-02T..."}
 *
 * Output (development):
 *   [ModLog] Case opened { caseId: 42, userId: '123' }
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const isProduction = process.env.NODE_ENV === 'production';
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? (isProduction ? 'info' : 'debug');

/** Accepted log data — objects are spread, primitives/errors are wrapped automatically. */
export type LogData = Record<string, unknown> | unknown;

export interface Logger {
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
  /** Create a child logger with extra default fields */
  child(fields: Record<string, unknown>): Logger;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

/** Normalize any log data into a plain object. */
function normalizeData(data: LogData | undefined): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  if (data instanceof Error) return { error: data.message, stack: data.stack };
  if (typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  if (Array.isArray(data)) return { items: data };
  return { value: data };
}

function formatJson(level: LogLevel, service: string, msg: string, data?: Record<string, unknown>, fields?: Record<string, unknown>): string {
  return JSON.stringify({
    level,
    service,
    msg,
    ...fields,
    ...data,
    ts: new Date().toISOString(),
  });
}

function formatDev(level: LogLevel, service: string, msg: string, data?: Record<string, unknown>): string {
  const prefix = `[${service}]`;
  const dataStr = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  return `${prefix} ${msg}${dataStr}`;
}

function createLoggerInternal(service: string, parentFields?: Record<string, unknown>): Logger {
  const write = (level: LogLevel, msg: string, rawData?: LogData) => {
    const data = normalizeData(rawData);
    if (!shouldLog(level)) return;
    const output = isProduction
      ? formatJson(level, service, msg, data, parentFields)
      : formatDev(level, service, msg, data);

    switch (level) {
      case 'error': console.error(output); break;
      case 'warn':  console.warn(output);  break;
      default:      console.log(output);   break;
    }
  };

  return {
    debug: (msg, data) => write('debug', msg, data),
    info:  (msg, data) => write('info', msg, data),
    warn:  (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
    child: (fields) => createLoggerInternal(service, { ...parentFields, ...fields }),
  };
}

/**
 * Create a structured logger for a service/module.
 *
 * @param service - Module name shown in log output (e.g., 'AutomationEngine', 'EventBus')
 */
export function createLogger(service: string): Logger {
  return createLoggerInternal(service);
}
