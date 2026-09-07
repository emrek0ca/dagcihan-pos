/**
 * Web sitesinden gelen siparislerin kasadaki gorunumu.
 *
 * Kaynak MERKEZI SISTEMDIR; buradaki tablo yerel bir aynadir. Kasa siparisi
 * kendisi olusturmaz, yalnizca durumunu degistirir ve bu degisiklik once
 * merkeze yazilir. Merkez onaylamadan yerel durum degismez: boylece
 * "kasada hazir dedim ama merkez bilmiyor" durumu olusmaz.
 */
import type { Db } from '../../data/db.ts';

export interface OnlineOrderLine {
  readonly name: string;
  readonly unit: 'EACH' | 'KG';
  /** KG icin gram, EACH icin adet */
  readonly quantity: number;
  readonly unitPrice: number;
  readonly netAmount: number;
}

export interface OnlineOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly status: string;
  readonly total: number;
  readonly subtotal: number;
  readonly shippingTotal: number;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerEmail: string;
  readonly address: Record<string, unknown>;
  readonly notes: string;
  readonly lines: readonly OnlineOrderLine[];
  readonly placedAt: string | null;
  readonly seenAt: string | null;
  readonly printedAt: string | null;
}

/** Merkezden gelen ham siparis kaydi */
export interface RemoteOrder {
  readonly id: string;
  readonly order_no: string | null;
  readonly channel: string | null;
  readonly status: string;
  readonly currency: string | null;
  readonly subtotal: number | string;
  readonly shipping_total: number | string;
  readonly total: number | string;
  readonly external_ref: string | null;
  readonly notes: string | null;
  readonly placed_at: string | null;
  readonly updated_at: string;
  readonly customer_name: string | null;
  readonly customer_phone: string | null;
  readonly customer_email: string | null;
  readonly customer_address: unknown;
  readonly lines: readonly {
    name_snapshot: string;
    unit: string;
    quantity: number | string;
    unit_price: number | string;
    net_amount: number | string;
  }[];
}

/** Kasiyerin yapabilecegi gecisler. Merkez de AYNI kurali uygular. */
export const CASHIER_TRANSITIONS: Record<string, readonly string[]> = {
  PAID: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['FULFILLED', 'CANCELLED'],
};

export const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Odeme bekleniyor',
  PAID: 'Yeni siparis',
  PREPARING: 'Hazirlaniyor',
  READY: 'Hazir',
  FULFILLED: 'Teslim edildi',
  CANCELLED: 'Iptal edildi',
  REFUNDED: 'Iade edildi',
};

const toInt = (value: number | string | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

const parseJson = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class OnlineOrders {
  readonly #db: Db;
  readonly #now: () => string;

  constructor(db: Db, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * Merkezden gelen siparisleri yerele yazar.
   * Bilinen siparis GUNCELLENIR; "goruldu" isareti korunur ki her
   * senkronizasyonda yeniden uyari calmasin.
   */
  upsertMany(orders: readonly RemoteOrder[]): { created: number; updated: number } {
    if (orders.length === 0) return { created: 0, updated: 0 };

    let created = 0;
    let updated = 0;
    const now = this.#now();

    this.#db.tx(() => {
      for (const order of orders) {
        const exists = this.#db.stmt('SELECT 1 FROM online_orders WHERE id = ?').get(order.id);
        const lines = order.lines.map((line) => ({
          name: line.name_snapshot,
          unit: line.unit === 'KG' ? 'KG' : 'EACH',
          quantity: toInt(line.quantity),
          unitPrice: toInt(line.unit_price),
          netAmount: toInt(line.net_amount),
        }));

        this.#db.run(
          `INSERT INTO online_orders (
             id, order_no, channel, status, currency, subtotal, shipping_total, total,
             customer_name, customer_phone, customer_email, address_json, notes,
             lines_json, external_ref, placed_at, remote_updated_at, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             subtotal = excluded.subtotal,
             shipping_total = excluded.shipping_total,
             total = excluded.total,
             customer_name = excluded.customer_name,
             customer_phone = excluded.customer_phone,
             customer_email = excluded.customer_email,
             address_json = excluded.address_json,
             notes = excluded.notes,
             lines_json = excluded.lines_json,
             remote_updated_at = excluded.remote_updated_at,
             synced_at = excluded.synced_at`,
          order.id,
          order.order_no ?? '',
          order.channel ?? 'ONLINE',
          order.status,
          order.currency ?? 'TRY',
          toInt(order.subtotal),
          toInt(order.shipping_total),
          toInt(order.total),
          order.customer_name ?? '',
          order.customer_phone ?? '',
          order.customer_email ?? '',
          JSON.stringify(order.customer_address ?? {}),
          order.notes ?? '',
          JSON.stringify(lines),
          order.external_ref ?? '',
          order.placed_at,
          order.updated_at,
          now,
        );

        if (exists === undefined) created += 1;
        else updated += 1;
      }
    });

    return { created, updated };
  }

  /** Merkezden alinan en son degisiklik zamani; artimli cekme icin kullanilir. */
  lastRemoteUpdatedAt(): string | null {
    const row = this.#db.stmt('SELECT MAX(remote_updated_at) AS at FROM online_orders').get() as
      | { at: string | null }
      | undefined;
    return row?.at ?? null;
  }

  list(statuses: readonly string[] = ['PAID', 'PREPARING', 'READY']): OnlineOrder[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.#db
      .stmt(
        `SELECT * FROM online_orders WHERE status IN (${placeholders})
          ORDER BY COALESCE(placed_at, remote_updated_at) DESC`,
      )
      .all(...statuses) as Record<string, unknown>[];
    return rows.map((row) => this.#map(row));
  }

  get(id: string): OnlineOrder | null {
    const row = this.#db.stmt('SELECT * FROM online_orders WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : this.#map(row);
  }

  /** Kasiyerin henuz gormedigi siparis sayisi (uyari rozeti icin). */
  unseenCount(): number {
    const row = this.#db
      .stmt(
        `SELECT COUNT(*) AS n FROM online_orders
          WHERE seen_at IS NULL AND status IN ('PAID','PREPARING','READY')`,
      )
      .get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  markSeen(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const now = this.#now();
    let changed = 0;
    this.#db.tx(() => {
      for (const id of ids) {
        changed += this.#db.run(
          'UPDATE online_orders SET seen_at = ? WHERE id = ? AND seen_at IS NULL',
          now,
          id,
        ).changes;
      }
    });
    return changed;
  }

  markPrinted(id: string): void {
    this.#db.run('UPDATE online_orders SET printed_at = ? WHERE id = ?', this.#now(), id);
  }

  /** Yerel durumu gunceller. YALNIZCA merkez onayladiktan sonra cagrilir. */
  applyStatus(id: string, status: string): void {
    this.#db.run(
      'UPDATE online_orders SET status = ?, remote_updated_at = ? WHERE id = ?',
      status,
      this.#now(),
      id,
    );
  }

  #map(row: Record<string, unknown>): OnlineOrder {
    return {
      id: String(row.id),
      orderNo: String(row.order_no ?? ''),
      status: String(row.status),
      total: Number(row.total ?? 0),
      subtotal: Number(row.subtotal ?? 0),
      shippingTotal: Number(row.shipping_total ?? 0),
      customerName: String(row.customer_name ?? ''),
      customerPhone: String(row.customer_phone ?? ''),
      customerEmail: String(row.customer_email ?? ''),
      address: parseJson<Record<string, unknown>>(String(row.address_json ?? '{}'), {}),
      notes: String(row.notes ?? ''),
      lines: parseJson<OnlineOrderLine[]>(String(row.lines_json ?? '[]'), []),
      placedAt: row.placed_at === null || row.placed_at === undefined ? null : String(row.placed_at),
      seenAt: row.seen_at === null || row.seen_at === undefined ? null : String(row.seen_at),
      printedAt:
        row.printed_at === null || row.printed_at === undefined ? null : String(row.printed_at),
    };
  }
}
