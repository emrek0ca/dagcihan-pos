/**
 * SQLite erisim katmani (node:sqlite - yerlesik, native bagimlilik yok).
 *
 * Dayaniklilik ayarlari POS icin bilincli olarak "guvenlik > hiz" tarafindadir:
 *  journal_mode=WAL      -> okuma/yazma cakismaz, cokme sonrasi kurtarilabilir
 *  synchronous=FULL      -> COMMIT donerse veri diskte demektir (elektrik kesintisi guvenli)
 *  foreign_keys=ON       -> iliskisel butunluk
 *  busy_timeout=5000     -> kisa kilit cakismalarinda bekle, hata verme
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface DbOptions {
  readonly path: string;
  /** Test icin: :memory: kullaniminda WAL kapatilir */
  readonly readOnly?: boolean;
}

export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  #statements = new Map<string, StatementSync>();
  #txDepth = 0;
  #savepointCounter = 0;
  #closed = false;

  constructor(options: DbOptions) {
    this.path = options.path;
    if (options.path !== ':memory:') {
      const dir = dirname(options.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.raw = new DatabaseSync(options.path, { readOnly: options.readOnly ?? false });
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (options.path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = FULL');
    }
  }

  /** Hazir ifade onbellegi - sicak yolda (barkod aramasi) yeniden derleme yok */
  stmt(sql: string): StatementSync {
    let s = this.#statements.get(sql);
    if (s === undefined) {
      s = this.raw.prepare(sql);
      this.#statements.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get inTransaction(): boolean {
    return this.#txDepth > 0;
  }

  /**
   * Is birimi. En distaki cagri BEGIN IMMEDIATE ile yazma kilidini hemen alir
   * (satis tamamlama gibi kritik yollarda "database is locked" riskini basta cozer).
   * Ic ice cagrilar SAVEPOINT kullanir.
   */
  tx<T>(fn: () => T): T {
    if (this.#txDepth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.#txDepth = 1;
      try {
        const result = fn();
        this.raw.exec('COMMIT');
        this.#txDepth = 0;
        return result;
      } catch (error) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* rollback basarisizsa orijinal hatayi kaybetme */
        }
        this.#txDepth = 0;
        throw error;
      }
    }
    const name = `sp_${++this.#savepointCounter}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.#txDepth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      this.#txDepth--;
      return result;
    } catch (error) {
      try {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
      } catch {
        /* yut */
      }
      this.#txDepth--;
      throw error;
    }
  }

  /** Atomik sayac - fis numarasi gibi bosluksuz seriler icin (transaction icinde cagrilir) */
  nextSequence(name: string): number {
    this.run(
      'INSERT INTO sequences(name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING',
      name,
    );
    this.run('UPDATE sequences SET value = value + 1 WHERE name = ?', name);
    const row = this.get<{ value: number }>('SELECT value FROM sequences WHERE name = ?', name);
    if (row === undefined) throw new Error(`Sequence okunamadi: ${name}`);
    return row.value;
  }

  integrityCheck(): { ok: boolean; problems: string[] } {
    const rows = this.all<{ quick_check: string }>('PRAGMA quick_check');
    const problems = rows.map((r) => r.quick_check).filter((v) => v !== 'ok');
    const fk = this.all<Row>('PRAGMA foreign_key_check');
    for (const r of fk) problems.push(`FK ihlali: ${JSON.stringify(r)}`);
    return { ok: problems.length === 0, problems };
  }

  /** Tekrar cagrilabilir: kapanis yollari birden fazla yerden tetiklenebilir */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    try {
      if (this.path !== ':memory:') this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* kapanista hata yut */
    }
    try {
      this.raw.close();
    } catch {
      /* zaten kapali */
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}

// --------------------------------- Migration ---------------------------------

export interface MigrationResult {
  readonly applied: string[];
  readonly versionBefore: number;
  readonly versionAfter: number;
}

export function migrate(db: Db, migrationsDir: string = MIGRATIONS_DIR): MigrationResult {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const before = Number(
    (db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0,
  );
  const applied: string[] = [];

  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`Gecersiz migration adi (NNN- ile baslamali): ${file}`);
    }
    if (version <= before) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    // Migration + user_version tek transaction: yarim uygulanmis sema olusmaz
    db.raw.exec('BEGIN IMMEDIATE');
    try {
      db.raw.exec(sql);
      db.raw.exec(`PRAGMA user_version = ${version}`);
      db.raw.exec('COMMIT');
    } catch (error) {
      db.raw.exec('ROLLBACK');
      throw new Error(`Migration basarisiz: ${file}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    applied.push(file);
  }

  const after = Number((db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0);
  return { applied, versionBefore: before, versionAfter: after };
}

export function openDatabase(path: string): Db {
  const db = new Db({ path });
  migrate(db);
  return db;
}
