/**
 * Denetim gunlugu - append-only + hash zinciri.
 *
 * Her kayit bir onceki kaydin hash'ini icerir. Gecmise donuk bir satir
 * degistirilir veya silinirse zincir kirilir ve `verifyAuditChain` bunu bulur.
 * (Tablo ayrica trigger ile UPDATE/DELETE'e kapalidir.)
 */
import { createHash } from 'node:crypto';
import type { Db } from '../../data/db.ts';
import { canonicalJson } from '../../core/ids.ts';
import type { Clock } from '../../core/clock.ts';

export type AuditType =
  | 'SALE_COMPLETED' | 'SALE_VOIDED' | 'SALE_LINE_VOIDED' | 'SALE_DISCOUNT'
  | 'REFUND_COMPLETED' | 'PRICE_OVERRIDE' | 'PRICE_CHANGED'
  | 'PRODUCT_CREATED' | 'PRODUCT_UPDATED' | 'STOCK_ADJUSTED'
  | 'CASH_SESSION_OPENED' | 'CASH_SESSION_CLOSED' | 'CASH_PAID_IN' | 'CASH_PAID_OUT'
  | 'USER_LOGIN' | 'USER_LOGIN_FAILED' | 'USER_CREATED' | 'USER_UPDATED'
  | 'RECEIPT_REPRINTED' | 'UNKNOWN_BARCODE' | 'BARCODE_CONFIG_CHANGED'
  | 'DEVICE_ERROR' | 'SYSTEM_STARTED' | 'RECOVERY_PERFORMED'
  | 'ONLINE_ORDER_STATUS';

export interface AuditInput {
  readonly type: AuditType;
  readonly userId?: number | undefined;
  readonly terminalId?: number | undefined;
  readonly entity?: string;
  readonly entityId?: string | number;
  readonly data?: Record<string, unknown>;
}

const GENESIS = '0'.repeat(64);

export class AuditLog {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  #lastHash(): string {
    const row = this.#db.get<{ hash: string }>(
      'SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1',
    );
    return row?.hash ?? GENESIS;
  }

  record(input: AuditInput): number {
    const at = this.#clock.now();
    const prevHash = this.#lastHash();
    const dataJson = canonicalJson(input.data ?? {});
    const payload = canonicalJson({
      at,
      userId: input.userId ?? null,
      terminalId: input.terminalId ?? null,
      type: input.type,
      entity: input.entity ?? null,
      entityId: input.entityId === undefined ? null : String(input.entityId),
      data: input.data ?? {},
    });
    const hash = createHash('sha256').update(prevHash).update(payload).digest('hex');

    const { lastInsertRowid } = this.#db.run(
      `INSERT INTO audit_events
         (at, user_id, terminal_id, type, entity, entity_id, data_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      at,
      input.userId ?? null,
      input.terminalId ?? null,
      input.type,
      input.entity ?? null,
      input.entityId === undefined ? null : String(input.entityId),
      dataJson,
      prevHash,
      hash,
    );
    return lastInsertRowid;
  }
}

export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly brokenAt: number | null;
  readonly message: string;
}

export function verifyAuditChain(db: Db): AuditVerifyResult {
  const rows = db.all<{
    id: number; at: number; user_id: number | null; terminal_id: number | null;
    type: string; entity: string | null; entity_id: string | null;
    data_json: string; prev_hash: string; hash: string;
  }>('SELECT * FROM audit_events ORDER BY id ASC');

  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      return {
        ok: false, checked: rows.length, brokenAt: row.id,
        message: `Zincir kopuk: kayit ${row.id} onceki hash ile uyusmuyor (kayit silinmis olabilir)`,
      };
    }
    const payload = canonicalJson({
      at: row.at,
      userId: row.user_id,
      terminalId: row.terminal_id,
      type: row.type,
      entity: row.entity,
      entityId: row.entity_id,
      data: JSON.parse(row.data_json) as unknown,
    });
    const hash = createHash('sha256').update(prev).update(payload).digest('hex');
    if (hash !== row.hash) {
      return {
        ok: false, checked: rows.length, brokenAt: row.id,
        message: `Kayit ${row.id} degistirilmis (hash uyusmuyor)`,
      };
    }
    prev = row.hash;
  }
  return {
    ok: true, checked: rows.length, brokenAt: null,
    message: `${rows.length} denetim kaydi dogrulandi, zincir saglam`,
  };
}
