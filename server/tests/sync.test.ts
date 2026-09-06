import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database, migrate } from '../src/db.ts';
import { Logger } from '../src/lib/log.ts';
import { processEvents, validateEvent, type IncomingEvent } from '../src/sync.ts';
import { generateToken, hashPassword } from '../src/lib/crypto.ts';
import type { TerminalPrincipal } from '../src/auth.ts';

/**
 * Merkezi sunucu senkronizasyon testleri (GERCEK PostgreSQL).
 * DATABASE_URL test veritabanina isaret etmelidir.
 */

const logger = new Logger('error', { service: 'test' });
let db: Database;
let organizationId: string;
let storeId: string;
let terminalA: TerminalPrincipal;
let terminalB: TerminalPrincipal;

function principal(terminalId: string, code: string): TerminalPrincipal {
  return {
    kind: 'TERMINAL',
    terminalId,
    terminalCode: code,
    storeId,
    organizationId,
    permissions: new Set(['sync.push', 'sync.pull', 'sales.write', 'cash.write', 'catalog.read']),
    tokenId: randomUUID(),
  };
}

before(async () => {
  db = new Database({ connectionString: process.env.DATABASE_URL!, max: 5, logger });
  await migrate(db, logger);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  // Her test temiz bir organizasyonla calisir
  await db.exec(`TRUNCATE organizations, sync_events, change_log, audit_log,
                 idempotency_keys RESTART IDENTITY CASCADE`);
  const org = await db.one<{ id: string }>(
    "INSERT INTO organizations (code, name) VALUES ('TEST','Test') RETURNING id");
  organizationId = org!.id;
  const store = await db.one<{ id: string }>(
    "INSERT INTO stores (organization_id, code, name) VALUES ($1,'S1','Magaza') RETURNING id",
    [organizationId]);
  storeId = store!.id;
  await db.exec(
    `INSERT INTO inventory_locations (store_id, code, name, kind)
     VALUES ($1,'MAGAZA','Raf','STORE')`, [storeId]);
  const a = await db.one<{ id: string }>(
    `INSERT INTO terminals (store_id, code, name, activation_state)
     VALUES ($1,'KASA-1','Kasa 1','ACTIVE') RETURNING id`, [storeId]);
  const b = await db.one<{ id: string }>(
    `INSERT INTO terminals (store_id, code, name, activation_state)
     VALUES ($1,'KASA-2','Kasa 2','ACTIVE') RETURNING id`, [storeId]);
  terminalA = principal(a!.id, 'KASA-1');
  terminalB = principal(b!.id, 'KASA-2');

  await db.exec(
    `INSERT INTO products (organization_id, code, name, unit, tax_rate_bp)
     VALUES ($1,'S001','Su','EACH',1000), ($1,'F001','Findik','KG',100)`,
    [organizationId]);
});

function saleEvent(overrides: Partial<IncomingEvent> & { localUid?: string } = {}): IncomingEvent {
  const localUid = overrides.localUid ?? randomUUID();
  return validateEvent({
    eventId: overrides.eventId ?? randomUUID(),
    type: 'sale.completed',
    entityType: 'sale',
    entityId: localUid,
    sequence: overrides.sequence ?? 1,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    payload: {
      localUid,
      docType: 'SALE',
      receiptSeries: 'A',
      receiptNo: Math.floor(Math.random() * 1_000_000),
      businessDate: '2026-09-06',
      total: 1500, subtotal: 1500, taxTotal: 136, paidTotal: 1500,
      changeDue: 500, itemCount: 1,
      completedAt: new Date().toISOString(),
      localCashSessionId: 1,
      lines: [{
        lineNo: 1, productCode: 'S001', name: 'Su', unit: 'EACH',
        quantity: 2000, unitPrice: 750, gross: 1500, net: 1500,
        taxRateBp: 1000, taxAmount: 136,
      }],
      payments: [{ method: 'CASH', amount: 1500, tendered: 2000, changeGiven: 500 }],
      ...(overrides.payload ?? {}),
    },
  });
}

describe('idempotency', () => {
  test('ayni olay 10 kez gonderilse de tek satis olusur', async () => {
    const event = saleEvent();
    for (let i = 0; i < 10; i++) {
      await processEvents(db, terminalA, [event], logger);
    }
    const count = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM sales");
    assert.equal(count!.n, 1);
    const lines = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sale_lines');
    assert.equal(lines!.n, 1);
    const payments = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM payments');
    assert.equal(payments!.n, 1);
    const ledger = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM inventory_ledger');
    assert.equal(ledger!.n, 1, 'stok yalnizca bir kez dusmeli');
  });

  test('ilk gonderim PROCESSED, sonrakiler DUPLICATE doner', async () => {
    const event = saleEvent();
    const first = await processEvents(db, terminalA, [event], logger);
    const second = await processEvents(db, terminalA, [event], logger);
    assert.equal(first[0]!.status, 'PROCESSED');
    assert.equal(second[0]!.status, 'DUPLICATE');
  });

  test('ayni fis farkli eventId ile gelse bile mukerrer satis olmaz', async () => {
    const localUid = randomUUID();
    await processEvents(db, terminalA, [saleEvent({ localUid })], logger);
    await processEvents(db, terminalA, [saleEvent({ localUid })], logger);
    const count = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sales');
    assert.equal(count!.n, 1, 'terminal+local_uid benzersizligi korumali');
  });

  test('BASARISIZ olay yeniden gonderilebilir (duplicate sayilmaz)', async () => {
    // Gecersiz yuk -> islenemez
    const bad = validateEvent({
      eventId: randomUUID(), type: 'sale.completed', sequence: 1,
      occurredAt: new Date().toISOString(), payload: { docType: 'SALE' },
    });
    const first = await processEvents(db, terminalA, [bad], logger);
    assert.equal(first[0]!.status, 'FAILED');

    // Ayni eventId, DUZELTILMIS yuk ile tekrar gonderilir
    const fixed = saleEvent({ eventId: bad.eventId });
    const second = await processEvents(db, terminalA, [fixed], logger);
    assert.equal(second[0]!.status, 'PROCESSED', 'hatali olay yeniden islenebilmeli');
    const count = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sales');
    assert.equal(count!.n, 1);
  });
});

describe('sira bagimsizligi', () => {
  test('satis kasa oturumundan ONCE gelirse sonradan baglanir', async () => {
    const sale = saleEvent();
    await processEvents(db, terminalA, [sale], logger);
    let row = await db.one<{ cash_session_id: string | null }>(
      'SELECT cash_session_id FROM sales LIMIT 1');
    assert.equal(row!.cash_session_id, null, 'oturum yokken bos kalmali');

    const session = validateEvent({
      eventId: randomUUID(), type: 'cash_session.opened', sequence: 2,
      occurredAt: new Date().toISOString(),
      payload: { localId: 1, businessDate: '2026-09-06', openingFloat: 20000,
                 openedAt: new Date().toISOString() },
    });
    await processEvents(db, terminalA, [session], logger);

    row = await db.one<{ cash_session_id: string | null }>(
      'SELECT cash_session_id FROM sales LIMIT 1');
    assert.notEqual(row!.cash_session_id, null, 'oturum gelince baglanmali');

    const movements = await db.one<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM cash_movements');
    assert.equal(movements!.n, 1, 'eksik nakit hareketi telafi edilmeli');
  });

  test('kasa oturumu once gelirse satis dogrudan baglanir', async () => {
    await processEvents(db, terminalA, [validateEvent({
      eventId: randomUUID(), type: 'cash_session.opened', sequence: 1,
      occurredAt: new Date().toISOString(),
      payload: { localId: 1, businessDate: '2026-09-06', openingFloat: 20000,
                 openedAt: new Date().toISOString() },
    })], logger);
    await processEvents(db, terminalA, [saleEvent()], logger);
    const row = await db.one<{ cash_session_id: string | null }>(
      'SELECT cash_session_id FROM sales LIMIT 1');
    assert.notEqual(row!.cash_session_id, null);
  });

  test('ayni kasa oturumu olayi iki kez gelirse tek oturum olur', async () => {
    const event = validateEvent({
      eventId: randomUUID(), type: 'cash_session.opened', sequence: 1,
      occurredAt: new Date().toISOString(),
      payload: { localId: 7, businessDate: '2026-09-06', openingFloat: 5000,
                 openedAt: new Date().toISOString() },
    });
    await processEvents(db, terminalA, [event], logger);
    await processEvents(db, terminalA, [{ ...event, eventId: randomUUID() }], logger);
    const count = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM cash_sessions');
    assert.equal(count!.n, 1);
  });
});

describe('coklu terminal', () => {
  test('iki terminal ayni anda senkronize olabilir, veriler karismaz', async () => {
    const eventsA = Array.from({ length: 5 }, (_, i) => saleEvent({ sequence: i + 1 }));
    const eventsB = Array.from({ length: 5 }, (_, i) => saleEvent({ sequence: i + 1 }));
    await Promise.all([
      processEvents(db, terminalA, eventsA, logger),
      processEvents(db, terminalB, eventsB, logger),
    ]);
    const total = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sales');
    assert.equal(total!.n, 10);
    const perTerminal = await db.query<{ terminal_id: string; n: number }>(
      'SELECT terminal_id, COUNT(*)::int AS n FROM sales GROUP BY terminal_id');
    assert.equal(perTerminal.length, 2);
    for (const row of perTerminal) assert.equal(row.n, 5);
  });

  test('farkli terminaller ayni local_uid kullanabilir', async () => {
    const localUid = 'ayni-uid';
    await processEvents(db, terminalA, [saleEvent({ localUid })], logger);
    await processEvents(db, terminalB, [saleEvent({ localUid })], logger);
    const count = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sales');
    assert.equal(count!.n, 2, 'benzersizlik terminal basinadir');
  });
});

describe('stok defteri', () => {
  test('satis stogu dusurur, iade geri ekler', async () => {
    await processEvents(db, terminalA, [saleEvent()], logger);
    let balance = await db.one<{ on_hand: number }>(
      `SELECT on_hand FROM inventory_balances b JOIN products p ON p.id=b.product_id
        WHERE p.code='S001'`);
    assert.equal(balance!.on_hand, -2000);

    const refund = validateEvent({
      eventId: randomUUID(), type: 'sale.refunded', sequence: 2,
      occurredAt: new Date().toISOString(),
      payload: {
        localUid: randomUUID(), docType: 'REFUND', total: 1500, itemCount: 1,
        completedAt: new Date().toISOString(),
        lines: [{ lineNo: 1, productCode: 'S001', name: 'Su', unit: 'EACH',
                  quantity: 2000, unitPrice: 750, gross: 1500, net: 1500 }],
        payments: [{ method: 'CASH', amount: 1500, tendered: 1500 }],
      },
    });
    await processEvents(db, terminalA, [refund], logger);
    balance = await db.one<{ on_hand: number }>(
      `SELECT on_hand FROM inventory_balances b JOIN products p ON p.id=b.product_id
        WHERE p.code='S001'`);
    assert.equal(balance!.on_hand, 0, 'iade stogu geri eklemeli');
  });

  test('bakiye defterden turetilebilir (tutarlilik)', async () => {
    for (let i = 0; i < 5; i++) await processEvents(db, terminalA, [saleEvent()], logger);
    const rows = await db.query<{ code: string; balance: number; ledger: number }>(
      `SELECT p.code, b.on_hand AS balance,
              (SELECT COALESCE(SUM(quantity_delta),0)::bigint FROM inventory_ledger l
                WHERE l.product_id = p.id AND l.location_id = b.location_id) AS ledger
         FROM inventory_balances b JOIN products p ON p.id = b.product_id`);
    for (const row of rows) {
      assert.equal(row.balance, row.ledger, `${row.code}: bakiye defterle ortusmeli`);
    }
  });

  test('stok duzeltmesi ayni olayla iki kez uygulanmaz', async () => {
    const event = validateEvent({
      eventId: randomUUID(), type: 'inventory.adjusted', sequence: 1,
      occurredAt: new Date().toISOString(),
      payload: { productCode: 'F001', movementType: 'COUNT', delta: 50000,
                 reference: 'test-1' },
    });
    await processEvents(db, terminalA, [event], logger);
    await processEvents(db, terminalA, [event], logger);
    const balance = await db.one<{ on_hand: number }>(
      `SELECT on_hand FROM inventory_balances b JOIN products p ON p.id=b.product_id
        WHERE p.code='F001'`);
    assert.equal(balance!.on_hand, 50000);
  });

  test('merkezi katalogda olmayan urun satisi kaydi bozmaz', async () => {
    const event = saleEvent();
    (event.payload.lines as Record<string, unknown>[])[0]!.productCode = 'YOK123';
    const result = await processEvents(db, terminalA, [event], logger);
    assert.equal(result[0]!.status, 'PROCESSED', 'satis yine de kaydedilmeli');
    const line = await db.one<{ product_id: string | null; product_code: string }>(
      'SELECT product_id, product_code FROM sale_lines LIMIT 1');
    assert.equal(line!.product_id, null);
    assert.equal(line!.product_code, 'YOK123');
    const ledger = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM inventory_ledger');
    assert.equal(ledger!.n, 0, 'eslesmeyen urun icin stok hareketi yazilmaz');
  });
});

describe('transaction butunlugu', () => {
  test('hatali olay hicbir kismi kayit birakmaz', async () => {
    const bad = validateEvent({
      eventId: randomUUID(), type: 'sale.completed', sequence: 1,
      occurredAt: new Date().toISOString(),
      payload: {
        localUid: randomUUID(), docType: 'SALE', total: 1000,
        completedAt: new Date().toISOString(),
        lines: [{ lineNo: 1, productCode: 'S001', name: 'Su', unit: 'EACH',
                  quantity: 1000, unitPrice: 750, gross: 750 }], // net EKSIK
        payments: [],
      },
    });
    const result = await processEvents(db, terminalA, [bad], logger);
    assert.equal(result[0]!.status, 'FAILED');
    const sales = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sales');
    assert.equal(sales!.n, 0, 'kismi satis kaydi kalmamali');
    const lines = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sale_lines');
    assert.equal(lines!.n, 0);
    const failed = await db.one<{ status: string }>(
      'SELECT status FROM sync_events WHERE event_id = $1', [bad.eventId]);
    assert.equal(failed!.status, 'FAILED', 'hata kaydi tutulmali');
  });

  test('bir olayin hatasi digerlerini engellemez', async () => {
    const good1 = saleEvent();
    const bad = validateEvent({
      eventId: randomUUID(), type: 'sale.completed', sequence: 2,
      occurredAt: new Date().toISOString(), payload: { docType: 'SALE' },
    });
    const good2 = saleEvent({ sequence: 3 });
    const results = await processEvents(db, terminalA, [good1, bad, good2], logger);
    assert.deepEqual(results.map((r) => r.status), ['PROCESSED', 'FAILED', 'PROCESSED']);
    const count = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM sales');
    assert.equal(count!.n, 2);
  });
});

describe('denetim ve degisiklik kaydi', () => {
  test('fiyat degisikligi denetime ve change_log a yazilir', async () => {
    await db.exec(
      `INSERT INTO prices (product_id, unit_price)
       SELECT id, 750 FROM products WHERE code='S001'`);
    const event = validateEvent({
      eventId: randomUUID(), type: 'product.price_changed', sequence: 1,
      occurredAt: new Date().toISOString(),
      payload: { productCode: 'S001', newPrice: 900, reason: 'zam' },
    });
    await processEvents(db, terminalA, [event], logger);

    const price = await db.one<{ unit_price: number }>(
      `SELECT unit_price FROM prices p JOIN products pr ON pr.id=p.product_id
        WHERE pr.code='S001' AND p.valid_to IS NULL`);
    assert.equal(price!.unit_price, 900);

    const history = await db.one<{ old_price: number; new_price: number; source: string }>(
      'SELECT old_price, new_price, source FROM price_history ORDER BY id DESC LIMIT 1');
    assert.equal(history!.old_price, 750);
    assert.equal(history!.new_price, 900);
    assert.equal(history!.source, 'POS');

    const change = await db.one<{ entity_type: string }>(
      'SELECT entity_type FROM change_log ORDER BY id DESC LIMIT 1');
    assert.equal(change!.entity_type, 'price', 'diger terminaller cekebilmeli');

    const audit = await db.one<{ action: string }>(
      "SELECT action FROM audit_log WHERE action='price.changed' LIMIT 1");
    assert.ok(audit !== undefined, 'denetim kaydi olusmali');
  });

  test('denetim kaydi degistirilemez', async () => {
    await processEvents(db, terminalA, [validateEvent({
      eventId: randomUUID(), type: 'cash_session.opened', sequence: 1,
      occurredAt: new Date().toISOString(),
      payload: { localId: 1, businessDate: '2026-09-06', openingFloat: 100,
                 openedAt: new Date().toISOString() },
    })], logger);
    await assert.rejects(
      () => db.exec("UPDATE audit_log SET action='sahte'"),
      /append-only/,
    );
  });
});

describe('migration', () => {
  test('migration tekrar calistirilabilir ve sema surumu bilinir', async () => {
    const result = await migrate(db, logger);
    assert.equal(result.applied.length, 0, 'ikinci calistirmada yeni migration olmamali');
    assert.ok(result.alreadyApplied.length >= 3);
    assert.ok(result.version !== null);
  });
});
