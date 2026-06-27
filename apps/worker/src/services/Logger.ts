/**
 * Structured logger — Phase 7 Observability
 *
 * In production (NODE_ENV=production or LOG_FORMAT=json) emits one JSON object
 * per line so Railway / Datadog / CloudWatch can parse and index fields.
 *
 * In development emits coloured, human-readable lines.
 *
 * Usage:
 *   const log = createLogger('Scheduler');
 *   log.info('Reconciliation complete', { restored: 42, skipped: 3, durationMs: 120 });
 *   log.warn('Slow loop iteration', { iterationMs: 450 });
 *   log.error('Redis unavailable', { err: e.message });
 *
 * Fields always present in JSON output:
 *   ts        — ISO timestamp
 *   level     — info | warn | error | debug
 *   service   — label passed to createLogger()
 *   msg       — human-readable message
 *   ...ctx    — all extra fields spread at the top level
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  service: string;
  msg: string;
  [key: string]: unknown;
}

export type LogSink = (entry: LogEntry) => void;


const COLOURS: Record<LogLevel, string> = {
  debug: '\x1b[36m',   // cyan
  info:  '\x1b[32m',   // green
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
};
const RESET = '\x1b[0m';

function prettyLine(entry: LogEntry): string {
  const colour = COLOURS[entry.level];
  const label  = `[${entry.service}]`;
  const level  = entry.level.toUpperCase().padEnd(5);
  const { ts, level: _l, service: _s, msg, ...ctx } = entry;
  const ctxStr = Object.keys(ctx).length
    ? ' ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : '';
  return `${colour}${level}${RESET} ${entry.ts.slice(11, 23)} ${label} ${msg}${ctxStr}`;
}


const isJson = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';

const defaultSink: LogSink = isJson
  ? (e) => console.log(JSON.stringify(e))
  : (e) => console.log(prettyLine(e));

export class Logger {
  readonly service: string;
  private sink: LogSink;
  private minLevel: LogLevel;

  constructor(service: string, sink: LogSink = defaultSink, minLevel: LogLevel = MIN_LEVEL) {
    this.service  = service;
    this.sink     = sink;
    this.minLevel = minLevel;
  }

  private emit(level: LogLevel, msg: string, ctx: Record<string, unknown> = {}) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    this.sink({
      ts:      new Date().toISOString(),
      level,
      service: this.service,
      msg,
      ...ctx,
    });
  }

  debug(msg: string, ctx?: Record<string, unknown>) { this.emit('debug', msg, ctx); }
  info (msg: string, ctx?: Record<string, unknown>) { this.emit('info',  msg, ctx); }
  warn (msg: string, ctx?: Record<string, unknown>) { this.emit('warn',  msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>) { this.emit('error', msg, ctx); }

  /** Return a child logger that merges fixed context into every entry. */
  child(extraCtx: Record<string, unknown>): Logger {
    return new Logger(
      this.service,
      (entry) => this.sink({ ...extraCtx, ...entry }),
      this.minLevel,
    );
  }
}

/** Factory — preferred public API. */
export function createLogger(service: string, sink?: LogSink, minLevel?: LogLevel): Logger {
  return new Logger(service, sink, minLevel);
}
