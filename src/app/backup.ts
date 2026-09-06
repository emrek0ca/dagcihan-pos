/**
 * Veritabani yedekleme.
 *
 * WAL modunda ham dosya kopyasi tutarsiz olabilir; once checkpoint alinir,
 * sonra kopyalanir. Hem CLI hem masaustu uygulamasi bu modulu kullanir.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../data/db.ts';

export interface BackupResult {
  readonly file: string;
  readonly bytes: number;
  readonly at: number;
}

export function backupDatabase(
  db: Db,
  options: { backupDir: string; prefix?: string },
): BackupResult {
  mkdirSync(options.backupDir, { recursive: true });
  // WAL icerigini ana dosyaya al -> kopya tutarli bir anlik goruntu olur
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(options.backupDir, `${options.prefix ?? 'yedek'}-${stamp}.db`);
  copyFileSync(db.path, file);
  return { file, bytes: statSync(file).size, at: Date.now() };
}

/** Eski yedekleri siler; en yeni `keep` tanesi korunur. */
export function pruneBackups(backupDir: string, keep = 30): number {
  let files: string[];
  try {
    files = readdirSync(backupDir).filter((f) => f.endsWith('.db'));
  } catch {
    return 0;
  }
  // Arsiv (db reset) yedekleri asla silinmez
  const rotatable = files
    .filter((f) => !f.startsWith('arsiv-'))
    .map((f) => ({ f, at: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  let removed = 0;
  for (const entry of rotatable.slice(keep)) {
    try {
      rmSync(join(backupDir, entry.f), { force: true });
      removed++;
    } catch {
      /* silinemezse birak */
    }
  }
  return removed;
}

/**
 * Zamanlanmis yedekleme. Uygulama acikken periyodik, kapanirken bir kez calisir.
 * Yedek hatasi POS'u durdurmaz - loglanir ve devam edilir.
 */
export class BackupScheduler {
  readonly #db: Db;
  readonly #backupDir: string;
  readonly #intervalMs: number;
  readonly #onEvent: (message: string, error?: unknown) => void;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: {
    db: Db;
    backupDir: string;
    intervalMinutes: number;
    onEvent?: (message: string, error?: unknown) => void;
  }) {
    this.#db = options.db;
    this.#backupDir = options.backupDir;
    this.#intervalMs = Math.max(1, options.intervalMinutes) * 60_000;
    this.#onEvent = options.onEvent ?? (() => {});
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.runOnce('otomatik'), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  runOnce(reason: string): BackupResult | null {
    try {
      const result = backupDatabase(this.#db, { backupDir: this.#backupDir });
      const removed = pruneBackups(this.#backupDir);
      this.#onEvent(
        `Yedek alindi (${reason}): ${result.file} (${Math.round(result.bytes / 1024)} KB)` +
        (removed > 0 ? `, ${removed} eski yedek silindi` : ''),
      );
      return result;
    } catch (error) {
      this.#onEvent(`Yedekleme basarisiz (${reason})`, error);
      return null;
    }
  }
}
