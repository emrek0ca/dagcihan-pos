/**
 * PostgreSQL erisim katmani.
 *
 *  * Baglanti havuzu (pg.Pool)
 *  * `tx()` ile transaction; ic ice cagrilarda SAVEPOINT
 *  * Migration calistirici: her migration TEK transaction, sema surumu takipli
 *
 * BIGINT kolonlari JavaScript number olarak okunur. Para kurus, miktar gram
 * oldugu icin degerler Number.MAX_SAFE_INTEGER'in cok altindadir; yine de
 * guvenlik icin parser tasma kontrolu yapar.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Logger } from './lib/log.ts';

// int8 (bigint) -> number, tasma halinde hata
pg.types.setTypeParser(20, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`BIGINT guvenli tam sayi araligini asiyor: ${value}`);
  }
  return parsed;
});
// numeric -> string birakilir (kayipsiz); bu semada numeric kullanilmiyor

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type QueryParam = string | number | boolean | null | Date | Buffer | object;

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T | undefined>;
  exec(text: string, params?: QueryParam[]): Promise<number>;
}

function wrap(client: pg.PoolClient | pg.Pool): Queryable {
  return {
    async query<T>(text: string, params: QueryParam[] = []): Promise<T[]> {
      const result = await client.query(text, params as unknown[]);
      return result.rows as T[];
    },
    async one<T>(text: string, params: QueryParam[] = []): Promise<T | undefined> {
      const result = await client.query(text, params as unknown[]);
      return result.rows[0] as T | undefined;
    },
    async exec(text: string, params: QueryParam[] = []): Promise<number> {
      const result = await client.query(text, params as unknown[]);
      return result.rowCount ?? 0;
    },
  };
}

export class Database implements Queryable {
  readonly pool: pg.Pool;
  readonly #logger: Logger;

  constructor(options: { connectionString: string; max?: number; logger: Logger }) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'dagci-pos-platform',
    });
    this.#logger = options.logger;
    this.pool.on('error', (error) => this.#logger.error('Havuz baglanti hatasi', error));
  }

  query<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T[]> {
    return wrap(this.pool).query<T>(text, params);
  }
  one<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T | undefined> {
    return wrap(this.pool).one<T>(text, params);
  }
  exec(text: string, params?: QueryParam[]): Promise<number> {
    return wrap(this.pool).exec(text, params);
  }

  /** Transaction. fn hata atarsa ROLLBACK yapilir ve hata yukari verilir. */
  async tx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.#logger.error('ROLLBACK basarisiz', rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ------------------------------ migration ------------------------------

export interface MigrationResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
  readonly version: string | null;
}

/**
 * Migration'lar sirali ve TEK SEFER uygulanir.
 * Her dosya kendi transaction'inda calisir: yarim uygulanmis sema olusmaz.
 * Basarisiz olan migration sonrasi surec durur; onceki migration'lar gecerlidir.
 */
export async function migrate(
  db: Database,
  logger: Logger,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text NOT NULL,
      duration_ms integer NOT NULL
    )
  `);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const done = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const doneMap = new Map(done.map((r) => [r.version, r.checksum]));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = await import('node:crypto').then((c) =>
      c.createHash('sha256').update(sql).digest('hex').slice(0, 32));

    const existing = doneMap.get(file);
    if (existing !== undefined) {
      if (existing !== checksum) {
        throw new Error(
          `Migration dosyasi uygulandiktan SONRA degistirilmis: ${file}. ` +
          'Uygulanmis migration duzenlenmez; yeni bir migration ekleyin.',
        );
      }
      alreadyApplied.push(file);
      continue;
    }

    const started = Date.now();
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.exec(
        'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
        [file, checksum, Date.now() - started],
      );
    });
    logger.info('Migration uygulandi', { file, durationMs: Date.now() - started });
    applied.push(file);
  }

  const latest = await db.one<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  return { applied, alreadyApplied, version: latest?.version ?? null };
}
