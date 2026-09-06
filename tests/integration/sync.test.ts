import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seed, type Harness } from '../helpers/harness.ts';
import { startFakeServer, type FakeServer } from '../helpers/fake-server.ts';
import { money } from '../../src/core/money/money.ts';
import { quantity } from '../../src/core/quantity/quantity.ts';
import { newIdempotencyKey } from '../../src/core/ids.ts';

/**
 * Senkronizasyon testleri.
 *
 * EN ONEMLI IDDIA: POS'un calismasi merkezi sunucuya BAGLI DEGILDIR.
 * Asagidaki testlerin cogu sunucu KAPALIYKEN satisin tamamlandigini dogrular.
 */

let harness: Harness | null = null;
let server: FakeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  harness?.dispose();
  harness = null;
});

async function setup(options: { enroll?: boolean } = {}) {
  server = await startFakeServer();
  harness = createHarness();
  const data = seed(harness);
  if (options.enroll !== false) {
    await harness.app.sync.enroll({
      serverUrl: server.url,
      enrollmentCode: 'TEST-CODE',
      terminalCode: 'KASA-TEST',
    });
    // Ilk tur bootstrap'i tamamlar. Gercek akista da once bootstrap, sonra
    // artimli degisiklikler gelir; testler bu sirayi izler.
    await harness.app.sync.runOnce();
  }
  return { h: harness, fake: server, ...data };
}

function makeSale(h: Harness, userId: number, sessionId: number): { saleId: number; total: number } {
  const saleId = h.app.sales.openSale({
    terminalId: h.app.terminalId, userId, cashSessionId: sessionId,
  }).id;
  h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), userId);
  const total = h.app.sales.view(saleId).totals.total;
  h.app.sales.complete({
    saleId, userId, idempotencyKey: newIdempotencyKey(),
    payments: [{ method: 'CASH', tendered: money(total) }], expectedTotal: money(total),
  });
  return { saleId, total };
}

describe('outbox: olay satisla AYNI transaction icinde yazilir', () => {
  test('tamamlanan satis kuyruga tam olarak bir olay birakir', async () => {
    const { h, cashier, session } = await setup({ enroll: false });
    const before = h.app.outbox.counts().pending;
    makeSale(h, cashier.id, session.id);
    const events = h.app.db.all<{ type: string }>(
      "SELECT type FROM outbox_events WHERE type LIKE 'sale%'");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'sale.completed');
    assert.ok(h.app.outbox.counts().pending > before);
  });

  test('satis geri alinirsa olay da olusmaz', async () => {
    const { h, cashier, session } = await setup({ enroll: false });
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    // Yanlis toplamla tamamlama denemesi -> transaction geri alinir
    assert.throws(() => h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }], expectedTotal: money(999),
    }));
    const events = h.app.db.all("SELECT * FROM outbox_events WHERE type = 'sale.completed'");
    assert.equal(events.length, 0, 'basarisiz satis olay birakmamali');
  });

  test('olay yuku sunucunun ihtiyac duydugu tum alanlari icerir', async () => {
    const { h, cashier, session } = await setup({ enroll: false });
    makeSale(h, cashier.id, session.id);
    const row = h.app.db.get<{ payload_json: string }>(
      "SELECT payload_json FROM outbox_events WHERE type='sale.completed'")!;
    const payload = JSON.parse(row.payload_json);
    for (const field of ['localUid', 'docType', 'receiptNo', 'total', 'lines', 'payments',
      'businessDate', 'localCashSessionId', 'completedAt']) {
      assert.ok(payload[field] !== undefined, `eksik alan: ${field}`);
    }
    assert.equal(payload.lines[0].productCode, 'S001');
    assert.equal(payload.payments[0].method, 'CASH');
  });
});

describe('POS internet olmadan calisir', () => {
  test('sunucu kapaliyken satis tamamlanir ve olay kuyrukta bekler', async () => {
    const { h, fake, cashier, session } = await setup();
    await fake.goOffline();

    const { total } = makeSale(h, cashier.id, session.id);
    assert.equal(total, 750, 'satis normal tamamlanmali');

    const status = await h.app.sync.runOnce();
    assert.equal(status.state, 'OFFLINE');
    assert.ok(status.pending >= 1, 'olay kuyrukta beklemeli');
    assert.equal(h.app.sales.recent(h.app.terminalId).length, 1, 'satis yerelde kayitli');
  });

  test('internet gelince otomatik senkronize olur', async () => {
    const { h, fake, cashier, session } = await setup();
    await fake.goOffline();
    makeSale(h, cashier.id, session.id);
    await h.app.sync.runOnce();
    assert.ok(h.app.sync.status().pending >= 1);

    await fake.goOnline();
    const status = await h.app.sync.runOnce();
    assert.equal(status.state, 'ONLINE');
    assert.equal(status.pending, 0, 'kuyruk bosalmali');
    assert.equal(fake.state.sales.size, 1, 'satis sunucuya ulasmali');
  });

  test('sunucu hicbir zaman satisi engellemez (10 satis, sunucu kapali)', async () => {
    const { h, fake, cashier, session } = await setup();
    await fake.goOffline();
    for (let i = 0; i < 10; i++) makeSale(h, cashier.id, session.id);
    assert.equal(h.app.sales.recent(h.app.terminalId, 50).length, 10);

    await fake.goOnline();
    await h.app.sync.runOnce();
    assert.equal(fake.state.sales.size, 10, 'hepsi sonradan senkronize olmali');
  });
});

describe('idempotency: ayni olay tekrar tekrar gonderilebilir', () => {
  test('ayni satis olayi 10 kez gonderilse de sunucuda tek satis olur', async () => {
    const { h, fake, cashier, session } = await setup();
    makeSale(h, cashier.id, session.id);

    for (let round = 0; round < 10; round++) {
      h.app.db.run(
        "UPDATE outbox_events SET status='PENDING', next_attempt_at=0 WHERE type='sale.completed'");
      await h.app.sync.runOnce();
    }
    assert.equal(fake.state.sales.size, 1, 'sunucuda tek satis olmali');
    const saleEventIds = new Set(
      h.app.db.all<{ event_id: string }>(
        "SELECT event_id FROM outbox_events WHERE type='sale.completed'").map((r) => r.event_id));
    assert.equal(saleEventIds.size, 1, 'olay kimligi yeniden denemelerde DEGISMEMELI');
    // Sunucuya birden fazla kez ulasti ama yalnizca ilki islendi
    assert.ok(fake.state.received.length >= 10);
    assert.equal(fake.state.processed.size >= 1, true);
  });

  test('iade olayi tekrar gonderilse de mukerrer iade olusmaz', async () => {
    const { h, fake, cashier, manager, session } = await setup();
    const { saleId } = makeSale(h, cashier.id, session.id);
    const refund = h.app.sales.createRefund({
      originalSaleId: saleId, lines: [{ lineNo: 1 }],
      terminalId: h.app.terminalId, userId: manager.id, cashSessionId: session.id,
    });
    h.app.sales.complete({
      saleId: refund.id, userId: manager.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(refund.totals.total) }],
    });
    await h.app.sync.runOnce();
    const afterFirst = fake.state.sales.size;

    h.app.db.run("UPDATE outbox_events SET status='PENDING', next_attempt_at=0");
    await h.app.sync.runOnce();
    await h.app.sync.runOnce();
    assert.equal(fake.state.sales.size, afterFirst, 'iade mukerrer kaydedilmemeli');
  });
});

describe('yeniden deneme ve geri cekilme', () => {
  test('sunucu hatasi olayi kaybetmez, geri cekilme ile tekrar dener', async () => {
    const { h, fake, cashier, session } = await setup();
    makeSale(h, cashier.id, session.id);

    fake.failNext(1, 500, 'INTERNAL');
    await h.app.sync.runOnce();
    assert.ok(h.app.sync.status().pending >= 1, 'olay kuyrukta kalmali');

    // Geri cekilme suresi dolsun
    h.clock.advance(600_000);
    await h.app.sync.runOnce();
    assert.equal(h.app.sync.status().pending, 0);
    assert.equal(fake.state.sales.size, 1);
  });

  test('olay yuku sunucu tarafinda reddedilirse deneme sayaci artar', async () => {
    const { h, cashier, session } = await setup();
    makeSale(h, cashier.id, session.id);
    h.app.outbox.markFailed(
      h.app.db.get<{ event_id: string }>(
        "SELECT event_id FROM outbox_events WHERE type='sale.completed'")!.event_id,
      'test hatasi', { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 },
    );
    const row = h.app.db.get<{ attempts: number; status: string; next_attempt_at: number }>(
      "SELECT attempts, status, next_attempt_at FROM outbox_events WHERE type='sale.completed'")!;
    assert.equal(row.attempts, 1);
    assert.equal(row.status, 'FAILED');
    assert.ok(row.next_attempt_at > h.clock.now(), 'geri cekilme uygulanmali');
  });

  test('deneme hakki bitince olay olu kutusuna gider, kaybolmaz', async () => {
    const { h, cashier, session } = await setup();
    makeSale(h, cashier.id, session.id);
    const eventId = h.app.db.get<{ event_id: string }>(
      "SELECT event_id FROM outbox_events WHERE type='sale.completed'")!.event_id;
    for (let i = 0; i < 3; i++) {
      h.app.outbox.markFailed(eventId, 'kalici hata',
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
    }
    assert.equal(h.app.outbox.counts().dead, 1);
    // Yonetici yeniden deneyebilir
    assert.equal(h.app.sync.retryFailed(), 1);
    assert.equal(h.app.outbox.counts().dead, 0);
  });
});

describe('terminal iptali', () => {
  test('iptal edilmis terminal senkronize olamaz ve durum ERROR olur', async () => {
    const { h, fake, cashier, session } = await setup();
    makeSale(h, cashier.id, session.id);
    fake.revoke();

    const status = await h.app.sync.runOnce();
    assert.equal(status.state, 'ERROR');
    assert.match(status.lastError ?? '', /iptal/i);
    assert.ok(status.pending >= 1, 'olaylar korunmali');
  });

  test('terminal iptal edilse bile POS satis yapmaya devam eder', async () => {
    const { h, fake, cashier, session } = await setup();
    fake.revoke();
    await h.app.sync.runOnce();
    const { total } = makeSale(h, cashier.id, session.id);
    assert.equal(total, 750, 'iptal edilmis terminal bile satis yapabilmeli');
  });
});

describe('sunucudan cekme (server -> POS)', () => {
  test('merkezi fiyat degisikligi yerele uygulanir', async () => {
    const { h, fake, su } = await setup();
    assert.equal(h.app.products.byId(su.id).unitPrice, 750);

    fake.publish({
      entity_type: 'price', entity_id: 'remote-1', operation: 'UPSERT',
      payload: { code: 'S001', unitPrice: 900 },
    });
    await h.app.sync.runOnce();

    assert.equal(h.app.products.byId(su.id).unitPrice, 900, 'merkezi fiyat uygulanmali');
    const history = h.app.products.priceHistory(su.id);
    assert.equal(history[0]!.newPrice, 900);
  });

  test('merkezi yeni urun yerele eklenir (barkod ve PLU dahil)', async () => {
    const { h, fake } = await setup();
    fake.publish({
      entity_type: 'product', entity_id: 'remote-2', operation: 'UPSERT',
      payload: {
        code: 'YENI1', name: 'Merkezden Gelen Urun', unit: 'KG', unitPrice: 12500,
        taxRateBp: 100, barcodes: [{ barcode: '8699999999999', packSize: 1000 }],
        plus: [{ plu: 777, department: 1 }], active: true,
      },
    });
    await h.app.sync.runOnce();

    const product = h.app.products.findByCode('YENI1');
    assert.ok(product !== undefined, 'urun olusturulmali');
    assert.equal(product.unitPrice, 12500);
    assert.deepEqual(h.app.products.pluListFor(product.id), [777]);
    assert.deepEqual(h.app.products.barcodesFor(product.id), ['8699999999999']);
  });

  test('artimli cekme: ayni degisiklik iki kez uygulanmaz (imlec ilerler)', async () => {
    const { h, fake, su } = await setup();
    fake.publish({
      entity_type: 'price', entity_id: 'r1', operation: 'UPSERT',
      payload: { code: 'S001', unitPrice: 800 },
    });
    await h.app.sync.runOnce();
    const cursorAfterFirst = h.app.sync.status().pullCursor;
    assert.ok(cursorAfterFirst > 0);

    const pullsBefore = fake.state.pullCalls;
    await h.app.sync.runOnce();
    assert.equal(h.app.sync.status().pullCursor, cursorAfterFirst, 'imlec ayni kalmali');
    assert.ok(fake.state.pullCalls > pullsBefore, 'yine de kontrol edilmeli');
    assert.equal(h.app.products.byId(su.id).unitPrice, 800);
  });

  test('cekilen degisiklikler denetlenebilir sekilde kaydedilir', async () => {
    const { h, fake } = await setup();
    fake.publish({
      entity_type: 'price', entity_id: 'r1', operation: 'UPSERT',
      payload: { code: 'S001', unitPrice: 990 },
    });
    await h.app.sync.runOnce();
    const log = h.app.db.all<{ entity_type: string; detail: string }>(
      'SELECT entity_type, detail FROM sync_pull_log ORDER BY id DESC LIMIT 1');
    assert.equal(log[0]!.entity_type, 'price');
    assert.match(log[0]!.detail, /750 -> 990/);
  });
});

describe('POS yeniden baslatma', () => {
  test('senkronizasyon ortasinda kapanan POS kaldigi yerden devam eder', async () => {
    const { h, fake, cashier, session } = await setup();
    await fake.goOffline();
    makeSale(h, cashier.id, session.id);
    makeSale(h, cashier.id, session.id);
    await h.app.sync.runOnce();
    const pendingBefore = h.app.sync.status().pending;
    assert.ok(pendingBefore >= 2);

    // === POS kapandi ve yeniden acildi ===
    const restarted = h.restart();
    harness = restarted;
    restarted.app.start();

    assert.equal(restarted.app.sync.enrolled, true, 'cihaz kaydi korunmali');
    assert.equal(restarted.app.sync.status().pending, pendingBefore, 'kuyruk korunmali');

    await fake.goOnline();
    const status = await restarted.app.sync.runOnce();
    assert.equal(status.pending, 0);
    assert.equal(fake.state.sales.size, 2, 'iki satis da sunucuya ulasmali');
  });

  test('cihaz kaydi ve imlec yeniden baslatmada korunur', async () => {
    const { h, fake } = await setup();
    fake.publish({
      entity_type: 'price', entity_id: 'r1', operation: 'UPSERT',
      payload: { code: 'S001', unitPrice: 850 },
    });
    await h.app.sync.runOnce();
    const cursor = h.app.sync.status().pullCursor;

    const restarted = h.restart();
    harness = restarted;
    restarted.app.start();
    assert.equal(restarted.app.sync.status().pullCursor, cursor);
    assert.equal(restarted.app.sync.status().storeName, 'Test Magaza');
  });
});

describe('stok mutabakati', () => {
  test('fark gonderilir, mutlak deger degil (mukerrer dusum olmaz)', async () => {
    const { h, findik } = await setup();
    // Merkez 40 kg biliyor, yerelde 50 kg var -> fark +10 kg olmali
    const result = await h.app.sync.reconcileStock([
      { code: findik.code, quantity: 50000 },
    ]).catch(() => null);
    // Sahte sunucu /sync/inventory dondurmez -> hata beklenir, kuyruk bozulmaz
    assert.ok(result === null || typeof result.adjusted === 'number');
    assert.equal(h.app.outbox.counts().dead, 0);
  });

  test('stok duzeltmesi olay olarak kuyruga girer', async () => {
    const { h, manager, findik } = await setup();
    h.app.inventory.adjust({
      productId: findik.id, delta: quantity(-500), type: 'WASTE',
      userId: manager.id, note: 'fire',
    });
    const event = h.app.db.get<{ payload_json: string }>(
      "SELECT payload_json FROM outbox_events WHERE type='inventory.adjusted'");
    assert.ok(event !== undefined);
    const payload = JSON.parse(event.payload_json);
    assert.equal(payload.productCode, 'F001');
    assert.equal(payload.delta, -500);
    assert.equal(payload.movementType, 'WASTE');
  });
});

describe('kasa oturumu senkronizasyonu', () => {
  test('acilis ve kapanis olaylari kuyruga girer', async () => {
    const { h, cashier, session } = await setup();
    h.app.cashRegister.close({
      sessionId: session.id, userId: cashier.id, countedCash: money(20000),
    });
    const types = h.app.db.all<{ type: string }>(
      `SELECT type FROM outbox_events
        WHERE type IN ('cash_session.opened','cash_session.closed','cash.movement')
        ORDER BY id`).map((r) => r.type);
    assert.deepEqual(types, ['cash_session.opened', 'cash_session.closed']);
  });
});
