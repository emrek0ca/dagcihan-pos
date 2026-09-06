import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { money, percent, type BasisPoints } from '../../src/core/money/money.ts';
import { quantity, ONE_UNIT } from '../../src/core/quantity/quantity.ts';
import { calculateSale, summarizePayments } from '../../src/core/sale/calculate.ts';
import type { CalcLine } from '../../src/core/sale/types.ts';

const KDV1 = percent(1);
const KDV10 = percent(10);
const KDV20 = percent(20);

function line(partial: Partial<CalcLine> & { lineNo: number }): CalcLine {
  return {
    quantity: ONE_UNIT,
    unitPrice: money(1000),
    taxRateBp: KDV1,
    unit: 'EACH',
    ...partial,
  };
}

describe('temel fis hesabi', () => {
  test('tek adet urun', () => {
    const r = calculateSale({ lines: [line({ lineNo: 1, unitPrice: money(2490) })] });
    assert.equal(r.subtotal, 2490);
    assert.equal(r.total, 2490);
    assert.equal(r.itemCount, 1);
  });

  test('tartili urun: 0,750 kg x 120,00 TL/kg', () => {
    const r = calculateSale({
      lines: [line({ lineNo: 1, unit: 'KG', quantity: quantity(750), unitPrice: money(12000) })],
    });
    assert.equal(r.lines[0]!.gross, 9000);
    assert.equal(r.total, 9000);
  });

  test('tutar gomulu barkod: tutar YENIDEN hesaplanmaz', () => {
    // Etiket 89,90 TL diyor ama urun karti 120,00 TL/kg -> etiket tutari gecerlidir
    const r = calculateSale({
      lines: [line({
        lineNo: 1, unit: 'KG', quantity: quantity(749), unitPrice: money(12000),
        fixedGross: money(8990),
      })],
    });
    assert.equal(r.lines[0]!.gross, 8990);
    assert.equal(r.total, 8990);
  });

  test('cok satirli fis', () => {
    const r = calculateSale({
      lines: [
        line({ lineNo: 1, unitPrice: money(2490) }),
        line({ lineNo: 2, quantity: quantity(3000), unitPrice: money(1500) }),
        line({ lineNo: 3, unit: 'KG', quantity: quantity(1250), unitPrice: money(8000) }),
      ],
    });
    assert.equal(r.subtotal, 2490 + 4500 + 10000);
    assert.equal(r.total, 16990);
    assert.equal(r.itemCount, 3);
  });

  test('iptal edilen satir hesaba girmez', () => {
    const r = calculateSale({
      lines: [
        line({ lineNo: 1, unitPrice: money(2490) }),
        line({ lineNo: 2, unitPrice: money(5000), voided: true }),
      ],
    });
    assert.equal(r.total, 2490);
    assert.equal(r.itemCount, 1);
  });

  test('bos fis sifir doner', () => {
    const r = calculateSale({ lines: [] });
    assert.equal(r.total, 0);
    assert.equal(r.taxTotal, 0);
    assert.equal(r.itemCount, 0);
  });
});

describe('indirim', () => {
  test('satir yuzde indirimi', () => {
    const r = calculateSale({
      lines: [line({ lineNo: 1, unitPrice: money(10000), discount: { type: 'PERCENT', value: percent(10) } })],
    });
    assert.equal(r.lines[0]!.discountAmount, 1000);
    assert.equal(r.total, 9000);
  });

  test('satir tutar indirimi', () => {
    const r = calculateSale({
      lines: [line({ lineNo: 1, unitPrice: money(10000), discount: { type: 'AMOUNT', value: 2500 } })],
    });
    assert.equal(r.total, 7500);
  });

  test('indirim satir tutarini gecemez (negatif olmaz)', () => {
    const r = calculateSale({
      lines: [line({ lineNo: 1, unitPrice: money(1000), discount: { type: 'AMOUNT', value: 999999 } })],
    });
    assert.equal(r.lines[0]!.net, 0);
    assert.equal(r.total, 0);
  });

  test('fis indirimi satirlara oranli dagitilir ve toplam korunur', () => {
    const r = calculateSale({
      lines: [
        line({ lineNo: 1, unitPrice: money(5000) }),
        line({ lineNo: 2, unitPrice: money(3000) }),
        line({ lineNo: 3, unitPrice: money(2000) }),
      ],
      saleDiscount: { type: 'PERCENT', value: percent(10) },
    });
    assert.equal(r.saleDiscountTotal, 1000);
    const shares = r.lines.map((l) => l.saleDiscountShare);
    assert.deepEqual(shares, [500, 300, 200]);
    assert.equal(shares.reduce((a, b) => a + b, 0), r.saleDiscountTotal);
    assert.equal(r.total, 9000);
    assert.equal(r.lines.reduce((a, l) => a + l.net, 0), r.total);
  });

  test('bolunemeyen fis indiriminde kurus kaybolmaz', () => {
    const r = calculateSale({
      lines: [
        line({ lineNo: 1, unitPrice: money(333) }),
        line({ lineNo: 2, unitPrice: money(333) }),
        line({ lineNo: 3, unitPrice: money(333) }),
      ],
      saleDiscount: { type: 'AMOUNT', value: 100 },
    });
    assert.equal(r.lines.reduce((a, l) => a + l.saleDiscountShare, 0), 100);
    assert.equal(r.lines.reduce((a, l) => a + l.net, 0), r.total);
    assert.equal(r.total, 999 - 100);
  });

  test('gecersiz yuzde reddedilir', () => {
    assert.throws(() => calculateSale({
      lines: [line({ lineNo: 1 })],
      saleDiscount: { type: 'PERCENT', value: 20000 },
    }), /Gecersiz indirim/);
  });
});

describe('KDV', () => {
  test('tek oran, KDV dahil fiyattan cikarilir', () => {
    const r = calculateSale({ lines: [line({ lineNo: 1, unitPrice: money(12000), taxRateBp: KDV20 })] });
    assert.equal(r.taxTotal, 2000);
    assert.equal(r.taxBreakdown.length, 1);
    assert.equal(r.taxBreakdown[0]!.base, 10000);
  });

  test('farkli oranlar ayri gruplanir', () => {
    const r = calculateSale({
      lines: [
        line({ lineNo: 1, unitPrice: money(10100), taxRateBp: KDV1 }),
        line({ lineNo: 2, unitPrice: money(11000), taxRateBp: KDV10 }),
        line({ lineNo: 3, unitPrice: money(12000), taxRateBp: KDV20 }),
      ],
    });
    assert.equal(r.taxBreakdown.length, 3);
    assert.equal(r.taxTotal, 100 + 1000 + 2000);
    assert.equal(r.taxBreakdown.reduce((a, b) => a + b.tax, 0), r.taxTotal);
  });

  test('satir KDV toplami grup KDV toplamina esittir (kurus farki yok)', () => {
    const r = calculateSale({
      lines: [
        line({ lineNo: 1, unitPrice: money(333), taxRateBp: KDV20 }),
        line({ lineNo: 2, unitPrice: money(667), taxRateBp: KDV20 }),
        line({ lineNo: 3, unitPrice: money(101), taxRateBp: KDV20 }),
      ],
    });
    const satirToplami = r.lines.reduce((a, l) => a + l.taxAmount, 0);
    assert.equal(satirToplami, r.taxTotal);
  });

  test('indirim sonrasi KDV indirimli tutar uzerinden hesaplanir', () => {
    const r = calculateSale({
      lines: [line({ lineNo: 1, unitPrice: money(12000), taxRateBp: KDV20 })],
      saleDiscount: { type: 'PERCENT', value: percent(50) },
    });
    assert.equal(r.total, 6000);
    assert.equal(r.taxTotal, 1000);
  });
});

describe('nakit yuvarlama', () => {
  test('NONE varsayilan, yuvarlama yok', () => {
    const r = calculateSale({ lines: [line({ lineNo: 1, unitPrice: money(1234) })] });
    assert.equal(r.total, 1234);
    assert.equal(r.roundingAdjustment, 0);
  });
  test('5 kurusa yuvarlama farki ayri tutulur', () => {
    const r = calculateSale({
      lines: [line({ lineNo: 1, unitPrice: money(1234) })],
      cashRounding: 'NEAREST_5_KURUS',
    });
    assert.equal(r.total, 1235);
    assert.equal(r.roundingAdjustment, 1);
    assert.equal(r.subtotal, 1234);
  });
});

describe('toplam korunumu - rastgele senaryolar', () => {
  test('1000 rastgele fiste satir netleri toplami == fis toplami', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const rates = [KDV1, KDV10, KDV20];
    for (let i = 0; i < 1000; i++) {
      const count = 1 + rnd(6);
      const lines: CalcLine[] = [];
      for (let k = 0; k < count; k++) {
        lines.push(line({
          lineNo: k + 1,
          unit: rnd(2) === 0 ? 'KG' : 'EACH',
          quantity: quantity(1 + rnd(5000)),
          unitPrice: money(1 + rnd(50000)),
          taxRateBp: rates[rnd(3)]! as BasisPoints,
          ...(rnd(3) === 0 ? { discount: { type: 'PERCENT' as const, value: rnd(5000) } } : {}),
        }));
      }
      const saleDiscount = rnd(3) === 0
        ? { type: 'PERCENT' as const, value: rnd(3000) }
        : undefined;
      const r = calculateSale({ lines, ...(saleDiscount ? { saleDiscount } : {}) });

      const netSum = r.lines.reduce((a, l) => a + l.net, 0);
      assert.equal(netSum, r.total, `senaryo ${i}: net toplami != fis toplami`);
      assert.equal(r.lines.reduce((a, l) => a + l.saleDiscountShare, 0), r.saleDiscountTotal);
      assert.equal(r.lines.reduce((a, l) => a + l.taxAmount, 0), r.taxTotal);
      assert.ok(r.total >= 0, `senaryo ${i}: negatif toplam`);
      for (const l of r.lines) assert.ok(l.net >= 0, `senaryo ${i}: negatif satir`);
    }
  });
});

describe('odeme', () => {
  test('tam nakit', () => {
    const s = summarizePayments(money(9000), [{ method: 'CASH', tendered: money(9000) }]);
    assert.equal(s.settled, true);
    assert.equal(s.changeDue, 0);
    assert.equal(s.remaining, 0);
  });

  test('fazla nakit -> para ustu', () => {
    const s = summarizePayments(money(8750), [{ method: 'CASH', tendered: money(10000) }]);
    assert.equal(s.settled, true);
    assert.equal(s.changeDue, 1250);
    assert.equal(s.paidTotal, 8750);
  });

  test('eksik odeme kapatmaz', () => {
    const s = summarizePayments(money(9000), [{ method: 'CASH', tendered: money(5000) }]);
    assert.equal(s.settled, false);
    assert.equal(s.remaining, 4000);
  });

  test('parcali odeme: kart + nakit', () => {
    const s = summarizePayments(money(10000), [
      { method: 'CARD', tendered: money(6000) },
      { method: 'CASH', tendered: money(5000) },
    ]);
    assert.equal(s.settled, true);
    assert.equal(s.paidTotal, 10000);
    assert.equal(s.changeDue, 1000);
  });

  test('kart kalan tutari asamaz', () => {
    assert.throws(() => summarizePayments(money(5000), [
      { method: 'CARD', tendered: money(6000) },
    ]), /asamaz/);
  });

  test('negatif odeme reddedilir', () => {
    assert.throws(() => summarizePayments(money(5000), [
      { method: 'CASH', tendered: money(-100) },
    ]), /Negatif/);
  });
});
