/**
 * Raporlar. Yalnizca OKUMA yapar; mevcut tablolar uzerinden turetir.
 * Ayri bir rapor veritabani veya servis yoktur.
 */
import type { Db } from '../../data/db.ts';
import { money, type Money } from '../../core/money/money.ts';
import { quantity, type Quantity } from '../../core/quantity/quantity.ts';

export interface DailySummary {
  readonly businessDate: string;
  readonly salesCount: number;
  readonly salesTotal: Money;
  readonly refundCount: number;
  readonly refundTotal: Money;
  readonly netTotal: Money;
  readonly cashTotal: Money;
  readonly cardTotal: Money;
  readonly discountTotal: Money;
  readonly voidedSales: number;
  readonly itemCount: number;
  readonly averageBasket: Money;
  readonly taxBreakdown: readonly { rateBp: number; base: Money; tax: Money }[];
}

export interface TopProduct {
  readonly productId: number;
  readonly name: string;
  readonly unit: 'EACH' | 'KG';
  readonly quantity: Quantity;
  readonly total: Money;
  readonly lineCount: number;
}

export class ReportService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Tarih verilmezse bugun */
  daily(businessDate: string): DailySummary {
    const totals = this.#db.get<{
      sales_count: number; sales_total: number; refund_count: number; refund_total: number;
      discount_total: number; item_count: number; cash_total: number; card_total: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN doc_type='SALE'   THEN 1 ELSE 0 END), 0)        AS sales_count,
         COALESCE(SUM(CASE WHEN doc_type='SALE'   THEN total ELSE 0 END), 0)    AS sales_total,
         COALESCE(SUM(CASE WHEN doc_type='REFUND' THEN 1 ELSE 0 END), 0)        AS refund_count,
         COALESCE(SUM(CASE WHEN doc_type='REFUND' THEN total ELSE 0 END), 0)    AS refund_total,
         COALESCE(SUM(discount_total), 0)                                       AS discount_total,
         COALESCE(SUM(CASE WHEN doc_type='SALE' THEN item_count ELSE 0 END), 0) AS item_count,
         COALESCE((SELECT SUM(p.amount) FROM payments p JOIN sales s2 ON s2.id = p.sale_id
                    WHERE s2.business_date = s.business_date AND s2.status='COMPLETED'
                      AND s2.doc_type='SALE' AND p.method='CASH'), 0)           AS cash_total,
         COALESCE((SELECT SUM(p.amount) FROM payments p JOIN sales s2 ON s2.id = p.sale_id
                    WHERE s2.business_date = s.business_date AND s2.status='COMPLETED'
                      AND s2.doc_type='SALE' AND p.method='CARD'), 0)           AS card_total
       FROM sales s
       WHERE s.business_date = ? AND s.status = 'COMPLETED'`,
      businessDate,
    ) ?? {
      sales_count: 0, sales_total: 0, refund_count: 0, refund_total: 0,
      discount_total: 0, item_count: 0, cash_total: 0, card_total: 0,
    };

    const voided = this.#db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sales WHERE business_date = ? AND status = 'VOIDED'",
      businessDate,
    )!.n;

    const taxRows = this.#db.all<{ tax_rate_bp: number; net: number; tax: number }>(
      `SELECT i.tax_rate_bp,
              COALESCE(SUM(CASE WHEN s.doc_type='SALE' THEN i.net_amount ELSE -i.net_amount END), 0) AS net,
              COALESCE(SUM(CASE WHEN s.doc_type='SALE' THEN i.tax_amount ELSE -i.tax_amount END), 0) AS tax
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.business_date = ? AND s.status='COMPLETED' AND i.voided_at IS NULL
        GROUP BY i.tax_rate_bp ORDER BY i.tax_rate_bp`,
      businessDate,
    );

    const net = totals.sales_total - totals.refund_total;
    return {
      businessDate,
      salesCount: totals.sales_count,
      salesTotal: money(totals.sales_total),
      refundCount: totals.refund_count,
      refundTotal: money(totals.refund_total),
      netTotal: money(net),
      cashTotal: money(totals.cash_total),
      cardTotal: money(totals.card_total),
      discountTotal: money(totals.discount_total),
      voidedSales: voided,
      itemCount: totals.item_count,
      averageBasket: money(
        totals.sales_count === 0 ? 0 : Math.round(totals.sales_total / totals.sales_count),
      ),
      taxBreakdown: taxRows.map((t) => ({
        rateBp: t.tax_rate_bp, base: money(t.net - t.tax), tax: money(t.tax),
      })),
    };
  }

  /** Tarih araligi ozeti (gun gun) */
  range(fromDate: string, toDate: string): DailySummary[] {
    const days = this.#db.all<{ business_date: string }>(
      `SELECT DISTINCT business_date FROM sales
        WHERE business_date BETWEEN ? AND ? AND status='COMPLETED'
        ORDER BY business_date DESC`,
      fromDate, toDate,
    );
    return days.map((d) => this.daily(d.business_date));
  }

  topProducts(fromDate: string, toDate: string, limit = 20): TopProduct[] {
    return this.#db.all<{
      product_id: number; name: string; unit: 'EACH' | 'KG';
      qty: number; total: number; lines: number;
    }>(
      `SELECT i.product_id, i.name_snapshot AS name, i.unit,
              SUM(CASE WHEN s.doc_type='SALE' THEN i.quantity ELSE -i.quantity END)     AS qty,
              SUM(CASE WHEN s.doc_type='SALE' THEN i.net_amount ELSE -i.net_amount END) AS total,
              COUNT(*) AS lines
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.business_date BETWEEN ? AND ? AND s.status='COMPLETED' AND i.voided_at IS NULL
        GROUP BY i.product_id, i.name_snapshot, i.unit
        ORDER BY total DESC LIMIT ?`,
      fromDate, toDate, limit,
    ).map((r) => ({
      productId: r.product_id, name: r.name, unit: r.unit,
      quantity: quantity(r.qty), total: money(r.total), lineCount: r.lines,
    }));
  }

  /** Satis gecmisi listesi (yonetim ekrani ve iade secimi icin) */
  salesHistory(options: {
    businessDate?: string; docType?: 'SALE' | 'REFUND'; limit?: number; offset?: number;
  } = {}): {
    id: number; receipt: string; docType: string; status: string; total: Money;
    itemCount: number; completedAt: number | null; cashier: string; businessDate: string | null;
  }[] {
    const clauses: string[] = ["s.status IN ('COMPLETED','VOIDED')"];
    const params: (string | number)[] = [];
    if (options.businessDate !== undefined) {
      clauses.push('s.business_date = ?');
      params.push(options.businessDate);
    }
    if (options.docType !== undefined) {
      clauses.push('s.doc_type = ?');
      params.push(options.docType);
    }
    params.push(options.limit ?? 100, options.offset ?? 0);

    return this.#db.all<{
      id: number; receipt_series: string | null; receipt_no: number | null;
      doc_type: string; status: string; total: number; item_count: number;
      completed_at: number | null; cashier: string; business_date: string | null;
    }>(
      `SELECT s.id, s.receipt_series, s.receipt_no, s.doc_type, s.status, s.total,
              s.item_count, s.completed_at, s.business_date,
              COALESCE(u.display_name, '-') AS cashier
         FROM sales s LEFT JOIN users u ON u.id = s.user_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.completed_at DESC, s.id DESC
        LIMIT ? OFFSET ?`,
      ...params,
    ).map((r) => ({
      id: r.id,
      receipt: r.receipt_no === null ? '-' : `${r.receipt_series ?? ''}${r.receipt_no}`,
      docType: r.doc_type,
      status: r.status,
      total: money(r.total),
      itemCount: r.item_count,
      completedAt: r.completed_at,
      cashier: r.cashier,
      businessDate: r.business_date,
    }));
  }
}
