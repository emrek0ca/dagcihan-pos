/**
 * Urun, PLU ve barkod yonetimi + sicak yol aramalari.
 *
 * Sicak yol (barkod okundu -> urun bulundu) tek indeksli sorgudur; hazir ifade
 * onbellegi ile birlikte tipik olarak < 1 ms surer.
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import { PosError } from '../../core/errors.ts';
import { money, type BasisPoints, type Money } from '../../core/money/money.ts';
import { quantity, type ProductUnit, type Quantity } from '../../core/quantity/quantity.ts';
import type { AuditLog } from '../audit/audit.ts';
import { NULL_OUTBOX, type OutboxPort } from '../sync/outbox.ts';

export interface Product {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly unitPrice: Money;
  readonly taxRateBp: BasisPoints;
  readonly trackStock: boolean;
  readonly stockQty: Quantity;
  readonly minPrice: Money | null;
  readonly maxPrice: Money | null;
  readonly active: boolean;
}

interface ProductRow {
  id: number; code: string; name: string; unit: ProductUnit;
  unit_price: number; tax_rate_bp: number; track_stock: number; stock_qty: number;
  min_price: number | null; max_price: number | null; active: number;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    unitPrice: money(row.unit_price),
    taxRateBp: row.tax_rate_bp as BasisPoints,
    trackStock: row.track_stock === 1,
    stockQty: quantity(row.stock_qty),
    minPrice: row.min_price === null ? null : money(row.min_price),
    maxPrice: row.max_price === null ? null : money(row.max_price),
    active: row.active === 1,
  };
}

export interface CreateProductInput {
  readonly code: string;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly unitPrice: Money;
  readonly taxRateBp: BasisPoints;
  readonly trackStock?: boolean;
  readonly stockQty?: Quantity;
  readonly minPrice?: Money;
  readonly maxPrice?: Money;
  readonly barcodes?: readonly string[];
  readonly plus?: readonly number[];
}

const SELECT_PRODUCT = 'SELECT * FROM products WHERE deleted_at IS NULL';

export class ProductService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #audit: AuditLog;
  readonly #outbox: OutboxPort;

  constructor(db: Db, clock: Clock, audit: AuditLog, outbox: OutboxPort = NULL_OUTBOX) {
    this.#db = db;
    this.#clock = clock;
    this.#audit = audit;
    this.#outbox = outbox;
  }

  // ----------------------------- Sicak yol -----------------------------

  /** Duz barkod ile urun bulma (barkod tablosu -> urun) */
  findByBarcode(barcode: string): { product: Product; packSize: Quantity } | undefined {
    const row = this.#db.get<ProductRow & { pack_size: number }>(
      `SELECT p.*, b.pack_size FROM product_barcodes b
         JOIN products p ON p.id = b.product_id
        WHERE b.barcode = ? AND p.deleted_at IS NULL`,
      barcode,
    );
    if (row === undefined) return undefined;
    return { product: toProduct(row), packSize: quantity(row.pack_size) };
  }

  /** Terazi PLU'su ile urun bulma */
  findByPlu(plu: number): Product | undefined {
    const row = this.#db.get<ProductRow>(
      `SELECT p.* FROM product_plus pl
         JOIN products p ON p.id = pl.product_id
        WHERE pl.plu = ? AND p.deleted_at IS NULL`,
      plu,
    );
    return row === undefined ? undefined : toProduct(row);
  }

  findByCode(code: string): Product | undefined {
    const row = this.#db.get<ProductRow>(`${SELECT_PRODUCT} AND code = ?`, code);
    return row === undefined ? undefined : toProduct(row);
  }

  byId(id: number): Product {
    const row = this.#db.get<ProductRow>(`${SELECT_PRODUCT} AND id = ?`, id);
    if (row === undefined) throw new PosError('PRODUCT_NOT_FOUND', `Urun bulunamadi: ${id}`);
    return toProduct(row);
  }

  /** Kasiyer icin isim/kod/barkod araması (dokunmatik ekranda hizli arama) */
  search(term: string, limit = 40): Product[] {
    const like = `%${term.trim()}%`;
    return this.#db
      .all<ProductRow>(
        `${SELECT_PRODUCT} AND active = 1
           AND (name LIKE ? OR code LIKE ?
                OR id IN (SELECT product_id FROM product_barcodes WHERE barcode LIKE ?)
                OR id IN (SELECT product_id FROM product_plus WHERE CAST(plu AS TEXT) LIKE ?))
         ORDER BY name LIMIT ?`,
        like, like, like, like, limit,
      )
      .map(toProduct);
  }

  list(options: { activeOnly?: boolean; limit?: number; offset?: number } = {}): Product[] {
    const activeClause = options.activeOnly === true ? ' AND active = 1' : '';
    return this.#db
      .all<ProductRow>(
        `${SELECT_PRODUCT}${activeClause} ORDER BY name LIMIT ? OFFSET ?`,
        options.limit ?? 500,
        options.offset ?? 0,
      )
      .map(toProduct);
  }

  count(): number {
    return this.#db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL',
    )!.n;
  }

  // ----------------------------- Yonetim -----------------------------

  create(input: CreateProductInput): Product {
    const now = this.#clock.now();
    return this.#db.tx(() => {
      const { lastInsertRowid: id } = this.#db.run(
        `INSERT INTO products
           (code, name, unit, unit_price, tax_rate_bp, track_stock, stock_qty,
            min_price, max_price, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        input.code, input.name, input.unit, input.unitPrice, input.taxRateBp,
        input.trackStock === false ? 0 : 1, input.stockQty ?? 0,
        input.minPrice ?? null, input.maxPrice ?? null, now, now,
      );
      // Acilis stogu hareket defterine de yazilir; aksi halde defter ile bakiye
      // ayrisir ve InventoryService.verify() surekli tutarsizlik raporlar.
      const opening = input.stockQty ?? 0;
      if (opening !== 0 && input.trackStock !== false) {
        this.#db.run(
          `INSERT INTO stock_movements
             (product_id, type, quantity_delta, balance_after, note, at)
           VALUES (?, 'OPENING', ?, ?, ?, ?)`,
          id, opening, opening, 'Urun olusturuldu - acilis stogu', now,
        );
      }
      for (const barcode of input.barcodes ?? []) this.addBarcode(id, barcode);
      for (const plu of input.plus ?? []) this.addPlu(id, plu);
      this.#audit.record({
        type: 'PRODUCT_CREATED', entity: 'product', entityId: id,
        data: { code: input.code, name: input.name, unitPrice: input.unitPrice },
      });
      return this.byId(id);
    });
  }

  addBarcode(productId: number, barcode: string, packSize: Quantity = quantity(1000)): void {
    const existing = this.#db.get<{ product_id: number }>(
      'SELECT product_id FROM product_barcodes WHERE barcode = ?', barcode,
    );
    if (existing !== undefined && existing.product_id !== productId) {
      throw new PosError('PRODUCT_NOT_FOUND', `Barkod baska urunde kayitli: ${barcode}`, {
        userMessage: 'Bu barkod baska bir urune tanimli.',
        details: { barcode, existingProductId: existing.product_id },
      });
    }
    if (existing !== undefined) return;
    this.#db.run(
      'INSERT INTO product_barcodes (product_id, barcode, symbology, pack_size, created_at) VALUES (?, ?, ?, ?, ?)',
      productId, barcode, guessSymbology(barcode), packSize, this.#clock.now(),
    );
  }

  addPlu(productId: number, plu: number, scaleDept = 1): void {
    const existing = this.#db.get<{ product_id: number }>(
      'SELECT product_id FROM product_plus WHERE plu = ?', plu,
    );
    if (existing !== undefined && existing.product_id !== productId) {
      throw new PosError('PLU_NOT_FOUND', `PLU baska urunde kayitli: ${plu}`, {
        userMessage: 'Bu PLU baska bir urune tanimli.',
      });
    }
    if (existing !== undefined) return;
    this.#db.run(
      'INSERT INTO product_plus (product_id, plu, scale_dept, created_at) VALUES (?, ?, ?, ?)',
      productId, plu, scaleDept, this.#clock.now(),
    );
  }

  removeBarcode(productId: number, barcode: string): boolean {
    return this.#db.run(
      'DELETE FROM product_barcodes WHERE product_id = ? AND barcode = ?', productId, barcode,
    ).changes > 0;
  }

  removePlu(productId: number, plu: number): boolean {
    return this.#db.run(
      'DELETE FROM product_plus WHERE product_id = ? AND plu = ?', productId, plu,
    ).changes > 0;
  }

  priceHistory(productId: number, limit = 50): {
    oldPrice: number; newPrice: number; at: number; reason: string | null;
  }[] {
    return this.#db.all<{
      old_price: number; new_price: number; at: number; reason: string | null;
    }>(
      'SELECT old_price, new_price, at, reason FROM product_price_history WHERE product_id = ? ORDER BY at DESC LIMIT ?',
      productId, limit,
    ).map((r) => ({ oldPrice: r.old_price, newPrice: r.new_price, at: r.at, reason: r.reason }));
  }

  pluListFor(productId: number): number[] {
    return this.#db
      .all<{ plu: number }>('SELECT plu FROM product_plus WHERE product_id = ? ORDER BY plu', productId)
      .map((r) => r.plu);
  }

  allPlus(): number[] {
    return this.#db.all<{ plu: number }>('SELECT plu FROM product_plus ORDER BY plu').map((r) => r.plu);
  }

  barcodesFor(productId: number): string[] {
    return this.#db
      .all<{ barcode: string }>('SELECT barcode FROM product_barcodes WHERE product_id = ?', productId)
      .map((r) => r.barcode);
  }

  changePrice(productId: number, newPrice: Money, userId?: number, reason?: string): Product {
    return this.#db.tx(() => {
      const current = this.byId(productId);
      if (current.unitPrice === newPrice) return current;
      const now = this.#clock.now();
      this.#db.run('UPDATE products SET unit_price = ?, updated_at = ? WHERE id = ?',
        newPrice, now, productId);
      this.#db.run(
        `INSERT INTO product_price_history (product_id, old_price, new_price, changed_by, reason, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        productId, current.unitPrice, newPrice, userId ?? null, reason ?? null, now,
      );
      this.#audit.record({
        type: 'PRICE_CHANGED', entity: 'product', entityId: productId,
        ...(userId !== undefined ? { userId } : {}),
        data: { oldPrice: current.unitPrice, newPrice, reason: reason ?? null },
      });
      this.#outbox.record({
        type: 'product.price_changed',
        entityType: 'product',
        entityId: productId,
        payload: {
          productCode: current.code, oldPrice: current.unitPrice, newPrice,
          reason: reason ?? null,
        },
      });
      return this.byId(productId);
    });
  }

  update(productId: number, changes: Partial<Omit<CreateProductInput, 'code'>>, userId?: number): Product {
    return this.#db.tx(() => {
      const current = this.byId(productId);
      const now = this.#clock.now();
      this.#db.run(
        `UPDATE products SET name = ?, unit = ?, tax_rate_bp = ?, track_stock = ?,
                             min_price = ?, max_price = ?, updated_at = ?
          WHERE id = ?`,
        changes.name ?? current.name,
        changes.unit ?? current.unit,
        changes.taxRateBp ?? current.taxRateBp,
        (changes.trackStock ?? current.trackStock) ? 1 : 0,
        changes.minPrice ?? current.minPrice,
        changes.maxPrice ?? current.maxPrice,
        now, productId,
      );
      if (changes.unitPrice !== undefined && changes.unitPrice !== current.unitPrice) {
        this.changePrice(productId, changes.unitPrice, userId, 'urun guncelleme');
      }
      this.#audit.record({
        type: 'PRODUCT_UPDATED', entity: 'product', entityId: productId,
        ...(userId !== undefined ? { userId } : {}),
        data: { ...changes },
      });
      return this.byId(productId);
    });
  }

  setActive(productId: number, active: boolean): void {
    this.#db.tx(() => {
      this.#db.run('UPDATE products SET active = ?, updated_at = ? WHERE id = ?',
        active ? 1 : 0, this.#clock.now(), productId);
      this.#audit.record({
        type: 'PRODUCT_UPDATED', entity: 'product', entityId: productId, data: { active },
      });
    });
  }
}

function guessSymbology(barcode: string): string {
  if (!/^\d+$/.test(barcode)) return 'CODE128';
  switch (barcode.length) {
    case 8: return 'EAN8';
    case 12: return 'UPCA';
    case 13: return 'EAN13';
    case 14: return 'ITF14';
    default: return 'INTERNAL';
  }
}
