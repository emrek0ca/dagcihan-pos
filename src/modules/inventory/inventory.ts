/**
 * Stok. Iki kaynak vardir:
 *   stock_movements : gercegi tanimlayan append-only hareket defteri
 *   products.stock_qty : hizli okuma icin materyalize bakiye
 * Ikisi arasindaki tutarsizlik `verify()` ile bulunur ve `rebuild()` ile duzeltilir.
 *
 * Stok YALNIZCA satis tamamlandiginda dusurulur. Acik/askidaki fisler stok tutmaz.
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import { PosError } from '../../core/errors.ts';
import { quantity, type Quantity } from '../../core/quantity/quantity.ts';
import type { AuditLog } from '../audit/audit.ts';
import { NULL_OUTBOX, type OutboxPort } from '../sync/outbox.ts';

export type MovementType =
  | 'SALE' | 'RETURN' | 'PURCHASE' | 'ADJUSTMENT' | 'WASTE' | 'COUNT' | 'OPENING';

export interface MovementInput {
  readonly productId: number;
  readonly type: MovementType;
  /** Satista negatif, iade/alimda pozitif */
  readonly delta: Quantity;
  readonly saleId?: number;
  readonly saleItemId?: number;
  readonly userId?: number;
  readonly note?: string;
}

export interface StockMovement {
  readonly id: number;
  readonly productId: number;
  readonly type: MovementType;
  readonly delta: Quantity;
  readonly balanceAfter: Quantity;
  readonly at: number;
  readonly saleId: number | null;
  readonly note: string | null;
}

export class InventoryService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #audit: AuditLog;
  readonly #blockNegative: boolean;
  readonly #outbox: OutboxPort;

  constructor(
    db: Db, clock: Clock, audit: AuditLog,
    options: { blockNegativeStock?: boolean; outbox?: OutboxPort } = {},
  ) {
    this.#db = db;
    this.#clock = clock;
    this.#audit = audit;
    this.#blockNegative = options.blockNegativeStock ?? false;
    this.#outbox = options.outbox ?? NULL_OUTBOX;
  }

  /**
   * Hareket kaydeder ve bakiyeyi gunceller. MUTLAKA cagiran transaction icinde
   * calisir - satis tamamlama ile ayni atomik birimde olmasi sarttir.
   */
  record(input: MovementInput): StockMovement {
    if (!this.#db.inTransaction) {
      throw new PosError('INTERNAL', 'Stok hareketi transaction disinda kaydedilemez');
    }
    const row = this.#db.get<{ stock_qty: number; track_stock: number; name: string }>(
      'SELECT stock_qty, track_stock, name FROM products WHERE id = ?', input.productId,
    );
    if (row === undefined) {
      throw new PosError('PRODUCT_NOT_FOUND', `Urun bulunamadi: ${input.productId}`);
    }
    if (row.track_stock === 0) {
      // Stok takibi kapali urun: hareket yazilmaz, bakiye degismez
      return {
        id: 0, productId: input.productId, type: input.type, delta: input.delta,
        balanceAfter: quantity(row.stock_qty), at: this.#clock.now(), saleId: null, note: 'takip yok',
      };
    }

    const balanceAfter = row.stock_qty + input.delta;
    if (this.#blockNegative && balanceAfter < 0) {
      throw new PosError('INSUFFICIENT_STOCK',
        `Yetersiz stok: ${row.name} (mevcut ${row.stock_qty}, istenen ${-input.delta})`, {
          details: { productId: input.productId, available: row.stock_qty },
        });
    }

    const at = this.#clock.now();
    const { lastInsertRowid } = this.#db.run(
      `INSERT INTO stock_movements
         (product_id, type, quantity_delta, balance_after, sale_id, sale_item_id, user_id, note, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.productId, input.type, input.delta, balanceAfter,
      input.saleId ?? null, input.saleItemId ?? null, input.userId ?? null,
      input.note ?? null, at,
    );
    this.#db.run('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?',
      balanceAfter, at, input.productId);

    return {
      id: lastInsertRowid,
      productId: input.productId,
      type: input.type,
      delta: input.delta,
      balanceAfter: quantity(balanceAfter),
      at,
      saleId: input.saleId ?? null,
      note: input.note ?? null,
    };
  }

  /** Elle stok duzeltme (sayim, fire, mal kabul) */
  adjust(input: {
    productId: number; delta: Quantity; type: MovementType; userId: number; note?: string;
  }): StockMovement {
    return this.#db.tx(() => {
      const movement = this.record(input);
      this.#audit.record({
        type: 'STOCK_ADJUSTED', entity: 'product', entityId: input.productId,
        userId: input.userId,
        data: { delta: input.delta, movementType: input.type, note: input.note ?? null,
                balanceAfter: movement.balanceAfter },
      });
      this.#outbox.record({
        type: 'inventory.adjusted',
        entityType: 'product',
        entityId: input.productId,
        payload: {
          productCode: this.#db.get<{ code: string }>(
            'SELECT code FROM products WHERE id = ?', input.productId,
          )?.code ?? null,
          movementType: input.type,
          delta: input.delta,
          balanceAfter: movement.balanceAfter,
          reference: `adj-${movement.id}`,
          note: input.note ?? null,
        },
      });
      return movement;
    });
  }

  /** Sayim sonucuna gore bakiyeyi hedefe cekmek */
  setCount(productId: number, countedQty: Quantity, userId: number, note?: string): StockMovement {
    return this.#db.tx(() => {
      const row = this.#db.get<{ stock_qty: number }>(
        'SELECT stock_qty FROM products WHERE id = ?', productId,
      );
      if (row === undefined) throw new PosError('PRODUCT_NOT_FOUND', `Urun yok: ${productId}`);
      return this.adjust({
        productId,
        delta: quantity(countedQty - row.stock_qty),
        type: 'COUNT',
        userId,
        ...(note !== undefined ? { note } : {}),
      });
    });
  }

  movementsFor(productId: number, limit = 100): StockMovement[] {
    return this.#db
      .all<{
        id: number; product_id: number; type: MovementType; quantity_delta: number;
        balance_after: number; at: number; sale_id: number | null; note: string | null;
      }>(
        'SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT ?',
        productId, limit,
      )
      .map((r) => ({
        id: r.id, productId: r.product_id, type: r.type, delta: quantity(r.quantity_delta),
        balanceAfter: quantity(r.balance_after), at: r.at, saleId: r.sale_id, note: r.note,
      }));
  }

  /** Hareket defteri ile materyalize bakiyeyi karsilastirir */
  verify(): { ok: boolean; mismatches: { productId: number; name: string; stored: number; computed: number }[] } {
    const rows = this.#db.all<{ id: number; name: string; stock_qty: number; computed: number }>(
      `SELECT p.id, p.name, p.stock_qty,
              COALESCE((SELECT SUM(quantity_delta) FROM stock_movements m WHERE m.product_id = p.id), 0) AS computed
         FROM products p
        WHERE p.deleted_at IS NULL AND p.track_stock = 1`,
    );
    const mismatches = rows
      .filter((r) => r.stock_qty !== r.computed)
      .map((r) => ({ productId: r.id, name: r.name, stored: r.stock_qty, computed: r.computed }));
    return { ok: mismatches.length === 0, mismatches };
  }

  /** Materyalize bakiyeyi hareket defterinden yeniden kurar (defter otoritedir) */
  rebuild(): number {
    return this.#db.tx(() => {
      const result = this.#db.run(
        `UPDATE products
            SET stock_qty = COALESCE(
                  (SELECT SUM(quantity_delta) FROM stock_movements m WHERE m.product_id = products.id), 0)
          WHERE deleted_at IS NULL AND track_stock = 1`,
      );
      return result.changes;
    });
  }
}
