/**
 * Yapisal (JSON) gunluk.
 * Gizli bilgi loglanmaz: token, sifre, kart bilgisi alanlari maskelenir.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = [
  'token', 'password', 'pin', 'secret', 'authorization', 'apikey', 'api_key',
  'token_hash', 'password_hash', 'card', 'pan', 'cvv', 'enrollment_code',
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.some((s) => key.toLowerCase().includes(s))
      ? '[gizlendi]'
      : redact(item, depth + 1);
  }
  return out;
}

export class Logger {
  #level: number;
  readonly #base: Record<string, unknown>;

  constructor(level: LogLevel = 'info', base: Record<string, unknown> = {}) {
    this.#level = LEVELS[level];
    this.#base = base;
  }

  child(fields: Record<string, unknown>): Logger {
    const logger = new Logger('info', { ...this.#base, ...fields });
    logger.#level = this.#level;
    return logger;
  }

  #write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.#level) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...this.#base,
      ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
    };
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  }

  debug(message: string, fields?: Record<string, unknown>): void { this.#write('debug', message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.#write('info', message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.#write('warn', message, fields); }

  error(message: string, error?: unknown, fields?: Record<string, unknown>): void {
    this.#write('error', message, {
      ...fields,
      ...(error instanceof Error
        ? { error: error.message, stack: error.stack?.split('\n').slice(0, 6).join('\n') }
        : error !== undefined ? { error: String(error) } : {}),
    });
  }
}
