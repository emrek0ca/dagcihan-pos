/**
 * Senkronizasyon motoru (sunucu tarafi).
 *
 * ILKELER
 *  1. IDEMPOTENCY: her olay istemcinin urettigi `eventId` ile birincil anahtarlanir.
 *     Ayni olay 2, 5 veya 100 kez gonderilse de yalnizca bir kez islenir.
 *  2. SIRA BAGIMSIZLIGI: olaylar sirasiz gelebilir. Isleyiciler upsert tabanlidir;
 *     henuz gelmemis bagimliliklar (orn. kasa oturumu) sonradan baglanir.
 *  3. ATOMIKLIK: olayin kaydi ve etkisi AYNI transaction'dadir. Islenemezse
 *     hicbir kismi etki kalmaz ve olay FAILED olarak isaretlenir.
 *  4. STOK: inventory_ledger ana kayittir; bakiye ondan turetilir.
 */
import type { Database, Queryable } from './db.ts';
import { badRequest, validation } from './lib/errors.ts';
import type { TerminalPrincipal } from './auth.ts';
import type { Logger } from './lib/log.ts';

export type SyncEventType =
  | 'sale.completed'
  | 'sale.voided'
  | 'sale.refunded'
  | 'inventory.adjusted'
  | 'cash_session.opened'
  | 'cash_session.closed'
  | 'cash.movement'
  | 'product.price_changed'
  | 'cashier.upserted';

const KNOWN_TYPES = new Set<string>([
  'sale.completed', 'sale.voided', 'sale.refunded', 'inventory.adjusted',
  'cash_session.opened', 'cash_session.closed', 'cash.movement',
  'product.price_changed', 'cashier.upserted',
]);

export interface IncomingEvent {
  readonly eventId: string;
  readonly type: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export type EventStatus = 'PROCESSED' | 'DUPLICATE' | 'FAILED' | 'IGNORED';

export interface EventResult {
  readonly eventId: string;
  readonly status: EventStatus;
  readonly error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function int(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw validation(`${field} zorunlu`);
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw validation(`${field} tam sayi olmali`, { field, value });
  }
  return n;
}

function text(value: unknown, field: string, fallback?: string): string {
  if (typeof value === 'string' && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw validation(`${field} zorunlu`, { field });
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function when(value: unknown, field: string): Date {
  const raw = text(value, field);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw validation(`${field} gecerli tarih olmali`, { field });
  return date;
}

export function validateEvent(event: unknown): IncomingEvent {
  if (typeof event !== 'object' || event === null) throw badRequest('Olay nesnesi bekleniyor');
  const e = event as Record<string, unknown>;
  const eventId = text(e.eventId, 'eventId');
  if (!UUID_RE.test(eventId)) throw validation('eventId UUID olmali', { eventId });
  const type = text(e.type, 'type');
  if (!KNOWN_TYPES.has(type)) throw validation(`Bilinmeyen olay turu: ${type}`, { type });
  return {
    eventId,
    type,
    ...(optionalText(e.entityType) !== null ? { entityType: e.entityType as string } : {}),
    ...(optionalText(e.entityId) !== null ? { entityId: e.entityId as string } : {}),
    sequence: int(e.sequence, 'sequence', 0),
    occurredAt: when(e.occurredAt, 'occurredAt').toISOString(),
    payload: (typeof e.payload === 'object' && e.payload !== null
      ? e.payload : {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------- yardimcilar

async function defaultLocation(tx: Queryable, storeId: string): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `SELECT id FROM inventory_locations
      WHERE store_id = $1 AND kind = 'STORE' AND active
      ORDER BY created_at LIMIT 1`,
    [storeId],
  );
  if (row !== undefined) return row.id;
  const created = await tx.one<{ id: string }>(
    `INSERT INTO inventory_locations (store_id, code, name, kind)
     VALUES ($1, 'MAGAZA', 'Magaza Rafi', 'STORE') RETURNING id`,
    [storeId],
  );
  return created!.id;
}

async function findProduct(
  tx: Queryable, organizationId: string, code: string | null, barcode: string | null,
): Promise<{ id: string } | undefined> {
  if (code !== null) {
    const byCode = await tx.one<{ id: string }>(
      'SELECT id FROM products WHERE organization_id = $1 AND code = $2 AND deleted_at IS NULL',
      [organizationId, code],
    );
    if (byCode !== undefined) return byCode;
  }
  if (barcode !== null) {
    return tx.one<{ id: string }>(
      `SELECT p.id FROM product_barcodes b JOIN products p ON p.id = b.product_id
        WHERE p.organization_id = $1 AND b.barcode = $2 AND p.deleted_at IS NULL`,
      [organizationId, barcode],
    );
  }
  return undefined;
}

/**
 * Ledger'a yaz ve bakiyeyi guncelle.
 * `event_id + product + movement_type` benzersizdir: ayni olay iki kez islenirse
 * stok iki kez dusmez (ON CONFLICT DO NOTHING).
 */
async function writeLedger(
  tx: Queryable,
  input: {
    locationId: string; productId: string; movementType: string; delta: number;
    referenceType: string; referenceId: string; terminalId: string | null;
    eventId: string; occurredAt: string; note?: string;
  },
): Promise<boolean> {
  const inserted = await tx.exec(
    `INSERT INTO inventory_ledger
       (location_id, product_id, movement_type, quantity_delta, reference_type,
        reference_id, terminal_id, event_id, note, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (event_id, product_id, movement_type) WHERE event_id IS NOT NULL
     DO NOTHING`,
    [
      input.locationId, input.productId, input.movementType, input.delta,
      input.referenceType, input.referenceId, input.terminalId, input.eventId,
      input.note ?? null, input.occurredAt,
    ],
  );
  if (inserted === 0) return false;

  await tx.exec(
    `INSERT INTO inventory_balances (location_id, product_id, on_hand, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (location_id, product_id)
     DO UPDATE SET on_hand = inventory_balances.on_hand + EXCLUDED.on_hand, updated_at = now()`,
    [input.locationId, input.productId, input.delta],
  );
  return true;
}

async function audit(
  tx: Queryable,
  input: {
    organizationId: string; storeId: string; terminalId: string | null;
    action: string; entityType?: string; entityId?: string;
    before?: unknown; after?: unknown; requestId?: string;
  },
): Promise<void> {
  await tx.exec(
    `INSERT INTO audit_log
       (organization_id, store_id, terminal_id, actor_type, actor_id, action,
        entity_type, entity_id, before_state, after_state, request_id)
     VALUES ($1,$2,$3,'TERMINAL',$4::text,$5,$6,$7,$8,$9,$10)`,
    [
      input.organizationId, input.storeId, input.terminalId, input.terminalId,
      input.action, input.entityType ?? null, input.entityId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.requestId ?? null,
    ],
  );
}

async function publishChange(
  tx: Queryable,
  input: {
    organizationId: string; storeId: string | null; entityType: string;
    entityId: string; operation: 'UPSERT' | 'DELETE'; payload: unknown;
  },
): Promise<void> {
  await tx.exec(
    `INSERT INTO change_log (organization_id, store_id, entity_type, entity_id, operation, payload)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.organizationId, input.storeId, input.entityType, input.entityId,
      input.operation, JSON.stringify(input.payload),
    ],
  );
}

// ---------------------------------------------------------------- isleyiciler

type HandlerContext = {
  tx: Queryable;
  terminal: TerminalPrincipal;
  event: IncomingEvent;
  log: Logger;
};

async function handleSaleCompleted(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const { tx, terminal, event } = ctx;
  const p = event.payload;
  const localUid = text(p.localUid, 'payload.localUid');
  const docType = text(p.docType, 'payload.docType', 'SALE');
  if (docType !== 'SALE' && docType !== 'REFUND') {
    throw validation('docType SALE veya REFUND olmali');
  }

  // Ayni fis daha once yazildiysa yeniden yazma (idempotency ikinci savunma hatti)
  const existing = await tx.one<{ id: string }>(
    'SELECT id FROM sales WHERE terminal_id = $1 AND local_uid = $2',
    [terminal.terminalId, localUid],
  );
  if (existing !== undefined) return { saleId: existing.id, duplicate: true };

  const cashSession = p.localCashSessionId === undefined || p.localCashSessionId === null
    ? null
    : await tx.one<{ id: string }>(
        'SELECT id FROM cash_sessions WHERE terminal_id = $1 AND local_id = $2',
        [terminal.terminalId, int(p.localCashSessionId, 'payload.localCashSessionId')],
      );

  const sale = await tx.one<{ id: string }>(
    `INSERT INTO sales
       (organization_id, store_id, terminal_id, source, local_uid, doc_type, status,
        receipt_series, receipt_no, business_date, cashier_name, cash_session_id,
        local_cash_session_id, subtotal, discount_total, rounding_adjustment, total,
        tax_total, paid_total, change_due, item_count, opened_at, completed_at)
     VALUES ($1,$2,$3,'POS',$4,$5,'COMPLETED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id`,
    [
      terminal.organizationId, terminal.storeId, terminal.terminalId, localUid, docType,
      optionalText(p.receiptSeries), p.receiptNo === undefined ? null : int(p.receiptNo, 'receiptNo'),
      optionalText(p.businessDate), optionalText(p.cashierName),
      cashSession?.id ?? null,
      p.localCashSessionId === undefined || p.localCashSessionId === null
        ? null : int(p.localCashSessionId, 'localCashSessionId'),
      int(p.subtotal, 'subtotal', 0), int(p.discountTotal, 'discountTotal', 0),
      int(p.roundingAdjustment, 'roundingAdjustment', 0), int(p.total, 'total'),
      int(p.taxTotal, 'taxTotal', 0), int(p.paidTotal, 'paidTotal', 0),
      int(p.changeDue, 'changeDue', 0), int(p.itemCount, 'itemCount', 0),
      optionalText(p.openedAt), when(p.completedAt ?? event.occurredAt, 'completedAt'),
    ],
  );
  const saleId = sale!.id;

  const locationId = await defaultLocation(tx, terminal.storeId);
  const lines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]) : [];
  const unmatched: string[] = [];

  for (const line of lines) {
    const productCode = optionalText(line.productCode);
    const barcode = optionalText(line.rawBarcode);
    const product = await findProduct(tx, terminal.organizationId, productCode, barcode);
    if (product === undefined && productCode !== null) unmatched.push(productCode);

    const quantity = int(line.quantity, 'line.quantity');
    await tx.exec(
      `INSERT INTO sale_lines
         (sale_id, line_no, product_id, product_code, name_snapshot, unit, quantity,
          unit_price, gross_amount, discount_amount, sale_discount_share, net_amount,
          tax_rate_bp, tax_amount, price_source, scan_source, raw_barcode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        saleId, int(line.lineNo, 'line.lineNo'), product?.id ?? null, productCode,
        text(line.name, 'line.name'), text(line.unit, 'line.unit', 'EACH'), quantity,
        int(line.unitPrice, 'line.unitPrice'), int(line.gross, 'line.gross'),
        int(line.discountAmount, 'line.discountAmount', 0),
        int(line.saleDiscountShare, 'line.saleDiscountShare', 0),
        int(line.net, 'line.net'), int(line.taxRateBp, 'line.taxRateBp', 0),
        int(line.taxAmount, 'line.taxAmount', 0),
        optionalText(line.priceSource), optionalText(line.scanSource), barcode,
      ],
    );

    // Stok hareketi: satista azalir, iade fisinde artar
    if (product !== undefined) {
      await writeLedger(tx, {
        locationId,
        productId: product.id,
        movementType: docType === 'REFUND' ? 'REFUND' : 'SALE',
        delta: docType === 'REFUND' ? quantity : -quantity,
        referenceType: 'sale',
        referenceId: saleId,
        terminalId: terminal.terminalId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
      });
    }
  }

  for (const payment of (Array.isArray(p.payments) ? p.payments : []) as Record<string, unknown>[]) {
    await tx.exec(
      `INSERT INTO payments (sale_id, method, amount, tendered, change_given, reference)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        saleId, text(payment.method, 'payment.method'), int(payment.amount, 'payment.amount'),
        int(payment.tendered, 'payment.tendered', int(payment.amount, 'payment.amount')),
        int(payment.changeGiven, 'payment.changeGiven', 0), optionalText(payment.reference),
      ],
    );
  }

  if (docType === 'REFUND') {
    const originalLocalUid = optionalText(p.originalLocalUid);
    const original = originalLocalUid === null ? undefined : await tx.one<{ id: string }>(
      'SELECT id FROM sales WHERE terminal_id = $1 AND local_uid = $2',
      [terminal.terminalId, originalLocalUid],
    );
    if (original !== undefined) {
      await tx.exec('UPDATE sales SET original_sale_id = $1 WHERE id = $2', [original.id, saleId]);
    }
    await tx.exec(
      `INSERT INTO refunds (refund_sale_id, original_sale_id, reason, approved_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT (refund_sale_id) DO NOTHING`,
      [saleId, original?.id ?? null, optionalText(p.reason), optionalText(p.approvedBy)],
    );
    await audit(ctx.tx, {
      organizationId: terminal.organizationId, storeId: terminal.storeId,
      terminalId: terminal.terminalId, action: 'refund.recorded',
      entityType: 'sale', entityId: saleId, after: { total: int(p.total, 'total') },
    });
  }

  // Kasa nakit hareketi
  if (cashSession !== null && cashSession !== undefined) {
    const cashAmount = (Array.isArray(p.payments) ? p.payments : [])
      .filter((x) => (x as Record<string, unknown>).method === 'CASH')
      .reduce((sum, x) => sum + int((x as Record<string, unknown>).amount, 'amount'), 0);
    if (cashAmount !== 0) {
      await tx.exec(
        `INSERT INTO cash_movements (cash_session_id, type, amount, sale_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          cashSession.id, docType === 'REFUND' ? 'REFUND' : 'SALE',
          docType === 'REFUND' ? -cashAmount : cashAmount, saleId, event.occurredAt,
        ],
      );
    }
  }

  return {
    saleId,
    lines: lines.length,
    ...(unmatched.length > 0 ? { unmatchedProducts: unmatched } : {}),
  };
}

async function handleSaleVoided(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const { tx, terminal, event } = ctx;
  const localUid = text(event.payload.localUid, 'payload.localUid');
  await audit(tx, {
    organizationId: terminal.organizationId, storeId: terminal.storeId,
    terminalId: terminal.terminalId, action: 'sale.voided',
    entityType: 'sale', entityId: localUid,
    after: { reason: optionalText(event.payload.reason), total: event.payload.total ?? null },
  });
  return { recorded: true };
}

async function handleInventoryAdjusted(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const { tx, terminal, event } = ctx;
  const p = event.payload;
  const productCode = text(p.productCode, 'payload.productCode');
  const product = await findProduct(tx, terminal.organizationId, productCode, null);
  if (product === undefined) {
    // Merkezi katalogda yoksa stok yazilamaz; olay yok sayilir ama denetime dusler.
    await audit(tx, {
      organizationId: terminal.organizationId, storeId: terminal.storeId,
      terminalId: terminal.terminalId, action: 'inventory.adjust.unmatched',
      entityType: 'product', entityId: productCode, after: p,
    });
    return { skipped: 'urun merkezi katalogda yok', productCode };
  }
  const locationId = await defaultLocation(tx, terminal.storeId);
  const applied = await writeLedger(tx, {
    locationId,
    productId: product.id,
    movementType: text(p.movementType, 'payload.movementType', 'ADJUSTMENT'),
    delta: int(p.delta, 'payload.delta'),
    referenceType: 'pos-adjustment',
    referenceId: text(p.reference, 'payload.reference', event.eventId),
    terminalId: terminal.terminalId,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    ...(optionalText(p.note) !== null ? { note: p.note as string } : {}),
  });
  await audit(tx, {
    organizationId: terminal.organizationId, storeId: terminal.storeId,
    terminalId: terminal.terminalId, action: 'inventory.adjusted',
    entityType: 'product', entityId: product.id,
    after: { delta: int(p.delta, 'payload.delta'), note: optionalText(p.note) },
  });
  return { applied, productId: product.id };
}

async function handleCashSession(ctx: HandlerContext, closing: boolean): Promise<Record<string, unknown>> {
  const { tx, terminal, event } = ctx;
  const p = event.payload;
  const localId = int(p.localId, 'payload.localId');

  const row = await tx.one<{ id: string }>(
    `INSERT INTO cash_sessions
       (store_id, terminal_id, local_id, business_date, status, opened_by, opened_at,
        opening_float, closed_by, closed_at, counted_cash, expected_cash, variance, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     -- Kismi (partial) benzersiz index oldugu icin ON CONFLICT ayni kosulu icermelidir
     ON CONFLICT (terminal_id, local_id) WHERE terminal_id IS NOT NULL AND local_id IS NOT NULL
     DO UPDATE SET
       status        = EXCLUDED.status,
       closed_by     = COALESCE(EXCLUDED.closed_by, cash_sessions.closed_by),
       closed_at     = COALESCE(EXCLUDED.closed_at, cash_sessions.closed_at),
       counted_cash  = COALESCE(EXCLUDED.counted_cash, cash_sessions.counted_cash),
       expected_cash = COALESCE(EXCLUDED.expected_cash, cash_sessions.expected_cash),
       variance      = COALESCE(EXCLUDED.variance, cash_sessions.variance)
     RETURNING id`,
    [
      terminal.storeId, terminal.terminalId, localId,
      text(p.businessDate, 'payload.businessDate'),
      closing ? 'CLOSED' : 'OPEN',
      optionalText(p.openedBy), when(p.openedAt ?? event.occurredAt, 'openedAt'),
      int(p.openingFloat, 'payload.openingFloat', 0),
      optionalText(p.closedBy), closing ? when(p.closedAt ?? event.occurredAt, 'closedAt') : null,
      p.countedCash === undefined || p.countedCash === null ? null : int(p.countedCash, 'countedCash'),
      p.expectedCash === undefined || p.expectedCash === null ? null : int(p.expectedCash, 'expectedCash'),
      p.variance === undefined || p.variance === null ? null : int(p.variance, 'variance'),
      optionalText(p.note),
    ],
  );

  // Oturum satistan SONRA geldiyse, bekleyen satislari simdi bagla (sira bagimsizligi)
  await tx.exec(
    `UPDATE sales SET cash_session_id = $1
      WHERE terminal_id = $2 AND local_cash_session_id = $3 AND cash_session_id IS NULL`,
    [row!.id, terminal.terminalId, localId],
  );

  // Ve o satislarin EKSIK kalan nakit hareketlerini olustur.
  // (Satis olayi oturumdan once islendiginde hareket atlanmis olur.)
  // NOT EXISTS sayesinde islem tekrarlanabilir: cift hareket olusmaz.
  await tx.exec(
    `INSERT INTO cash_movements (cash_session_id, type, amount, sale_id, occurred_at)
     SELECT $1,
            CASE WHEN s.doc_type = 'REFUND' THEN 'REFUND' ELSE 'SALE' END,
            CASE WHEN s.doc_type = 'REFUND' THEN -x.cash ELSE x.cash END,
            s.id, s.completed_at
       FROM sales s
       JOIN LATERAL (
            SELECT COALESCE(SUM(p.amount), 0) AS cash FROM payments p
             WHERE p.sale_id = s.id AND p.method = 'CASH'
       ) x ON true
      WHERE s.cash_session_id = $1 AND x.cash <> 0
        AND NOT EXISTS (SELECT 1 FROM cash_movements m WHERE m.sale_id = s.id)`,
    [row!.id],
  );

  await audit(tx, {
    organizationId: terminal.organizationId, storeId: terminal.storeId,
    terminalId: terminal.terminalId,
    action: closing ? 'cash_session.closed' : 'cash_session.opened',
    entityType: 'cash_session', entityId: row!.id,
    after: {
      openingFloat: p.openingFloat ?? null, countedCash: p.countedCash ?? null,
      variance: p.variance ?? null,
    },
  });
  return { cashSessionId: row!.id };
}

async function handleCashMovement(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const { tx, terminal, event } = ctx;
  const p = event.payload;
  const session = await tx.one<{ id: string }>(
    'SELECT id FROM cash_sessions WHERE terminal_id = $1 AND local_id = $2',
    [terminal.terminalId, int(p.localSessionId, 'payload.localSessionId')],
  );
  if (session === undefined) {
    return { skipped: 'kasa oturumu henuz senkronize edilmedi' };
  }
  await tx.exec(
    `INSERT INTO cash_movements (cash_session_id, type, amount, note, occurred_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      session.id, text(p.type, 'payload.type'), int(p.amount, 'payload.amount'),
      optionalText(p.note), event.occurredAt,
    ],
  );
  return { cashSessionId: session.id };
}

async function handlePriceChanged(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const { tx, terminal, event } = ctx;
  const p = event.payload;
  const productCode = text(p.productCode, 'payload.productCode');
  const newPrice = int(p.newPrice, 'payload.newPrice');
  const product = await findProduct(tx, terminal.organizationId, productCode, null);
  if (product === undefined) return { skipped: 'urun merkezi katalogda yok', productCode };

  const current = await tx.one<{ id: string; unit_price: number }>(
    `SELECT id, unit_price FROM prices
      WHERE product_id = $1 AND store_id IS NULL AND valid_to IS NULL`,
    [product.id],
  );
  if (current !== undefined && current.unit_price === newPrice) {
    return { unchanged: true, productId: product.id };
  }
  if (current !== undefined) {
    await tx.exec('UPDATE prices SET valid_to = now() WHERE id = $1', [current.id]);
  }
  await tx.exec(
    'INSERT INTO prices (product_id, store_id, unit_price) VALUES ($1, NULL, $2)',
    [product.id, newPrice],
  );
  await tx.exec(
    `INSERT INTO price_history (product_id, old_price, new_price, reason, source)
     VALUES ($1,$2,$3,$4,'POS')`,
    [product.id, current?.unit_price ?? null, newPrice, optionalText(p.reason)],
  );
  await tx.exec('UPDATE products SET version = version + 1, updated_at = now() WHERE id = $1',
    [product.id]);
  await publishChange(tx, {
    organizationId: terminal.organizationId, storeId: null, entityType: 'price',
    entityId: product.id, operation: 'UPSERT',
    payload: { productCode, unitPrice: newPrice },
  });
  await audit(tx, {
    organizationId: terminal.organizationId, storeId: terminal.storeId,
    terminalId: terminal.terminalId, action: 'price.changed',
    entityType: 'product', entityId: product.id,
    before: { unitPrice: current?.unit_price ?? null }, after: { unitPrice: newPrice },
  });
  return { productId: product.id, newPrice };
}

async function handleCashierUpserted(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const { tx, terminal, event } = ctx;
  const p = event.payload;
  const row = await tx.one<{ id: string }>(
    `INSERT INTO cashiers (store_id, local_user_id, username, display_name, role_code, active)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (store_id, username) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       role_code    = EXCLUDED.role_code,
       active       = EXCLUDED.active,
       local_user_id= EXCLUDED.local_user_id,
       updated_at   = now()
     RETURNING id`,
    [
      terminal.storeId,
      p.localUserId === undefined ? null : int(p.localUserId, 'payload.localUserId'),
      text(p.username, 'payload.username'), text(p.displayName, 'payload.displayName'),
      (text(p.role, 'payload.role', 'CASHIER')).toLowerCase(),
      p.active !== false,
    ],
  );
  return { cashierId: row!.id };
}

const HANDLERS: Record<string, (ctx: HandlerContext) => Promise<Record<string, unknown>>> = {
  'sale.completed': handleSaleCompleted,
  'sale.refunded': handleSaleCompleted,
  'sale.voided': handleSaleVoided,
  'inventory.adjusted': handleInventoryAdjusted,
  'cash_session.opened': (ctx) => handleCashSession(ctx, false),
  'cash_session.closed': (ctx) => handleCashSession(ctx, true),
  'cash.movement': handleCashMovement,
  'product.price_changed': handlePriceChanged,
  'cashier.upserted': handleCashierUpserted,
};

// ---------------------------------------------------------------- giris noktasi

export async function processEvents(
  db: Database,
  terminal: TerminalPrincipal,
  events: readonly IncomingEvent[],
  log: Logger,
): Promise<EventResult[]> {
  const results: EventResult[] = [];

  for (const event of events) {
    try {
      const result = await db.tx(async (tx) => {
        // 1) Olayi kaydet. Ayni eventId ikinci kez gelirse hicbir sey yapilmaz.
        const inserted = await tx.exec(
          `INSERT INTO sync_events
             (event_id, terminal_id, store_id, event_type, entity_type, entity_id,
              local_sequence, occurred_at, payload, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIVED')
           ON CONFLICT (event_id) DO NOTHING`,
          [
            event.eventId, terminal.terminalId, terminal.storeId, event.type,
            event.entityType ?? null, event.entityId ?? null, event.sequence,
            event.occurredAt, JSON.stringify(event.payload),
          ],
        );
        if (inserted === 0) {
          // Olay daha once GORULMUS. Ancak idempotency yalnizca BASARIYLA
          // ISLENMIS olaylar icin gecerlidir: onceki denemede hata alan bir olay
          // "duplicate" sayilirsa istemci onu gonderilmis kabul eder ve olay
          // KALICI OLARAK KAYBOLUR. Bu yuzden durum kontrol edilir.
          const existing = await tx.one<{ status: string }>(
            'SELECT status FROM sync_events WHERE event_id = $1 FOR UPDATE', [event.eventId],
          );
          if (existing?.status === 'PROCESSED' || existing?.status === 'IGNORED') {
            return { status: 'DUPLICATE' as EventStatus };
          }
          // FAILED / RECEIVED: yeniden islenecek
          await tx.exec(
            `UPDATE sync_events SET payload = $2, occurred_at = $3, attempts = attempts + 1
              WHERE event_id = $1`,
            [event.eventId, JSON.stringify(event.payload), event.occurredAt],
          );
        }

        // 2) Isle. Hata olursa transaction geri alinir; olay kaydi da silinir
        //    ve istemci yeniden gonderebilir.
        const handler = HANDLERS[event.type];
        if (handler === undefined) {
          await tx.exec(
            "UPDATE sync_events SET status='IGNORED', processed_at=now() WHERE event_id=$1",
            [event.eventId],
          );
          return { status: 'IGNORED' as EventStatus };
        }
        const outcome = await handler({ tx, terminal, event, log });
        await tx.exec(
          `UPDATE sync_events SET status='PROCESSED', processed_at=now(), result=$2
            WHERE event_id=$1`,
          [event.eventId, JSON.stringify(outcome)],
        );
        await tx.exec(
          `INSERT INTO device_sync_state (terminal_id, last_local_sequence, last_push_at)
           VALUES ($1,$2,now())
           ON CONFLICT (terminal_id) DO UPDATE SET
             last_local_sequence = GREATEST(device_sync_state.last_local_sequence, EXCLUDED.last_local_sequence),
             last_push_at = now(), updated_at = now()`,
          [terminal.terminalId, event.sequence],
        );
        return { status: 'PROCESSED' as EventStatus };
      });
      results.push({ eventId: event.eventId, status: result.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Olay islenemedi', error, { eventId: event.eventId, type: event.type });
      // Basarisiz olay AYRI bir transaction'da isaretlenir (asil transaction geri alindi)
      await db.exec(
        `INSERT INTO sync_events
           (event_id, terminal_id, store_id, event_type, local_sequence, occurred_at,
            payload, status, attempts, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'FAILED',1,$8)
         ON CONFLICT (event_id) DO UPDATE SET
           status='FAILED', attempts = sync_events.attempts + 1, error = EXCLUDED.error`,
        [
          event.eventId, terminal.terminalId, terminal.storeId, event.type,
          event.sequence, event.occurredAt, JSON.stringify(event.payload), message.slice(0, 500),
        ],
      ).catch(() => undefined);
      results.push({ eventId: event.eventId, status: 'FAILED', error: message.slice(0, 300) });
    }
  }
  return results;
}
