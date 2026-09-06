/**
 * Sunucu -> POS uygulama katmani.
 *
 * CATISMA POLITIKASI (acikca tanimli, sessiz last-write-wins DEGIL):
 *   Sunucu otoriter : urun ana bilgisi, fiyat, KDV, barkod, PLU, kategori
 *   Terminal otoriter: bu terminalde gerceklesen satis/odeme/kasa olaylari
 *   Stok            : merkezi ledger'da birlestirilir; POS yerel bakiyesini
 *                     kendi hareketlerinden turetmeye devam eder
 *
 * Yerelde farkli bir deger varsa sunucununki uygulanir ve fark
 * `sync_pull_log` ile denetim kaydina yazilir - sessizce ezilmez.
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import type { AuditLog } from '../audit/audit.ts';
import { money, type BasisPoints, type Money } from '../../core/money/money.ts';
import { quantity } from '../../core/quantity/quantity.ts';

export interface RemoteProduct {
  readonly id?: string;
  readonly code: string;
  readonly name: string;
  readonly unit: 'EACH' | 'KG';
  readonly unit_price?: number;
  readonly unitPrice?: number;
  readonly tax_rate_bp?: number;
  readonly taxRateBp?: number;
  readonly track_stock?: boolean;
  readonly active?: boolean;
  readonly version?: number;
  /** Iki bicim de kabul edilir: ["869..."] veya [{barcode, packSize}] */
  readonly barcodes?: (string | { barcode: string; packSize?: number })[];
  /** Iki bicim de kabul edilir: [231] veya [{plu, department}] */
  readonly plus?: (number | { plu: number; department?: number })[];
}

export interface ApplyResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly conflicts: string[];
}

export class SyncApplier {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #audit: AuditLog;

  constructor(db: Db, clock: Clock, audit: AuditLog) {
    this.#db = db;
    this.#clock = clock;
    this.#audit = audit;
  }

  /** Merkezi urunleri yerel veritabanina uygular (bootstrap ve artimli cekmede ayni yol) */
  applyProducts(products: readonly RemoteProduct[], cursor: number): ApplyResult {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const conflicts: string[] = [];

    this.#db.tx(() => {
      for (const remote of products) {
        if (typeof remote.code !== 'string' || remote.code === '') {
          skipped++;
          continue;
        }
        const price = money(Number(remote.unit_price ?? remote.unitPrice ?? 0));
        const taxRateBp = Number(remote.tax_rate_bp ?? remote.taxRateBp ?? 0) as BasisPoints;
        const now = this.#clock.now();

        const local = this.#db.get<{
          id: number; name: string; unit_price: number; tax_rate_bp: number; unit: string;
        }>('SELECT id, name, unit_price, tax_rate_bp, unit FROM products WHERE code = ?', remote.code);

        if (local === undefined) {
          const { lastInsertRowid } = this.#db.run(
            `INSERT INTO products
               (code, name, unit, unit_price, tax_rate_bp, track_stock, stock_qty,
                active, created_at, updated_at, remote_id, remote_version, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            remote.code, remote.name, remote.unit, price, taxRateBp,
            remote.track_stock === false ? 0 : 1,
            remote.active === false ? 0 : 1, now, now,
            remote.id ?? null, remote.version ?? null, now,
          );
          this.#applyChildren(lastInsertRowid, remote);
          this.#logPull(cursor, 'product', remote.code, 'UPSERT', true, 'olusturuldu');
          created++;
          continue;
        }

        // Fiyat farki: yerelde degistirilmis olabilir. Sunucu otoriterdir ama
        // fark denetime yazilir ki magaza neyin neden degistigini gorebilsin.
        if (local.unit_price !== price) {
          conflicts.push(`${remote.code}: yerel ${local.unit_price} -> merkezi ${price}`);
          this.#db.run(
            `INSERT INTO product_price_history (product_id, old_price, new_price, reason, at)
             VALUES (?, ?, ?, ?, ?)`,
            local.id, local.unit_price, price, 'merkezi senkronizasyon', now,
          );
          this.#audit.record({
            type: 'PRICE_CHANGED', entity: 'product', entityId: local.id,
            data: {
              source: 'CENTRAL_SYNC', code: remote.code,
              oldPrice: local.unit_price, newPrice: price,
            },
          });
        }

        this.#db.run(
          `UPDATE products
              SET name = ?, unit = ?, unit_price = ?, tax_rate_bp = ?, track_stock = ?,
                  active = ?, updated_at = ?, remote_id = ?, remote_version = ?, synced_at = ?
            WHERE id = ?`,
          remote.name, remote.unit, price, taxRateBp,
          remote.track_stock === false ? 0 : 1,
          remote.active === false ? 0 : 1, now,
          remote.id ?? null, remote.version ?? null, now, local.id,
        );
        this.#applyChildren(local.id, remote);
        this.#logPull(cursor, 'product', remote.code, 'UPSERT', true, 'guncellendi');
        updated++;
      }
    });

    return { created, updated, skipped, conflicts };
  }

  /** Barkod ve PLU'lar sunucu otoritesindedir: merkezi liste yerelin yerine gecer */
  #applyChildren(productId: number, remote: RemoteProduct): void {
    const now = this.#clock.now();

    // Sunucu iki farkli baglamdan (bootstrap ve change_log) veri gonderebilir;
    // ikisi de normalize edilir ki tek bir uygulama yolu kalsin.
    const barcodes = (remote.barcodes ?? [])
      .map((b) => (typeof b === 'string'
        ? { barcode: b, packSize: 1000 }
        : { barcode: b.barcode, packSize: Number(b.packSize ?? 1000) }))
      .filter((b) => typeof b.barcode === 'string' && b.barcode !== '');

    const plus = (remote.plus ?? [])
      .map((p) => (typeof p === 'number'
        ? { plu: p, department: 1 }
        : { plu: Number(p.plu), department: Number(p.department ?? 1) }))
      .filter((p) => Number.isInteger(p.plu));

    if (Array.isArray(remote.barcodes)) {
      const wanted = new Set(barcodes.map((b) => b.barcode));
      for (const existing of this.#db.all<{ barcode: string }>(
        'SELECT barcode FROM product_barcodes WHERE product_id = ?', productId,
      )) {
        if (!wanted.has(existing.barcode)) {
          this.#db.run('DELETE FROM product_barcodes WHERE product_id = ? AND barcode = ?',
            productId, existing.barcode);
        }
      }
      for (const barcode of barcodes) {
        // Barkod baska bir urundeyse merkezi kayit onceliklidir
        this.#db.run('DELETE FROM product_barcodes WHERE barcode = ? AND product_id <> ?',
          barcode.barcode, productId);
        this.#db.run(
          `INSERT INTO product_barcodes (product_id, barcode, symbology, pack_size, created_at)
           VALUES (?, ?, 'SYNCED', ?, ?)
           ON CONFLICT(barcode) DO UPDATE SET product_id = excluded.product_id,
                                              pack_size = excluded.pack_size`,
          productId, barcode.barcode, quantity(barcode.packSize), now,
        );
      }
    }

    if (Array.isArray(remote.plus)) {
      const wanted = new Set(plus.map((p) => p.plu));
      for (const existing of this.#db.all<{ plu: number }>(
        'SELECT plu FROM product_plus WHERE product_id = ?', productId,
      )) {
        if (!wanted.has(existing.plu)) {
          this.#db.run('DELETE FROM product_plus WHERE product_id = ? AND plu = ?',
            productId, existing.plu);
        }
      }
      for (const entry of plus) {
        this.#db.run('DELETE FROM product_plus WHERE plu = ? AND product_id <> ?',
          entry.plu, productId);
        this.#db.run(
          `INSERT INTO product_plus (product_id, plu, scale_dept, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(plu) DO UPDATE SET product_id = excluded.product_id`,
          productId, entry.plu, entry.department, now,
        );
      }
    }
  }

  /** Artimli degisiklikleri uygular */
  applyChanges(
    changes: readonly {
      id: number; entity_type: string; entity_id: string;
      operation: string; payload: Record<string, unknown>;
    }[],
  ): ApplyResult {
    const products: RemoteProduct[] = [];
    let skipped = 0;
    const conflicts: string[] = [];

    for (const change of changes) {
      if (change.entity_type === 'product' && change.operation === 'UPSERT') {
        products.push({ id: change.entity_id, ...(change.payload as unknown as RemoteProduct) });
        continue;
      }
      if (change.entity_type === 'price' && change.operation === 'UPSERT') {
        const payload = change.payload as { code?: string; unitPrice?: number };
        if (typeof payload.code !== 'string' || typeof payload.unitPrice !== 'number') {
          skipped++;
          continue;
        }
        const applied = this.#applyPrice(payload.code, money(payload.unitPrice), change.id);
        if (applied === 'conflict') conflicts.push(payload.code);
        if (applied === 'missing') skipped++;
        continue;
      }
      this.#logPull(change.id, change.entity_type, change.entity_id, change.operation, false,
        'desteklenmeyen varlik turu');
      skipped++;
    }

    const result = products.length > 0
      ? this.applyProducts(products, changes.at(-1)?.id ?? 0)
      : { created: 0, updated: 0, skipped: 0, conflicts: [] };

    return {
      created: result.created,
      updated: result.updated,
      skipped: skipped + result.skipped,
      conflicts: [...conflicts, ...result.conflicts],
    };
  }

  #applyPrice(code: string, newPrice: Money, cursor: number): 'ok' | 'conflict' | 'missing' {
    return this.#db.tx(() => {
      const local = this.#db.get<{ id: number; unit_price: number }>(
        'SELECT id, unit_price FROM products WHERE code = ?', code,
      );
      if (local === undefined) {
        this.#logPull(cursor, 'price', code, 'UPSERT', false, 'urun yerelde yok');
        return 'missing';
      }
      if (local.unit_price === newPrice) {
        this.#logPull(cursor, 'price', code, 'UPSERT', true, 'degisiklik yok');
        return 'ok';
      }
      const now = this.#clock.now();
      this.#db.run('UPDATE products SET unit_price = ?, updated_at = ?, synced_at = ? WHERE id = ?',
        newPrice, now, now, local.id);
      this.#db.run(
        `INSERT INTO product_price_history (product_id, old_price, new_price, reason, at)
         VALUES (?, ?, ?, 'merkezi fiyat guncellemesi', ?)`,
        local.id, local.unit_price, newPrice, now,
      );
      this.#audit.record({
        type: 'PRICE_CHANGED', entity: 'product', entityId: local.id,
        data: { source: 'CENTRAL_SYNC', code, oldPrice: local.unit_price, newPrice },
      });
      this.#logPull(cursor, 'price', code, 'UPSERT', true,
        `${local.unit_price} -> ${newPrice}`);
      return 'conflict';
    });
  }

  #logPull(
    cursor: number, entityType: string, entityId: string,
    operation: string, applied: boolean, detail: string,
  ): void {
    this.#db.run(
      `INSERT INTO sync_pull_log (cursor, entity_type, entity_id, operation, applied, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      cursor, entityType, entityId, operation, applied ? 1 : 0, detail, this.#clock.now(),
    );
  }
}
