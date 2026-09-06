/**
 * Idempotency: ayni anahtarla gelen ikinci istek YENI kayit olusturmaz,
 * ilk istegin sonucunu doner.
 *
 * "Tamamla"ya iki kez basilmasi, ag/UI yeniden denemesi, kilitlenip yeniden
 * baslatma - hepsi tek satisla sonuclanir.
 */
import type { Db } from './db.ts';
import type { Clock } from '../core/clock.ts';
import { PosError } from '../core/errors.ts';
import { hashRequest } from '../core/ids.ts';

export interface IdempotentOutcome<T> {
  readonly result: T;
  /** true ise sonuc onceki calistirmadan geldi, is yeniden yapilmadi */
  readonly replayed: boolean;
}

interface KeyRow {
  key: string;
  scope: string;
  request_hash: string;
  status: 'IN_PROGRESS' | 'DONE';
  response_json: string | null;
}

export class IdempotencyStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /**
   * fn TEK transaction icinde calisir; anahtar kaydi ve isin kendisi ayni
   * atomik birimdedir. fn hata atarsa anahtar da geri alinir (yeniden denenebilir).
   */
  run<T>(key: string, scope: string, request: unknown, fn: () => T): IdempotentOutcome<T> {
    const requestHash = hashRequest(request);

    const existing = this.#db.get<KeyRow>('SELECT * FROM idempotency_keys WHERE key = ?', key);
    if (existing !== undefined) {
      if (existing.scope !== scope || existing.request_hash !== requestHash) {
        throw new PosError('IDEMPOTENCY_KEY_REUSE',
          `Ayni idempotency anahtari farkli istekle kullanildi: ${key}`, {
            details: { key, scope, existingScope: existing.scope },
          });
      }
      if (existing.status === 'DONE' && existing.response_json !== null) {
        return { result: JSON.parse(existing.response_json) as T, replayed: true };
      }
      // IN_PROGRESS kaydi: onceki deneme cokme ile yarim kalmis demektir.
      // Transaction atomik oldugu icin isin kendisi YAPILMAMISTIR; temizle ve yeniden dene.
      this.#db.run('DELETE FROM idempotency_keys WHERE key = ?', key);
    }

    return this.#db.tx(() => {
      const now = this.#clock.now();
      this.#db.run(
        `INSERT INTO idempotency_keys (key, scope, request_hash, status, created_at)
         VALUES (?, ?, ?, 'IN_PROGRESS', ?)`,
        key, scope, requestHash, now,
      );
      const result = fn();
      this.#db.run(
        `UPDATE idempotency_keys SET status = 'DONE', response_json = ?, completed_at = ?
          WHERE key = ?`,
        JSON.stringify(result ?? null), this.#clock.now(), key,
      );
      return { result, replayed: false };
    });
  }

  /** Eski anahtarlari temizler (varsayilan 30 gun) */
  prune(olderThanMs = 30 * 24 * 60 * 60 * 1000): number {
    return this.#db.run(
      'DELETE FROM idempotency_keys WHERE created_at < ?',
      this.#clock.now() - olderThanMs,
    ).changes;
  }
}
