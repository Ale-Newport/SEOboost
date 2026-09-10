/**
 * Minimal structured logger. Emits one JSON object per line in production,
 * human-readable lines in development. Redacts anything that looks like a secret.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|apikey|api_key|authorization|credential|cookie|refresh_token|access_token|clientsecret|client_secret|encryptionkey)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…[truncated]`;
  return value;
}

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function write(level: LogLevel, scope: string, bindings: Record<string, unknown>, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;
  const payload = {
    level,
    time: new Date().toISOString(),
    scope,
    msg,
    ...(redact(bindings) as Record<string, unknown>),
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  };
  const line =
    process.env.NODE_ENV === 'production'
      ? JSON.stringify(payload)
      : `${payload.time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${
          meta ? ` ${JSON.stringify(redact(meta))}` : ''
        }`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string, bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, meta) => write('debug', scope, bindings, m, meta),
    info: (m, meta) => write('info', scope, bindings, m, meta),
    warn: (m, meta) => write('warn', scope, bindings, m, meta),
    error: (m, meta) => write('error', scope, bindings, m, meta),
    child: (extra) => createLogger(scope, { ...bindings, ...extra }),
  };
}

export const logger = createLogger('app');
