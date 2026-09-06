/**
 * Ortam degiskeni yapilandirmasi.
 * Eksik/hatali ayarla ACILMAK YERINE acilista patlar: yanlis veritabanina baglanan
 * veya kimlik dogrulamasi kapali bir servis, acilmayan servisten daha tehlikelidir.
 */
export interface ServerConfig {
  readonly nodeEnv: 'production' | 'development' | 'test';
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly poolMax: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly trustProxy: boolean;
  readonly maxBodyBytes: number;
  readonly rateLimit: { readonly windowMs: number; readonly max: number };
  readonly syncBatchMax: number;
  readonly sessionTtlHours: number;
  readonly deviceTokenTtlDays: number | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Zorunlu ortam degiskeni eksik: ${name}`);
  }
  return value.trim();
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} sayi olmali`);
  return value;
}

export function loadConfig(): ServerConfig {
  const nodeEnv = (process.env.NODE_ENV ?? 'production') as ServerConfig['nodeEnv'];
  return {
    nodeEnv,
    host: process.env.HOST ?? '127.0.0.1',
    port: optionalInt('PORT', 8110),
    databaseUrl: required('DATABASE_URL'),
    poolMax: optionalInt('DB_POOL_MAX', 10),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as ServerConfig['logLevel'],
    trustProxy: (process.env.TRUST_PROXY ?? 'true') === 'true',
    maxBodyBytes: optionalInt('MAX_BODY_BYTES', 2 * 1024 * 1024),
    rateLimit: {
      windowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 60_000),
      max: optionalInt('RATE_LIMIT_MAX', 300),
    },
    syncBatchMax: optionalInt('SYNC_BATCH_MAX', 200),
    sessionTtlHours: optionalInt('SESSION_TTL_HOURS', 12),
    deviceTokenTtlDays: process.env.DEVICE_TOKEN_TTL_DAYS
      ? optionalInt('DEVICE_TOKEN_TTL_DAYS', 0)
      : null,
  };
}
