/**
 * Satis yasam dongusu. Sistemin en kritik modulu.
 *
 * Degismez kurallar:
 *  - Her mutasyon diske yazilir; sepet bellekte tutulmaz (cokme = veri kaybi degil)
 *  - Toplamlar HER OKUMADA calculateSale ile yeniden hesaplanir (tek dogruluk kaynagi)
 *  - Tamamlama tek transaction'dir: numara + odeme + stok + kasa + fis kuyrugu
 *  - Tamamlanan satis degismez (DB trigger ile de korunur)
 *  - Ayni idempotency anahtari ikinci satis olusturmaz
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import { PosError } from '../../core/errors.ts';
import { newUid } from '../../core/ids.ts';
import { money, type Money } from '../../core/money/money.ts';
import { quantity, type Quantity } from '../../core/quantity/quantity.ts';
import { calculateSale, grossOf, summarizePayments } from '../../core/sale/calculate.ts';
import type {
  CalcLine, CashRoundingMode, Discount, PriceSource, ScanSource,
} from '../../core/sale/types.ts';
import type { AuditLog } from '../audit/audit.ts';
import type { InventoryService } from '../inventory/inventory.ts';
import type { IdempotencyStore } from '../../data/idempotency.ts';
import type { ResolvedItem } from '../scanner/resolve.ts';
import { NULL_OUTBOX, type OutboxPort } from '../sync/outbox.ts';
import type {
  DocType, PaymentRequest, PaymentView, SaleItemView, SaleStatus, SaleView,
} from './types.ts';

/** Fis kuyrugu bagimliligi - somut yazici modulunu bilmeyiz */
export interface PrintQueuePort {
  enqueueReceipt(saleId: number, kind: 'RECEIPT' | 'REPRINT', requestedBy?: number): void;
}

export interface SalesOptions {
  readonly receiptSeries: string;
  readonly cashRounding: CashRoundingMode;
  readonly maxDiscountPercentWithoutApproval: number;
  readonly blindRefundAllowed: boolean;
  /** Ayni urun tekrar okutulunca miktar artsin mi (duz barkodlarda) */
  readonly mergeRepeatedScans: boolean;
}

interface SaleRow {
  id: number; uid: string; doc_type: DocType; status: SaleStatus;
  terminal_id: number; user_id: number; cash_session_id: number | null;
  original_sale_id: number | null; receipt_series: string | null; receipt_no: number | null;
  business_date: string | null; opened_at: number; completed_at: number | null;
  discount_type: 'PERCENT' | 'AMOUNT' | null; discount_value: number | null;
  discount_reason: string | null; paid_total: number; change_due: number; note: string | null;
}

interface ItemRow {
  id: number; sale_id: number; line_no: number; product_id: number; name_snapshot: string;
  unit: 'EACH' | 'KG'; quantity: number; unit_price: number; gross_amount: number;
  discount_type: 'PERCENT' | 'AMOUNT' | null; discount_value: number | null;
  discount_amount: number; sale_discount_share: number; net_amount: number;
  tax_rate_bp: number; tax_amount: number; price_source: PriceSource; scan_source: ScanSource;
  raw_barcode: string | null; barcode_rule_id: string | null; original_item_id: number | null;
  voided_at: number | null; void_reason: string | null;
}

interface PaymentRow {
  id: number; method: 'CASH' | 'CARD'; amount: number; tendered: number;
  change_given: number; reference: string | null;
}

export interface CompleteSaleResult {
  readonly saleId: number;
  readonly receiptNo: number;
  readonly receiptSeries: string;
  readonly total: number;
  readonly paidTotal: number;
  readonly changeDue: number;
  readonly completedAt: number;
  readonly replayed?: boolean;
}

export class SalesService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #audit: AuditLog;
  readonly #inventory: InventoryService;
  readonly #idempotency: IdempotencyStore;
  readonly #printQueue: PrintQueuePort | null;
  readonly #outbox: OutboxPort;
  readonly #options: SalesOptions;

  constructor(deps: {
    db: Db; clock: Clock; audit: AuditLog; inventory: InventoryService;
    idempotency: IdempotencyStore; printQueue?: PrintQueuePort | null;
    /** Merkezi senkronizasyon kapaliysa verilmez; satis akisi degismez. */
    outbox?: OutboxPort | null;
    options: SalesOptions;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#audit = deps.audit;
    this.#inventory = deps.inventory;
    this.#idempotency = deps.idempotency;
    this.#printQueue = deps.printQueue ?? null;
    this.#outbox = deps.outbox ?? NULL_OUTBOX;
    this.#options = deps.options;
  }

  // --------------------------- Satis acma / okuma ---------------------------

  /** Terminaldeki acik satis (cokme sonrasi kurtarmanin temeli) */
  currentOpenSale(terminalId: number): SaleView | undefined {
    const row = this.#db.get<SaleRow>(
      "SELECT * FROM sales WHERE terminal_id = ? AND status = 'OPEN'", terminalId,
    );
    return row === undefined ? undefined : this.view(row.id);
  }

  /** Acik satis varsa onu doner, yoksa yenisini acar (kasiyer hicbir sey yapmaz) */
  openSale(input: {
    terminalId: number; userId: number; cashSessionId?: number; docType?: DocType;
    originalSaleId?: number;
  }): SaleView {
    const docType = input.docType ?? 'SALE';
    if (docType === 'SALE') {
      const existing = this.currentOpenSale(input.terminalId);
      if (existing !== undefined) return existing;
    }
    return this.#db.tx(() => {
      const now = this.#clock.now();
      const uid = newUid();
      const { lastInsertRowid: id } = this.#db.run(
        `INSERT INTO sales (uid, doc_type, status, terminal_id, user_id, cash_session_id,
                            original_sale_id, opened_at)
         VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
        uid, docType, input.terminalId, input.userId,
        input.cashSessionId ?? null, input.originalSaleId ?? null, now,
      );
      this.#event(id, 'SALE_OPENED', { docType, uid }, input.userId);
      return this.view(id);
    });
  }

  view(saleId: number): SaleView {
    const sale = this.#db.get<SaleRow>('SELECT * FROM sales WHERE id = ?', saleId);
    if (sale === undefined) throw new PosError('SALE_NOT_FOUND', `Satis bulunamadi: ${saleId}`);

    const itemRows = this.#db.all<ItemRow>(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY line_no', saleId,
    );
    const paymentRows = this.#db.all<PaymentRow>(
      'SELECT * FROM payments WHERE sale_id = ? ORDER BY id', saleId,
    );

    const saleDiscount: Discount | null =
      sale.discount_type === null || sale.discount_value === null
        ? null
        : {
            type: sale.discount_type,
            value: sale.discount_value,
            ...(sale.discount_reason !== null ? { reason: sale.discount_reason } : {}),
          };

    const calcLines: CalcLine[] = itemRows.map((r) => ({
      lineNo: r.line_no,
      quantity: quantity(r.quantity),
      unitPrice: money(r.unit_price),
      taxRateBp: r.tax_rate_bp as CalcLine['taxRateBp'],
      unit: r.unit,
      ...(r.price_source === 'BARCODE_PRICE' || r.price_source === 'REFUND_ORIGINAL'
        ? { fixedGross: money(r.gross_amount) }
        : {}),
      ...(r.discount_type !== null && r.discount_value !== null
        ? { discount: { type: r.discount_type, value: r.discount_value } }
        : {}),
      voided: r.voided_at !== null,
    }));

    const totals = calculateSale({
      lines: calcLines,
      ...(saleDiscount !== null ? { saleDiscount } : {}),
      cashRounding: this.#options.cashRounding,
    });
    const byLine = new Map(totals.lines.map((l) => [l.lineNo, l]));

    const items: SaleItemView[] = itemRows.map((r) => {
      const calc = byLine.get(r.line_no);
      return {
        id: r.id,
        lineNo: r.line_no,
        productId: r.product_id,
        name: r.name_snapshot,
        unit: r.unit,
        quantity: quantity(r.quantity),
        unitPrice: money(r.unit_price),
        gross: money(calc?.gross ?? r.gross_amount),
        discountAmount: money(calc?.discountAmount ?? r.discount_amount),
        saleDiscountShare: money(calc?.saleDiscountShare ?? r.sale_discount_share),
        net: money(calc?.net ?? r.net_amount),
        taxRateBp: r.tax_rate_bp,
        taxAmount: money(calc?.taxAmount ?? r.tax_amount),
        priceSource: r.price_source,
        scanSource: r.scan_source,
        rawBarcode: r.raw_barcode,
        voided: r.voided_at !== null,
        voidReason: r.void_reason,
        originalItemId: r.original_item_id,
      };
    });

    const payments: PaymentView[] = paymentRows.map((p) => ({
      id: p.id,
      method: p.method,
      amount: money(p.amount),
      tendered: money(p.tendered),
      changeGiven: money(p.change_given),
      reference: p.reference,
    }));

    return {
      id: sale.id,
      uid: sale.uid,
      docType: sale.doc_type,
      status: sale.status,
      terminalId: sale.terminal_id,
      userId: sale.user_id,
      cashSessionId: sale.cash_session_id,
      originalSaleId: sale.original_sale_id,
      receiptSeries: sale.receipt_series,
      receiptNo: sale.receipt_no,
      businessDate: sale.business_date,
      openedAt: sale.opened_at,
      completedAt: sale.completed_at,
      items,
      payments,
      saleDiscount,
      totals,
      paidTotal: money(sale.paid_total),
      changeDue: money(sale.change_due),
      note: sale.note,
    };
  }

  // --------------------------- Satir islemleri ---------------------------

  #requireOpen(saleId: number): SaleRow {
    const sale = this.#db.get<SaleRow>('SELECT * FROM sales WHERE id = ?', saleId);
    if (sale === undefined) throw new PosError('SALE_NOT_FOUND', `Satis bulunamadi: ${saleId}`);
    if (sale.status !== 'OPEN') {
      throw new PosError('SALE_NOT_OPEN', `Satis ${saleId} durumu: ${sale.status}`, {
        details: { status: sale.status },
      });
    }
    return sale;
  }

  addItem(saleId: number, item: ResolvedItem, userId: number): SaleView {
    return this.#db.tx(() => {
      this.#requireOpen(saleId);

      // Ayni urunun tekrar okutulmasi: duz barkodda miktar artar, tartilida yeni satir
      if (
        this.#options.mergeRepeatedScans &&
        item.scanSource === 'SCAN_PLAIN' &&
        item.priceSource === 'PRODUCT'
      ) {
        const existing = this.#db.get<ItemRow>(
          `SELECT * FROM sale_items
            WHERE sale_id = ? AND product_id = ? AND voided_at IS NULL
              AND price_source = 'PRODUCT' AND discount_type IS NULL
            ORDER BY line_no DESC LIMIT 1`,
          saleId, item.product.id,
        );
        if (existing !== undefined && existing.unit_price === item.unitPrice) {
          const newQty = quantity(existing.quantity + item.quantity);
          this.#setQuantity(saleId, existing.id, newQty, userId, 'tekrar okutma');
          return this.view(saleId);
        }
      }

      const lineNo =
        (this.#db.get<{ n: number | null }>(
          'SELECT MAX(line_no) AS n FROM sale_items WHERE sale_id = ?', saleId,
        )?.n ?? 0) + 1;

      const gross = grossOf({
        lineNo,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRateBp: item.product.taxRateBp,
        unit: item.product.unit,
        ...(item.fixedGross !== undefined ? { fixedGross: item.fixedGross } : {}),
      });

      const { lastInsertRowid: itemId } = this.#db.run(
        `INSERT INTO sale_items
           (sale_id, line_no, product_id, name_snapshot, unit, quantity, unit_price,
            gross_amount, discount_amount, sale_discount_share, net_amount,
            tax_rate_bp, tax_amount, price_source, scan_source, raw_barcode,
            barcode_rule_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?)`,
        saleId, lineNo, item.product.id, item.product.name, item.product.unit,
        item.quantity, item.unitPrice, gross, gross,
        item.product.taxRateBp, item.priceSource, item.scanSource,
        item.rawBarcode === '' ? null : item.rawBarcode,
        item.ruleId ?? null, this.#clock.now(),
      );

      this.#event(saleId, 'ITEM_ADDED', {
        itemId, lineNo, productId: item.product.id, name: item.product.name,
        quantity: item.quantity, unitPrice: item.unitPrice, gross,
        priceSource: item.priceSource, rawBarcode: item.rawBarcode,
        ...(item.warnings.length > 0 ? { warnings: item.warnings } : {}),
      }, userId);

      this.#touch(saleId);
      return this.view(saleId);
    });
  }

  #setQuantity(saleId: number, itemId: number, qty: Quantity, userId: number, reason: string): void {
    const item = this.#db.get<ItemRow>('SELECT * FROM sale_items WHERE id = ?', itemId);
    if (item === undefined || item.sale_id !== saleId) {
      throw new PosError('LINE_NOT_FOUND', `Satir bulunamadi: ${itemId}`);
    }
    if (item.voided_at !== null) {
      throw new PosError('LINE_ALREADY_VOIDED', `Satir zaten iptal: ${itemId}`);
    }
    if (qty <= 0) throw new PosError('INVALID_QUANTITY', `Miktar pozitif olmali: ${qty}`);
    if (item.price_source === 'BARCODE_PRICE') {
      throw new PosError('INVALID_QUANTITY',
        'Tutar gomulu etiket satirinda miktar degistirilemez', {
          userMessage: 'Bu satir terazi etiketinden geldi, miktari degistirilemez. Satiri iptal edip yeniden okutun.',
        });
    }
    const gross = grossOf({
      lineNo: item.line_no, quantity: qty, unitPrice: money(item.unit_price),
      taxRateBp: item.tax_rate_bp as CalcLine['taxRateBp'], unit: item.unit,
    });
    this.#db.run(
      'UPDATE sale_items SET quantity = ?, gross_amount = ?, net_amount = ? WHERE id = ?',
      qty, gross, gross, itemId,
    );
    this.#event(saleId, 'ITEM_QTY_CHANGED', {
      itemId, lineNo: item.line_no, oldQuantity: item.quantity, newQuantity: qty, reason,
    }, userId);
  }

  changeQuantity(saleId: number, lineNo: number, qty: Quantity, userId: number): SaleView {
    return this.#db.tx(() => {
      this.#requireOpen(saleId);
      const item = this.#itemByLine(saleId, lineNo);
      this.#setQuantity(saleId, item.id, qty, userId, 'elle degisiklik');
      this.#touch(saleId);
      return this.view(saleId);
    });
  }

  voidLine(saleId: number, lineNo: number, userId: number, reason: string, approvedBy?: number): SaleView {
    return this.#db.tx(() => {
      this.#requireOpen(saleId);
      const item = this.#itemByLine(saleId, lineNo);
      if (item.voided_at !== null) {
        throw new PosError('LINE_ALREADY_VOIDED', `Satir zaten iptal: ${lineNo}`);
      }
      this.#db.run(
        'UPDATE sale_items SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?',
        this.#clock.now(), userId, reason, item.id,
      );
      this.#event(saleId, 'ITEM_VOIDED', {
        itemId: item.id, lineNo, productId: item.product_id, name: item.name_snapshot,
        gross: item.gross_amount, reason, approvedBy: approvedBy ?? null,
      }, userId);
      this.#audit.record({
        type: 'SALE_LINE_VOIDED', entity: 'sale', entityId: saleId, userId,
        data: { lineNo, productId: item.product_id, amount: item.gross_amount, reason,
                approvedBy: approvedBy ?? null },
      });
      this.#touch(saleId);
      return this.view(saleId);
    });
  }

  applyLineDiscount(
    saleId: number, lineNo: number, discount: Discount | null, userId: number, approvedBy?: number,
  ): SaleView {
    return this.#db.tx(() => {
      this.#requireOpen(saleId);
      const item = this.#itemByLine(saleId, lineNo);
      this.#assertDiscountAllowed(discount, money(item.gross_amount), approvedBy);
      this.#db.run(
        'UPDATE sale_items SET discount_type = ?, discount_value = ? WHERE id = ?',
        discount?.type ?? null, discount?.value ?? null, item.id,
      );
      this.#event(saleId, 'ITEM_DISCOUNTED', {
        itemId: item.id, lineNo, discount, approvedBy: approvedBy ?? null,
      }, userId);
      if (discount !== null) {
        this.#audit.record({
          type: 'SALE_DISCOUNT', entity: 'sale', entityId: saleId, userId,
          data: { scope: 'LINE', lineNo, discount, approvedBy: approvedBy ?? null },
        });
      }
      this.#touch(saleId);
      return this.view(saleId);
    });
  }

  applySaleDiscount(
    saleId: number, discount: Discount | null, userId: number, approvedBy?: number,
  ): SaleView {
    return this.#db.tx(() => {
      this.#requireOpen(saleId);
      const current = this.view(saleId);
      this.#assertDiscountAllowed(discount, current.totals.subtotal, approvedBy);
      this.#db.run(
        'UPDATE sales SET discount_type = ?, discount_value = ?, discount_reason = ?, discount_approved_by = ? WHERE id = ?',
        discount?.type ?? null, discount?.value ?? null, discount?.reason ?? null,
        approvedBy ?? null, saleId,
      );
      this.#event(saleId, 'SALE_DISCOUNTED', { discount, approvedBy: approvedBy ?? null }, userId);
      if (discount !== null) {
        this.#audit.record({
          type: 'SALE_DISCOUNT', entity: 'sale', entityId: saleId, userId,
          data: { scope: 'SALE', discount, approvedBy: approvedBy ?? null },
        });
      }
      return this.view(saleId);
    });
  }

  #assertDiscountAllowed(discount: Discount | null, base: Money, approvedBy?: number): void {
    if (discount === null) return;
    if (discount.type === 'AMOUNT' && discount.value > base) {
      throw new PosError('DISCOUNT_TOO_LARGE',
        `Indirim tutari (${discount.value}) tutari (${base}) asiyor`);
    }
    const percentValue =
      discount.type === 'PERCENT'
        ? discount.value / 100
        : base > 0 ? (discount.value / base) * 100 : 0;
    if (percentValue > this.#options.maxDiscountPercentWithoutApproval && approvedBy === undefined) {
      throw new PosError('APPROVAL_REQUIRED',
        `%${percentValue.toFixed(1)} indirim yonetici onayi gerektiriyor`, {
          details: { percent: percentValue, limit: this.#options.maxDiscountPercentWithoutApproval },
        });
    }
  }

  #itemByLine(saleId: number, lineNo: number): ItemRow {
    const item = this.#db.get<ItemRow>(
      'SELECT * FROM sale_items WHERE sale_id = ? AND line_no = ?', saleId, lineNo,
    );
    if (item === undefined) {
      throw new PosError('LINE_NOT_FOUND', `Satir bulunamadi: fis ${saleId} satir ${lineNo}`);
    }
    return item;
  }

  // --------------------------- Askiya alma / iptal ---------------------------

  park(saleId: number, userId: number): SaleView {
    return this.#db.tx(() => {
      this.#requireOpen(saleId);
      this.#db.run("UPDATE sales SET status = 'PARKED' WHERE id = ?", saleId);
      this.#event(saleId, 'SALE_PARKED', {}, userId);
      return this.view(saleId);
    });
  }

  resume(saleId: number, userId: number): SaleView {
    return this.#db.tx(() => {
      const sale = this.#db.get<SaleRow>('SELECT * FROM sales WHERE id = ?', saleId);
      if (sale === undefined) throw new PosError('SALE_NOT_FOUND', `Satis yok: ${saleId}`);
      if (sale.status !== 'PARKED') {
        throw new PosError('SALE_NOT_OPEN', `Satis askida degil: ${sale.status}`);
      }
      const open = this.currentOpenSale(sale.terminal_id);
      if (open !== undefined) {
        throw new PosError('SALE_ALREADY_OPEN',
          'Kasada zaten acik bir fis var. Once onu tamamlayin veya askiya alin.');
      }
      this.#db.run("UPDATE sales SET status = 'OPEN' WHERE id = ?", saleId);
      this.#event(saleId, 'SALE_RESUMED', {}, userId);
      return this.view(saleId);
    });
  }

  listParked(terminalId: number): SaleView[] {
    return this.#db
      .all<{ id: number }>(
        "SELECT id FROM sales WHERE terminal_id = ? AND status = 'PARKED' ORDER BY opened_at",
        terminalId,
      )
      .map((r) => this.view(r.id));
  }

  voidSale(saleId: number, userId: number, reason: string, approvedBy?: number): SaleView {
    return this.#db.tx(() => {
      const sale = this.#db.get<SaleRow>('SELECT * FROM sales WHERE id = ?', saleId);
      if (sale === undefined) throw new PosError('SALE_NOT_FOUND', `Satis yok: ${saleId}`);
      if (sale.status === 'COMPLETED') {
        throw new PosError('SALE_NOT_OPEN',
          'Tamamlanmis satis iptal edilemez; iade islemi yapilmalidir.', {
            userMessage: 'Tamamlanmis fis iptal edilemez. Iade yapin.',
          });
      }
      if (sale.status === 'VOIDED') return this.view(saleId);

      const before = this.view(saleId);
      this.#db.run(
        "UPDATE sales SET status = 'VOIDED', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?",
        this.#clock.now(), userId, reason, saleId,
      );
      this.#event(saleId, 'SALE_VOIDED', {
        reason, approvedBy: approvedBy ?? null, itemCount: before.totals.itemCount,
        total: before.totals.total,
      }, userId);
      this.#audit.record({
        type: 'SALE_VOIDED', entity: 'sale', entityId: saleId, userId,
        terminalId: sale.terminal_id,
        data: { reason, total: before.totals.total, itemCount: before.totals.itemCount,
                approvedBy: approvedBy ?? null },
      });
      this.#outbox.record({
        type: 'sale.voided',
        entityType: 'sale',
        entityId: before.uid,
        payload: {
          localUid: before.uid, reason, total: before.totals.total,
          itemCount: before.totals.itemCount, approvedBy: approvedBy ?? null,
        },
      });
      return this.view(saleId);
    });
  }

  // --------------------------- Tamamlama ---------------------------

  /**
   * Satisi tamamlar. TEK transaction, idempotent.
   * `expectedTotal` verilirse sunucu hesabi ile karsilastirilir (UI ile sunucu
   * arasinda fiyat degismisse satis yanlis tutarla kapanmaz).
   */
  complete(input: {
    saleId: number;
    payments: readonly PaymentRequest[];
    userId: number;
    idempotencyKey: string;
    expectedTotal?: Money;
    cashSessionId?: number;
  }): CompleteSaleResult {
    const outcome = this.#idempotency.run(
      input.idempotencyKey,
      'sale.complete',
      {
        saleId: input.saleId,
        payments: input.payments.map((p) => ({
          method: p.method, tendered: p.tendered, amount: p.amount ?? null,
        })),
      },
      () => this.#completeInternal(input),
    );
    return outcome.replayed ? { ...outcome.result, replayed: true } : outcome.result;
  }

  #completeInternal(input: {
    saleId: number;
    payments: readonly PaymentRequest[];
    userId: number;
    expectedTotal?: Money;
    cashSessionId?: number;
  }): CompleteSaleResult {
    const sale = this.#requireOpen(input.saleId);
    const view = this.view(input.saleId);

    if (view.totals.itemCount === 0) {
      throw new PosError('SALE_EMPTY', 'Bos fis tamamlanamaz');
    }
    if (input.expectedTotal !== undefined && input.expectedTotal !== view.totals.total) {
      throw new PosError('TOTAL_MISMATCH',
        `Beklenen toplam ${input.expectedTotal}, hesaplanan ${view.totals.total}`, {
          details: { expected: input.expectedTotal, actual: view.totals.total },
        });
    }

    const isRefund = sale.doc_type === 'REFUND';
    const summary = summarizePayments(
      view.totals.total,
      input.payments.map((p) => ({
        method: p.method,
        tendered: p.tendered,
        ...(p.amount !== undefined ? { amount: p.amount } : {}),
      })),
    );
    if (!summary.settled) {
      throw new PosError('PAYMENT_INSUFFICIENT',
        `Kalan tutar: ${summary.remaining}`, { details: { remaining: summary.remaining } });
    }
    if (isRefund && summary.changeDue !== 0) {
      throw new PosError('PAYMENT_INVALID', 'Iade isleminde para ustu olamaz');
    }

    const cashSessionId = input.cashSessionId ?? sale.cash_session_id;
    if (cashSessionId === null || cashSessionId === undefined) {
      throw new PosError('CASH_SESSION_NOT_OPEN', 'Satis bir kasa oturumuna bagli degil');
    }
    const session = this.#db.get<{ id: number; status: string }>(
      'SELECT id, status FROM cash_sessions WHERE id = ?', cashSessionId,
    );
    if (session === undefined || session.status !== 'OPEN') {
      throw new PosError('CASH_SESSION_NOT_OPEN', `Kasa oturumu acik degil: ${cashSessionId}`);
    }

    const now = this.#clock.now();
    const businessDate = this.#clock.businessDate(now);
    const series = this.#options.receiptSeries;
    const receiptNo = this.#db.nextSequence(`receipt:${series}:${sale.terminal_id}`);

    // 1) Satir tutarlarini dondur (fis sonradan yeniden hesaplanmaz)
    for (const line of view.totals.lines) {
      this.#db.run(
        `UPDATE sale_items
            SET gross_amount = ?, discount_amount = ?, sale_discount_share = ?,
                net_amount = ?, tax_amount = ?
          WHERE sale_id = ? AND line_no = ?`,
        line.gross, line.discountAmount, line.saleDiscountShare, line.net, line.taxAmount,
        input.saleId, line.lineNo,
      );
    }

    // 2) Odemeler
    for (const [i, applied] of summary.applied.entries()) {
      this.#db.run(
        `INSERT INTO payments (sale_id, method, amount, tendered, change_given, reference, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.saleId, applied.method, applied.amount, applied.tendered, applied.change,
        input.payments[i]?.reference ?? null, now,
      );
    }

    // 3) Stok
    for (const item of view.items) {
      if (item.voided) continue;
      this.#inventory.record({
        productId: item.productId,
        type: isRefund ? 'RETURN' : 'SALE',
        delta: quantity(isRefund ? item.quantity : -item.quantity),
        saleId: input.saleId,
        saleItemId: item.id,
        userId: input.userId,
        note: `${isRefund ? 'Iade' : 'Satis'} ${series}${receiptNo}`,
      });
    }

    // 4) Kasa hareketi (yalnizca nakit; kart kasaya girmez)
    const cashAmount = summary.applied
      .filter((a) => a.method === 'CASH')
      .reduce((acc, a) => acc + a.amount, 0);
    if (cashAmount !== 0) {
      this.#db.run(
        `INSERT INTO cash_movements (cash_session_id, type, amount, sale_id, user_id, note, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        cashSessionId, isRefund ? 'REFUND' : 'SALE', isRefund ? -cashAmount : cashAmount,
        input.saleId, input.userId, `${series}${receiptNo}`, now,
      );
    }

    // 5) Satis basligi
    this.#db.run(
      `UPDATE sales
          SET status = 'COMPLETED', completed_at = ?, business_date = ?,
              receipt_series = ?, receipt_no = ?, cash_session_id = ?,
              subtotal = ?, discount_total = ?, rounding_adjustment = ?, total = ?,
              tax_total = ?, paid_total = ?, change_due = ?, item_count = ?
        WHERE id = ?`,
      now, businessDate, series, receiptNo, cashSessionId,
      view.totals.subtotal, view.totals.discountTotal, view.totals.roundingAdjustment,
      view.totals.total, view.totals.taxTotal, summary.paidTotal, summary.changeDue,
      view.totals.itemCount, input.saleId,
    );

    // 6) Denetim + olay
    this.#event(input.saleId, 'SALE_COMPLETED', {
      receiptSeries: series, receiptNo, total: view.totals.total,
      paidTotal: summary.paidTotal, changeDue: summary.changeDue,
      payments: summary.applied.map((a) => ({ method: a.method, amount: a.amount })),
    }, input.userId);
    this.#audit.record({
      type: isRefund ? 'REFUND_COMPLETED' : 'SALE_COMPLETED',
      entity: 'sale', entityId: input.saleId, userId: input.userId,
      terminalId: sale.terminal_id,
      data: {
        receipt: `${series}${receiptNo}`, total: view.totals.total,
        itemCount: view.totals.itemCount, taxTotal: view.totals.taxTotal,
        payments: summary.applied.map((a) => ({ method: a.method, amount: a.amount })),
        ...(sale.original_sale_id !== null ? { originalSaleId: sale.original_sale_id } : {}),
      },
    });

    // 7) Merkezi sunucu icin olay (AYNI transaction: satis varsa olay da vardir)
    const frozen = this.view(input.saleId);
    this.#outbox.record({
      type: isRefund ? 'sale.refunded' : 'sale.completed',
      entityType: 'sale',
      entityId: frozen.uid,
      payload: {
        localUid: frozen.uid,
        docType: frozen.docType,
        receiptSeries: series,
        receiptNo,
        businessDate,
        cashierName: this.#db.get<{ display_name: string }>(
          'SELECT display_name FROM users WHERE id = ?', input.userId,
        )?.display_name ?? null,
        localCashSessionId: cashSessionId,
        subtotal: frozen.totals.subtotal,
        discountTotal: frozen.totals.discountTotal,
        roundingAdjustment: frozen.totals.roundingAdjustment,
        total: frozen.totals.total,
        taxTotal: frozen.totals.taxTotal,
        paidTotal: summary.paidTotal,
        changeDue: summary.changeDue,
        itemCount: frozen.totals.itemCount,
        openedAt: new Date(frozen.openedAt).toISOString(),
        completedAt: new Date(now).toISOString(),
        ...(isRefund && sale.original_sale_id !== null
          ? {
              originalLocalUid: this.#db.get<{ uid: string }>(
                'SELECT uid FROM sales WHERE id = ?', sale.original_sale_id,
              )?.uid ?? null,
            }
          : {}),
        lines: frozen.items.filter((i) => !i.voided).map((item) => ({
          lineNo: item.lineNo,
          productCode: this.#db.get<{ code: string }>(
            'SELECT code FROM products WHERE id = ?', item.productId,
          )?.code ?? null,
          name: item.name,
          unit: item.unit,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          gross: item.gross,
          discountAmount: item.discountAmount,
          saleDiscountShare: item.saleDiscountShare,
          net: item.net,
          taxRateBp: item.taxRateBp,
          taxAmount: item.taxAmount,
          priceSource: item.priceSource,
          scanSource: item.scanSource,
          rawBarcode: item.rawBarcode,
        })),
        payments: summary.applied.map((a) => ({
          method: a.method, amount: a.amount, tendered: a.tendered, changeGiven: a.change,
        })),
      },
    });

    // 8) Fis kuyruga (baski basarisiz olsa da satis gecerlidir)
    this.#printQueue?.enqueueReceipt(input.saleId, 'RECEIPT', input.userId);

    return {
      saleId: input.saleId,
      receiptNo,
      receiptSeries: series,
      total: view.totals.total,
      paidTotal: summary.paidTotal,
      changeDue: summary.changeDue,
      completedAt: now,
    };
  }

  // --------------------------- Iade ---------------------------

  /** Tamamlanmis bir satistan iade fisi olusturur (henuz tamamlanmamis) */
  createRefund(input: {
    originalSaleId: number;
    lines: readonly { lineNo: number; quantity?: Quantity }[];
    terminalId: number;
    userId: number;
    cashSessionId: number;
    approvedBy?: number;
  }): SaleView {
    return this.#db.tx(() => {
      const original = this.view(input.originalSaleId);
      if (original.status !== 'COMPLETED') {
        throw new PosError('REFUND_NOT_ALLOWED', 'Yalnizca tamamlanmis satislardan iade yapilir');
      }
      if (original.docType !== 'SALE') {
        throw new PosError('REFUND_NOT_ALLOWED', 'Iade fisinden iade yapilamaz');
      }

      const refund = this.openSale({
        terminalId: input.terminalId,
        userId: input.userId,
        cashSessionId: input.cashSessionId,
        docType: 'REFUND',
        originalSaleId: input.originalSaleId,
      });

      let lineNo = 0;
      for (const request of input.lines) {
        const item = original.items.find((i) => i.lineNo === request.lineNo && !i.voided);
        if (item === undefined) {
          throw new PosError('LINE_NOT_FOUND', `Orijinal satir yok: ${request.lineNo}`);
        }
        const alreadyRefunded = this.#refundedQuantity(item.id);
        const available = quantity(item.quantity - alreadyRefunded);
        const wanted = request.quantity ?? available;
        if (wanted <= 0 || wanted > available) {
          throw new PosError('REFUND_EXCEEDS_ORIGINAL',
            `Iade miktari satilan miktari asiyor (satir ${request.lineNo})`, {
              details: { wanted, available, alreadyRefunded },
            });
        }

        lineNo++;
        // Fiyat ORIJINAL fisten kopyalanir; guncel fiyat kullanilmaz.
        const ratio = item.quantity === 0 ? 0 : wanted / item.quantity;
        const gross = money(Math.round(item.net * ratio));
        this.#db.run(
          `INSERT INTO sale_items
             (sale_id, line_no, product_id, name_snapshot, unit, quantity, unit_price,
              gross_amount, discount_amount, sale_discount_share, net_amount,
              tax_rate_bp, tax_amount, price_source, scan_source, original_item_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 'REFUND_ORIGINAL', 'REFUND', ?, ?)`,
          refund.id, lineNo, item.productId, item.name, item.unit, wanted, item.unitPrice,
          gross, gross, item.taxRateBp, item.id, this.#clock.now(),
        );
      }

      if (lineNo === 0) throw new PosError('SALE_EMPTY', 'Iade edilecek satir yok');

      this.#event(refund.id, 'ITEM_ADDED', {
        refundOf: input.originalSaleId, lineCount: lineNo,
        approvedBy: input.approvedBy ?? null,
      }, input.userId);
      return this.view(refund.id);
    });
  }

  #refundedQuantity(originalItemId: number): number {
    const row = this.#db.get<{ total: number | null }>(
      `SELECT SUM(i.quantity) AS total
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE i.original_item_id = ? AND s.status = 'COMPLETED' AND i.voided_at IS NULL`,
      originalItemId,
    );
    return row?.total ?? 0;
  }

  // --------------------------- Yardimcilar ---------------------------

  #event(saleId: number, type: string, data: Record<string, unknown>, userId?: number): void {
    const seq =
      (this.#db.get<{ n: number | null }>(
        'SELECT MAX(seq) AS n FROM sale_events WHERE sale_id = ?', saleId,
      )?.n ?? 0) + 1;
    this.#db.run(
      'INSERT INTO sale_events (sale_id, seq, type, data_json, user_id, at) VALUES (?, ?, ?, ?, ?, ?)',
      saleId, seq, type, JSON.stringify(data), userId ?? null, this.#clock.now(),
    );
  }

  #touch(saleId: number): void {
    const view = this.view(saleId);
    this.#db.run(
      'UPDATE sales SET subtotal = ?, discount_total = ?, total = ?, tax_total = ?, item_count = ? WHERE id = ?',
      view.totals.subtotal, view.totals.discountTotal, view.totals.total,
      view.totals.taxTotal, view.totals.itemCount, saleId,
    );
  }

  events(saleId: number): { seq: number; type: string; data: unknown; at: number }[] {
    return this.#db
      .all<{ seq: number; type: string; data_json: string; at: number }>(
        'SELECT seq, type, data_json, at FROM sale_events WHERE sale_id = ? ORDER BY seq', saleId,
      )
      .map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.data_json) as unknown, at: r.at }));
  }

  byReceipt(series: string, receiptNo: number): SaleView | undefined {
    const row = this.#db.get<{ id: number }>(
      'SELECT id FROM sales WHERE receipt_series = ? AND receipt_no = ?', series, receiptNo,
    );
    return row === undefined ? undefined : this.view(row.id);
  }

  recent(terminalId: number, limit = 20): SaleView[] {
    return this.#db
      .all<{ id: number }>(
        `SELECT id FROM sales WHERE terminal_id = ? AND status = 'COMPLETED'
          ORDER BY completed_at DESC LIMIT ?`,
        terminalId, limit,
      )
      .map((r) => this.view(r.id));
  }
}
