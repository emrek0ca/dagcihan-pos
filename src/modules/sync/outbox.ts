/**
 * Transactional outbox.
 *
 * Olay, isi yapan transaction'in ICINDE kaydedilir. Bu yuzden:
 *   - Satis commit olduysa olay da kesinlikle kuyruktadir.
 *   - Satis geri alindiysa olay da yoktur.
 * "Satis kaydedildi ama sunucuya gidecek olay kayboldu" durumu olusamaz.
 *
 * Kuyruk ISLEME sunucuya baglidir; kuyruga YAZMA degildir. Internet yoksa
 * satis normal tamamlanir, olay bekler.
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import { newUid } from '../../core/ids.ts';

export type OutboxEventType =
  | 'sale.completed' | 'sale.refunded' | 'sale.voided'
  | 'inventory.adjusted'
  | 'cash_session.opened' | 'cash_session.closed' | 'cash.movement'
  | 'product.price_changed' | 'cashier.upserted';

export interface OutboxRecordInput {
  readonly type: OutboxEventType;
  readonly entityType?: string;
  readonly entityId?: string | number;
  readonly payload: Record<string, unknown>;
}

/** Servislerin bagimli oldugu dar arayuz (senkronizasyon kapaliyken de calisir) */
export interface OutboxPort {
  record(input: OutboxRecordInput): void;
}

export interface PendingEvent {
  readonly id: number;
  readonly eventId: string;
  readonly type: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly sequence: number;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: number;
  readonly attempts: number;
}

/** Senkronizasyon kapaliyken kullanilan bos uygulama */
export const NULL_OUTBOX: OutboxPort = { record: () => undefined };

export class Outbox implements OutboxPort {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  record(input: OutboxRecordInput): void {
    const now = this.#clock.now();
    const sequence = this.#db.nextSequence('outbox');
    this.#db.run(
      `INSERT INTO outbox_events
         (event_id, type, entity_type, entity_id, sequence, payload_json,
          occurred_at, status, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?)`,
      newUid(), input.type, input.entityType ?? null,
      input.entityId === undefined ? null : String(input.entityId),
      sequence, JSON.stringify(input.payload), now, now,
    );
  }

  /** Gonderilmeye hazir olaylar (sira korunur: eski olay once gider) */
  pending(limit = 50, now = this.#clock.now()): PendingEvent[] {
    return this.#db
      .all<{
        id: number; event_id: string; type: string; entity_type: string | null;
        entity_id: string | null; sequence: number; payload_json: string;
        occurred_at: number; attempts: number;
      }>(
        `SELECT * FROM outbox_events
          WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= ?
          ORDER BY sequence LIMIT ?`,
        now, limit,
      )
      .map((r) => ({
        id: r.id,
        eventId: r.event_id,
        type: r.type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        sequence: r.sequence,
        payload: JSON.parse(r.payload_json) as Record<string, unknown>,
        occurredAt: r.occurred_at,
        attempts: r.attempts,
      }));
  }

  markSent(eventIds: readonly string[]): void {
    if (eventIds.length === 0) return;
    const now = this.#clock.now();
    this.#db.tx(() => {
      for (const id of eventIds) {
        this.#db.run(
          "UPDATE outbox_events SET status='SENT', sent_at=?, last_error=NULL WHERE event_id=?",
          now, id,
        );
      }
    });
  }

  /**
   * Basarisiz olayi yeniden denemeye planlar.
   * Ustel geri cekilme + jitter: sunucu geri geldiginde tum cihazlar ayni anda
   * yuklenmesin diye rastgele sapma eklenir.
   */
  markFailed(
    eventId: string,
    error: string,
    options: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number },
  ): void {
    const row = this.#db.get<{ attempts: number }>(
      'SELECT attempts FROM outbox_events WHERE event_id = ?', eventId,
    );
    const attempts = (row?.attempts ?? 0) + 1;
    const exponential = Math.min(
      options.maxDelayMs,
      options.baseDelayMs * 2 ** Math.min(attempts - 1, 16),
    );
    const jitter = Math.floor(Math.random() * Math.min(exponential, 30_000));
    const dead = attempts >= options.maxAttempts;

    this.#db.run(
      `UPDATE outbox_events
          SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
        WHERE event_id = ?`,
      dead ? 'DEAD' : 'FAILED', attempts,
      this.#clock.now() + exponential + jitter, error.slice(0, 500), eventId,
    );
  }

  counts(): { pending: number; failed: number; dead: number; sent: number } {
    const row = this.#db.get<{
      pending: number; failed: number; dead: number; sent: number;
    }>(
      `SELECT
         COALESCE(SUM(status='PENDING'), 0) AS pending,
         COALESCE(SUM(status='FAILED'), 0)  AS failed,
         COALESCE(SUM(status='DEAD'), 0)    AS dead,
         COALESCE(SUM(status='SENT'), 0)    AS sent
       FROM outbox_events`,
    );
    return row ?? { pending: 0, failed: 0, dead: 0, sent: 0 };
  }

  /**
   * Bekleyen tum basarisiz olaylari HEMEN yeniden denemeye alir.
   * Hem DEAD (deneme hakki bitmis) hem FAILED (geri cekilme suresi bekleyen)
   * olaylari kapsar: yonetici "simdi dene" dedigi zaman beklemesin.
   */
  retryFailed(): number {
    return this.#db.run(
      `UPDATE outbox_events SET status='PENDING', attempts=0, next_attempt_at=0
        WHERE status IN ('DEAD','FAILED')`,
    ).changes;
  }

  /** Gonderilmis eski olaylari temizler (varsayilan 30 gun) */
  prune(olderThanMs = 30 * 24 * 3600_000): number {
    return this.#db.run(
      "DELETE FROM outbox_events WHERE status='SENT' AND sent_at < ?",
      this.#clock.now() - olderThanMs,
    ).changes;
  }
}

// ------------------------------ durum anahtarlari ------------------------------

export class SyncStateStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  get(key: string): string | null {
    return this.#db.get<{ value: string }>(
      'SELECT value FROM sync_state WHERE key = ?', key,
    )?.value ?? null;
  }

  getNumber(key: string, fallback = 0): number {
    const raw = this.get(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  set(key: string, value: string | number): void {
    this.#db.run(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, String(value), this.#clock.now(),
    );
  }

  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.#db.all<{ key: string; value: string }>('SELECT key, value FROM sync_state')) {
      out[row.key] = row.value;
    }
    return out;
  }
}
