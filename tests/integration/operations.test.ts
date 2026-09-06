import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seed, type Harness } from '../helpers/harness.ts';
import { makeLabel, type LabelLayout } from '../fixtures/weighted-labels.ts';
import { money, percent } from '../../src/core/money/money.ts';
import { quantity } from '../../src/core/quantity/quantity.ts';
import { newIdempotencyKey } from '../../src/core/ids.ts';
import { verifyAuditChain } from '../../src/modules/audit/audit.ts';
import { isPosError } from '../../src/core/errors.ts';
import { ScanQueue } from '../../src/modules/scanner/queue.ts';

const WEIGHT: LabelLayout = { prefix: '27', pluLength: 5, valueLength: 5, valueScale: 3 };

let current: Harness | null = null;
function harness(): Harness {
  current = createHarness();
  return current;
}
afterEach(() => {
  current?.dispose();
  current = null;
});

function newSale(h: Harness, userId: number, sessionId: number): number {
  return h.app.sales.openSale({
    terminalId: h.app.terminalId, userId, cashSessionId: sessionId,
  }).id;
}

describe('satir iptali ve fis iptali', () => {
  test('iptal edilen satir tutara girmez ama kayitta durur', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8691234567895', {}), cashier.id);
    assert.equal(h.app.sales.view(saleId).totals.total, 750 + 4550);

    const after = h.app.sales.voidLine(saleId, 2, cashier.id, 'musteri vazgecti');
    assert.equal(after.totals.total, 750);
    assert.equal(after.items.length, 2, 'satir silinmemeli');
    assert.equal(after.items[1]!.voided, true);
    assert.equal(after.items[1]!.voidReason, 'musteri vazgecti');
  });

  test('acik fis iptal edilir, stok etkilenmez', () => {
    const h = harness();
    const { cashier, session, findik } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve(makeLabel(WEIGHT, 231, 1000, false), {}), cashier.id);

    const voided = h.app.sales.voidSale(saleId, cashier.id, 'musteri gitti');
    assert.equal(voided.status, 'VOIDED');
    assert.equal(h.app.products.byId(findik.id).stockQty, 50000, 'stok degismemeli');
    assert.throws(
      () => h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id),
      (error: unknown) => isPosError(error) && error.code === 'SALE_NOT_OPEN',
    );
  });

  test('tamamlanmis satis iptal edilemez', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });
    assert.throws(
      () => h.app.sales.voidSale(saleId, cashier.id, 'yanlislikla'),
      (error: unknown) => isPosError(error) && error.code === 'SALE_NOT_OPEN',
    );
  });
});

describe('indirim ve yetki', () => {
  test('limit altindaki indirim onaysiz uygulanir', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8691234567895', {}), cashier.id);
    const sale = h.app.sales.applySaleDiscount(saleId, { type: 'PERCENT', value: percent(5) }, cashier.id);
    assert.equal(sale.totals.saleDiscountTotal, 228);
    assert.equal(sale.totals.total, 4550 - 228);
  });

  test('limit ustu indirim yonetici onayi ister', () => {
    const h = harness();
    const { cashier, manager, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8691234567895', {}), cashier.id);

    assert.throws(
      () => h.app.sales.applySaleDiscount(saleId, { type: 'PERCENT', value: percent(25) }, cashier.id),
      (error: unknown) => isPosError(error) && error.code === 'APPROVAL_REQUIRED',
    );

    const approver = h.app.users.approve('mudur', '9999', 'DISCOUNT_OVER_LIMIT');
    assert.equal(approver.id, manager.id);
    const sale = h.app.sales.applySaleDiscount(
      saleId, { type: 'PERCENT', value: percent(25) }, cashier.id, approver.id,
    );
    assert.equal(sale.totals.total, 4550 - 1138);
  });

  test('yanlis PIN ile onay alinamaz', () => {
    const h = harness();
    seed(h);
    assert.throws(
      () => h.app.users.approve('mudur', '0000', 'DISCOUNT_OVER_LIMIT'),
      (error: unknown) => isPosError(error) && error.code === 'INVALID_CREDENTIALS',
    );
  });

  test('kasiyer iade yetkisine sahip degil', () => {
    const h = harness();
    seed(h);
    assert.throws(
      () => h.app.users.approve('kasiyer', '1234', 'REFUND'),
      (error: unknown) => isPosError(error) && error.code === 'UNAUTHORIZED',
    );
  });
});

describe('iade', () => {
  function completedSale(h: Harness, cashier: number, session: number) {
    const saleId = newSale(h, cashier, session);
    h.app.sales.addItem(saleId, h.app.resolver.resolve(makeLabel(WEIGHT, 231, 1000, false), {}), cashier);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier);
    const result = h.app.sales.complete({
      saleId, userId: cashier, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(30750) }],
    });
    return { saleId, result };
  }

  test('kismi iade stogu geri ekler ve kasadan nakit cikarir', () => {
    const h = harness();
    const { cashier, manager, session, findik } = seed(h);
    const { saleId } = completedSale(h, cashier.id, session.id);
    assert.equal(h.app.products.byId(findik.id).stockQty, 49000);

    const refund = h.app.sales.createRefund({
      originalSaleId: saleId,
      lines: [{ lineNo: 1, quantity: quantity(500) }],
      terminalId: h.app.terminalId, userId: manager.id, cashSessionId: session.id,
    });
    assert.equal(refund.docType, 'REFUND');
    assert.equal(refund.totals.total, 15000);

    h.app.sales.complete({
      saleId: refund.id, userId: manager.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(15000) }],
    });

    assert.equal(h.app.products.byId(findik.id).stockQty, 49500, 'stok geri eklenmeli');
    const summary = h.app.cashRegister.summary(session.id);
    assert.equal(summary.refundCount, 1);
    assert.equal(summary.refundTotal, 15000);
    assert.equal(summary.expectedCash, 20000 + 30750 - 15000);
  });

  test('satilandan fazla iade edilemez', () => {
    const h = harness();
    const { cashier, manager, session } = seed(h);
    const { saleId } = completedSale(h, cashier.id, session.id);
    assert.throws(
      () => h.app.sales.createRefund({
        originalSaleId: saleId, lines: [{ lineNo: 1, quantity: quantity(2000) }],
        terminalId: h.app.terminalId, userId: manager.id, cashSessionId: session.id,
      }),
      (error: unknown) => isPosError(error) && error.code === 'REFUND_EXCEEDS_ORIGINAL',
    );
  });

  test('ayni satir iki kez tam iade edilemez', () => {
    const h = harness();
    const { cashier, manager, session } = seed(h);
    const { saleId } = completedSale(h, cashier.id, session.id);
    const first = h.app.sales.createRefund({
      originalSaleId: saleId, lines: [{ lineNo: 1 }],
      terminalId: h.app.terminalId, userId: manager.id, cashSessionId: session.id,
    });
    h.app.sales.complete({
      saleId: first.id, userId: manager.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(first.totals.total) }],
    });
    assert.throws(
      () => h.app.sales.createRefund({
        originalSaleId: saleId, lines: [{ lineNo: 1 }],
        terminalId: h.app.terminalId, userId: manager.id, cashSessionId: session.id,
      }),
      (error: unknown) => isPosError(error) && error.code === 'REFUND_EXCEEDS_ORIGINAL',
    );
  });

  test('iade fiyati orijinal fisten alinir, guncel fiyattan degil', () => {
    const h = harness();
    const { cashier, manager, session, findik } = seed(h);
    const { saleId } = completedSale(h, cashier.id, session.id);

    // Satistan sonra zam yapildi
    h.app.products.changePrice(findik.id, money(60000), manager.id, 'zam');

    const refund = h.app.sales.createRefund({
      originalSaleId: saleId, lines: [{ lineNo: 1 }],
      terminalId: h.app.terminalId, userId: manager.id, cashSessionId: session.id,
    });
    assert.equal(refund.totals.total, 30000, 'iade eski fiyattan yapilmali');
  });
});

describe('kasa oturumu ve gun sonu', () => {
  test('beklenen nakit dogru hesaplanir, fark raporlanir', () => {
    const h = harness();
    const { cashier, session } = seed(h);

    const s1 = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(s1, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.complete({
      saleId: s1, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(1000) }],
    });

    const s2 = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(s2, h.app.resolver.resolve('8691234567895', {}), cashier.id);
    h.app.sales.complete({
      saleId: s2, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CARD', tendered: money(4550) }],
    });

    h.app.cashRegister.movement({
      sessionId: session.id, type: 'PAID_OUT', amount: money(5000),
      userId: cashier.id, note: 'tedarikci',
    });

    const summary = h.app.cashRegister.summary(session.id);
    assert.equal(summary.salesCount, 2);
    assert.equal(summary.salesTotal, 750 + 4550);
    assert.equal(summary.cashSales, 750);
    assert.equal(summary.cardSales, 4550);
    assert.equal(summary.paidOut, -5000);
    assert.equal(summary.expectedCash, 20000 + 750 - 5000);

    const closed = h.app.cashRegister.close({
      sessionId: session.id, userId: cashier.id, countedCash: money(15500),
    });
    assert.equal(closed.session.status, 'CLOSED');
    assert.equal(closed.session.variance, 15500 - 15750);
  });

  test('acik fis varken kasa kapatilamaz', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    assert.throws(
      () => h.app.cashRegister.close({
        sessionId: session.id, userId: cashier.id, countedCash: money(20000),
      }),
      (error: unknown) => isPosError(error) && error.code === 'SALE_NOT_OPEN',
    );
  });

  test('kasa acik degilse satis tamamlanamaz', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    // Kasa bos halde kapatilir, sonra o kapali oturuma bagli bir fis tamamlanmaya calisilir
    h.app.cashRegister.close({
      sessionId: session.id, userId: cashier.id, countedCash: money(20000),
    });
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    assert.throws(
      () => h.app.sales.complete({
        saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
        payments: [{ method: 'CASH', tendered: money(750) }],
      }),
      (error: unknown) => isPosError(error) && error.code === 'CASH_SESSION_NOT_OPEN',
    );
  });
});

describe('denetlenebilirlik', () => {
  test('denetim zinciri saglam ve dogrulanabilir', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });

    const result = verifyAuditChain(h.app.db);
    assert.equal(result.ok, true, result.message);
    assert.ok(result.checked > 0);
  });

  test('denetim kaydi degistirilirse veya silinirse yakalanir', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });

    // Trigger dogrudan degisiklige izin vermez
    assert.throws(
      () => h.app.db.run("UPDATE audit_events SET data_json = '{}' WHERE id = 1"),
      /append-only/,
    );

    // Trigger devre disi birakilarak yapilan bir mudahale bile zinciri kirar
    h.app.db.exec('DROP TRIGGER trg_audit_events_no_update');
    h.app.db.run("UPDATE audit_events SET data_json = '{\"sahte\":true}' WHERE id = 1");
    const result = verifyAuditChain(h.app.db);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
  });

  test('satis olaylari sirali ve eksiksiz kaydedilir', () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8690504060017', {}), cashier.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve('8691234567895', {}), cashier.id);
    h.app.sales.voidLine(saleId, 2, cashier.id, 'yanlis urun');
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(750) }],
    });

    const events = h.app.sales.events(saleId);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'SALE_OPENED', 'ITEM_ADDED', 'ITEM_ADDED', 'ITEM_VOIDED', 'SALE_COMPLETED',
    ]);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  });
});

describe('stok tutarliligi', () => {
  test('hareket defteri ile bakiye daima ortusur', () => {
    const h = harness();
    const { cashier, manager, session, findik } = seed(h);
    for (let i = 0; i < 5; i++) {
      const saleId = newSale(h, cashier.id, session.id);
      h.app.sales.addItem(
        saleId, h.app.resolver.resolve(makeLabel(WEIGHT, 231, 250 + i * 10, false), {}), cashier.id,
      );
      h.app.sales.complete({
        saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
        payments: [{ method: 'CASH', tendered: money(100000) }],
      });
    }
    h.app.inventory.adjust({
      productId: findik.id, delta: quantity(-300), type: 'WASTE',
      userId: manager.id, note: 'fire',
    });

    const verify = h.app.inventory.verify();
    assert.equal(verify.ok, true, JSON.stringify(verify.mismatches));
  });

  test('bozulan bakiye hareket defterinden yeniden kurulur', () => {
    const h = harness();
    const { cashier, session, findik } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    h.app.sales.addItem(saleId, h.app.resolver.resolve(makeLabel(WEIGHT, 231, 500, false), {}), cashier.id);
    h.app.sales.complete({
      saleId, userId: cashier.id, idempotencyKey: newIdempotencyKey(),
      payments: [{ method: 'CASH', tendered: money(20000) }],
    });

    h.app.db.run('UPDATE products SET stock_qty = 999 WHERE id = ?', findik.id);
    assert.equal(h.app.inventory.verify().ok, false);
    h.app.inventory.rebuild();
    assert.equal(h.app.inventory.verify().ok, true);
    assert.equal(h.app.products.byId(findik.id).stockQty, 50000 - 500);
  });
});

describe('hizli ardisik okuma', () => {
  test('30 barkod art arda okutuldugunda hepsi sirayla islenir', async () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);

    const queue = new ScanQueue({
      resolver: h.app.resolver,
      sales: h.app.sales,
      clock: h.clock,
      context: {
        terminalId: h.app.terminalId,
        getUserId: () => cashier.id,
        getSaleId: () => saleId,
        ensureSaleId: () => saleId,
      },
      dedupeWindowMs: 0,
    });

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        queue.submit(makeLabel(WEIGHT, 231, 100 + i, false), h.clock.now() + i),
      ),
    );
    assert.equal(results.filter((r) => r.ok).length, 30);

    const sale = h.app.sales.view(saleId);
    assert.equal(sale.items.length, 30, 'her okuma ayri satir olmali');
    assert.deepEqual(
      sale.items.map((i) => i.lineNo),
      Array.from({ length: 30 }, (_, i) => i + 1),
      'satir numaralari sirali ve bosluksuz olmali',
    );
    const expected = Array.from({ length: 30 }, (_, i) =>
      Math.round(((100 + i) * 30000) / 1000)).reduce((a, b) => a + b, 0);
    assert.equal(sale.totals.total, expected);
  });

  test('cift okuma sicramasi elenir, kasitli tekrar okuma elenmez', async () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    const queue = new ScanQueue({
      resolver: h.app.resolver, sales: h.app.sales, clock: h.clock,
      context: {
        terminalId: h.app.terminalId,
        getUserId: () => cashier.id,
        getSaleId: () => saleId,
        ensureSaleId: () => saleId,
      },
      dedupeWindowMs: 120,
    });

    const base = h.clock.now();
    const bounce = await queue.submit('8690504060017', base);
    const duplicate = await queue.submit('8690504060017', base + 20);
    assert.equal(bounce.ok, true);
    assert.equal(duplicate.duplicateIgnored, true, 'cok hizli tekrar elenmeli');

    const intentional = await queue.submit('8690504060017', base + 2000);
    assert.equal(intentional.duplicateIgnored, undefined);
    assert.equal(h.app.sales.view(saleId).items[0]!.quantity, 2000, 'kasitli tekrar miktari artirmali');
  });

  test('bir okumadaki hata sonraki okumalari engellemez', async () => {
    const h = harness();
    const { cashier, session } = seed(h);
    const saleId = newSale(h, cashier.id, session.id);
    const queue = new ScanQueue({
      resolver: h.app.resolver, sales: h.app.sales, clock: h.clock,
      context: {
        terminalId: h.app.terminalId,
        getUserId: () => cashier.id,
        getSaleId: () => saleId,
        ensureSaleId: () => saleId,
      },
      dedupeWindowMs: 0,
    });

    const outcomes = await Promise.all([
      queue.submit('8690504060017'),
      queue.submit('9999999999994'),
      queue.submit('8691234567895'),
    ]);
    assert.equal(outcomes[0]!.ok, true);
    assert.equal(outcomes[1]!.ok, false);
    assert.equal(outcomes[2]!.ok, true);
    assert.equal(h.app.sales.view(saleId).items.length, 2);
  });
});
