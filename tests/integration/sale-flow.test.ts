import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seed, type Harness } from '../helpers/harness.ts';
import { makeLabel, type LabelLayout } from '../fixtures/weighted-labels.ts';
import { money, percent } from '../../src/core/money/money.ts';
import { quantity } from '../../src/core/quantity/quantity.ts';
import { newIdempotencyKey } from '../../src/core/ids.ts';
import { verifyAuditChain } from '../../src/modules/audit/audit.ts';
import { isPosError } from '../../src/core/errors.ts';

const WEIGHT: LabelLayout = { prefix: '27', pluLength: 5, valueLength: 5, valueScale: 3 };
const PRICE: LabelLayout = { prefix: '28', pluLength: 5, valueLength: 5, valueScale: 2 };

let current: Harness | null = null;
function harness(): Harness {
  current = createHarness();
  return current;
}
afterEach(() => {
  current?.dispose();
  current = null;
});

describe('uctan uca satis akisi', () => {
  test('tartili etiket + normal barkod + nakit odeme + fis', () => {
    const h = harness();
    const { cashier, session, findik, su } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;

    // 0,750 kg ic findik -> 300,00 TL/kg * 0,750 = 225,00 TL
    const label = makeLabel(WEIGHT, 231, 750, false);
    const item = h.app.resolver.resolve(label, { terminalId: h.app.terminalId, userId: cashier.id });
    assert.equal(item.product.id, findik.id);
    assert.equal(item.quantity, 750);
    assert.equal(item.priceSource, 'BARCODE_WEIGHT');
    let sale = h.app.sales.addItem(saleId, item, cashier.id);
    assert.equal(sale.totals.total, 22500);

    // 2 adet su
    const suItem = h.app.resolver.resolve('8690504060017', { terminalId: h.app.terminalId, userId: cashier.id });
    sale = h.app.sales.addItem(saleId, suItem, cashier.id);
    sale = h.app.sales.addItem(saleId, suItem, cashier.id);
    assert.equal(sale.items.filter((i) => !i.voided).length, 2, 'ayni urun tek satirda birlesmeli');
    assert.equal(sale.totals.total, 22500 + 1500);

    const result = h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(25000) }],
      expectedTotal: money(24000),
    });

    assert.equal(result.total, 24000);
    assert.equal(result.changeDue, 1000);
    assert.equal(result.receiptSeries, 'T');
    assert.equal(result.receiptNo, 1);

    const completed = h.app.sales.view(saleId);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.receiptNo, 1);

    // stok dustu
    assert.equal(h.app.products.byId(findik.id).stockQty, 50000 - 750);
    assert.equal(h.app.products.byId(su.id).stockQty, 100000 - 2000);

    // fis kuyruga alindi
    assert.equal(h.app.printQueue.pendingCount(), 1);
  });

  test('tutar gomulu etiket: fiyat etiketten alinir, yeniden hesaplanmaz', () => {
    const h = harness();
    const { cashier, session, fistik } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;

    // Etiket 89,90 TL diyor; urun karti 450,00 TL/kg
    const label = makeLabel(PRICE, 405, 8990, true);
    const item = h.app.resolver.resolve(label, { terminalId: h.app.terminalId, userId: cashier.id });
    assert.equal(item.product.id, fistik.id);
    assert.equal(item.fixedGross, 8990);
    assert.equal(item.priceSource, 'BARCODE_PRICE');

    const sale = h.app.sales.addItem(saleId, item, cashier.id);
    assert.equal(sale.totals.total, 8990, 'etiket tutari korunmali');
    // Stok icin agirlik turetildi: 8990 / 45000 * 1000 = 200 g
    assert.equal(sale.items[0]!.quantity, 200);
  });

  test('stok yalnizca tamamlanmada duser, acik fiste dusmez', () => {
    const h = harness();
    const { cashier, session, findik } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    const item = h.app.resolver.resolve(makeLabel(WEIGHT, 231, 1000, false), {});
    h.app.sales.addItem(saleId, item, cashier.id);

    assert.equal(h.app.products.byId(findik.id).stockQty, 50000, 'acik fiste stok degismemeli');

    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(30000) }],
    });
    assert.equal(h.app.products.byId(findik.id).stockQty, 49000);
  });
});

describe('idempotency - satis asla iki kez kaydedilmez', () => {
  test('ayni anahtarla iki kez tamamlama tek satis olusturur', () => {
    const h = harness();
    const { cashier, session, su } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);

    const key = newIdempotencyKey();
    const payments = [{ method: 'CASH' as const, tendered: money(1000) }];

    const first = h.app.sales.complete({ saleId, userId: cashier.id, idempotencyKey: key, payments });
    const second = h.app.sales.complete({ saleId, userId: cashier.id, idempotencyKey: key, payments });

    assert.equal(first.receiptNo, second.receiptNo, 'ayni fis numarasi donmeli');
    assert.equal(second.replayed, true);

    const count = h.app.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sales WHERE status = 'COMPLETED'",
    )!.n;
    assert.equal(count, 1, 'yalnizca tek satis olmali');

    const movements = h.app.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'SALE'",
    )!.n;
    assert.equal(movements, 1, 'stok bir kez dusmeli');
    assert.equal(h.app.products.byId(su.id).stockQty, 100000 - 1000);

    const payCount = h.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payments')!.n;
    assert.equal(payCount, 1, 'odeme bir kez yazilmali');
  });

  test('ayni anahtar farkli istekle kullanilirsa reddedilir', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    const key = newIdempotencyKey();
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: key,
      payments: [{ method: 'CASH', tendered: money(1000) }],
    });
    assert.throws(
      () => h.app.sales.complete({
        saleId, userId: cashier.id, idempotencyKey: key,
        payments: [{ method: 'CASH', tendered: money(2000) }],
      }),
      (error: unknown) => isPosError(error) && error.code === 'IDEMPOTENCY_KEY_REUSE',
    );
  });

  test('sunucu toplami ile UI toplami uyusmazsa satis kapanmaz', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    assert.throws(
      () => h.app.sales.complete({
        saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
        payments: [{ method: 'CASH', tendered: money(1000) }],
        expectedTotal: money(999),
      }),
      (error: unknown) => isPosError(error) && error.code === 'TOTAL_MISMATCH',
    );
    assert.equal(h.app.sales.view(saleId).status, 'OPEN', 'satis acik kalmali');
  });
});

describe('cokme sonrasi kurtarma', () => {
  test('yarim kalan satis yeniden acilista aynen geri gelir', () => {
    let h = harness();
    const { cashier, session } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve(makeLabel(WEIGHT, 231, 750, false), {}), cashier.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    const before = h.app.sales.view(saleId);

    // === COKME === (surec olur, DB dosyada kalir)
    const h2 = h.restart();
    current = h2;

    const report = h2.app.start();
    assert.equal(report.openSaleRecovered, saleId, 'acik fis geri yuklenmeli');
    assert.equal(report.integrityOk, true);

    const after = h2.app.sales.currentOpenSale(h2.app.terminalId)!;
    assert.equal(after.id, before.id);
    assert.equal(after.totals.total, before.totals.total);
    assert.equal(after.items.length, before.items.length);
    assert.equal(after.items[0]!.name, 'Ic Findik');

    // Kaldigi yerden devam edip tamamlanabilmeli
    const result = h2.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: after.totals.total }],
    });
    assert.equal(result.total, before.totals.total);
    h = h2;
  });

  test('tamamlanmis satis yeniden acilista degismeden durur', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    const result = h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });

    const h2 = h.restart();
    current = h2;
    const restored = h2.app.sales.byReceipt('T', result.receiptNo)!;
    assert.equal(restored.status, 'COMPLETED');
    assert.equal(restored.totals.total, 750);
    assert.equal(restored.items[0]!.name, 'Su 0.5L');
  });

  test('bekleyen fis isleri yeniden acilista kuyrukta kalir', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });
    assert.equal(h.app.printQueue.pendingCount(), 1);

    const h2 = h.restart();
    current = h2;
    const report = h2.app.start();
    assert.equal(report.pendingPrintJobs, 1, 'fis isi kaybolmamali');
  });
});

describe('yazici arizasi satisi engellemez', () => {
  test('yazici kapaliyken satis tamamlanir, fis kuyrukta bekler', async () => {
    const h = harness();
    const { cashier, session } = seed(h);
    h.printer.failNext(true);

    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);

    const result = h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });
    assert.equal(result.receiptNo, 1, 'yazici kapali olsa da satis tamamlanmali');

    // Basim denemesi basarisiz olur ama satis etkilenmez
    await h.app.printQueue.processDue();
    assert.equal(h.app.sales.view(saleId).status, 'COMPLETED');
    assert.equal(h.printer.written.length, 0);
    assert.ok(h.app.printQueue.pendingCount() + h.app.printQueue.failedCount() >= 1);

    // Yazici duzelince fis basilir
    h.printer.failNext(false);
    h.app.printQueue.retryFailed();
    h.clock.advance(120000);
    await h.app.printQueue.processDue();
    assert.equal(h.printer.written.length, 1, 'yazici gelince fis basilmali');
  });

  test('tekrar basim kopya damgasi ile yeni is olusturur', async () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    }).id;
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });
    await h.app.printQueue.processDue();

    h.app.printQueue.reprint(saleId, cashier.id);
    await h.app.printQueue.processDue();
    assert.equal(h.printer.written.length, 2);

    const audit = h.app.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_events WHERE type = 'RECEIPT_REPRINTED'",
    )!.n;
    assert.equal(audit, 1, 'tekrar basim denetime yazilmali');
  });
});

describe('hatali okumalar satisi bozmaz', () => {
  test('bilinmeyen barkod satir eklemez ve kaydedilir', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    h.app.sales.openSale({
      terminalId: h.app.terminalId, userId: cashier.id, cashSessionId: session.id,
    });
    assert.throws(
      () => h.app.resolver.resolve('1234567890128', { terminalId: h.app.terminalId }),
      (error: unknown) => isPosError(error) && error.code === 'BARCODE_UNKNOWN',
    );
    const logged = h.app.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM scan_log WHERE result = 'UNKNOWN'",
    )!.n;
    assert.equal(logged, 1, 'cozumlenemeyen okuma kaydedilmeli (format kesfi icin)');
  });

  test('PLU bulunamazsa satir eklenmez', () => {
    const h = harness();
    seed(h);
    assert.throws(
      () => h.app.resolver.resolve(makeLabel(WEIGHT, 99999, 500, false), {}),
      (error: unknown) => isPosError(error) && error.code === 'PLU_NOT_FOUND',
    );
  });

  test('tartili etiket adet birimli urunde reddedilir', () => {
    const h = harness();
    const { su } = seed(h);
    h.app.products.addPlu(su.id, 777);
    assert.throws(
      () => h.app.resolver.resolve(makeLabel(WEIGHT, 777, 500, false), {}),
      (error: unknown) => isPosError(error) && error.code === 'PRODUCT_UNIT_MISMATCH',
    );
  });

  test('bozuk kontrol haneli etiket reddedilir', () => {
    const h = harness();
    seed(h);
    const good = makeLabel(WEIGHT, 231, 750, false);
    const bad = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    assert.throws(
      () => h.app.resolver.resolve(bad, {}),
      (error: unknown) => isPosError(error) && error.code === 'BARCODE_INVALID',
    );
  });
});
