import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  money, percent, roundedDiv, addMoney, subMoney, applyBasisPoints,
  taxFromGross, distribute, parseMoney, formatMoney, formatMoneyTRY,
} from '../../src/core/money/money.ts';

describe('roundedDiv - ticari yuvarlama', () => {
  test('yarim sifirdan uzaga yuvarlanir', () => {
    assert.equal(roundedDiv(15, 2), 8);
    assert.equal(roundedDiv(-15, 2), -8);
    assert.equal(roundedDiv(14, 2), 7);
    assert.equal(roundedDiv(13, 2), 7);
    assert.equal(roundedDiv(11, 2), 6);
  });
  test('tam bolunme', () => {
    assert.equal(roundedDiv(100, 4), 25);
    assert.equal(roundedDiv(0, 7), 0);
  });
  test('sifira bolme hata verir', () => {
    assert.throws(() => roundedDiv(1, 0), RangeError);
  });
  test('float hatasi olusmaz - klasik 0.1+0.2 tuzagi', () => {
    // 0,10 + 0,20 = 0,30 tam olmali
    assert.equal(addMoney(money(10), money(20)), 30);
  });
});

describe('money guvenlik sinirlari', () => {
  test('tam sayi olmayan reddedilir', () => {
    assert.throws(() => money(12.5), RangeError);
  });
  test('asiri buyuk deger reddedilir', () => {
    assert.throws(() => money(10_000_000_000_00), RangeError);
  });
});

describe('parseMoney', () => {
  test('TR ve EN ondalik ayiricilari', () => {
    assert.equal(parseMoney('12,45'), 1245);
    assert.equal(parseMoney('12.45'), 1245);
    assert.equal(parseMoney('1.234,56'), 123456);
    assert.equal(parseMoney('1,234.56'), 123456);
    assert.equal(parseMoney('7'), 700);
    assert.equal(parseMoney('0,05'), 5);
  });
  test('ucuncu haneye gore yuvarlar', () => {
    assert.equal(parseMoney('12,455'), 1246);
    assert.equal(parseMoney('12,454'), 1245);
  });
  test('negatif', () => {
    assert.equal(parseMoney('-3,50'), -350);
  });
  test('gecersiz girdi', () => {
    assert.throws(() => parseMoney('abc'), RangeError);
    assert.throws(() => parseMoney(''), RangeError);
    assert.throws(() => parseMoney('1,2,3'), RangeError);
  });
});

describe('formatMoney', () => {
  test('binlik ayirici ve iki hane kurus', () => {
    assert.equal(formatMoney(money(123456)), '1.234,56');
    assert.equal(formatMoney(money(5)), '0,05');
    assert.equal(formatMoney(money(0)), '0,00');
    assert.equal(formatMoney(money(100000000)), '1.000.000,00');
    assert.equal(formatMoney(money(-350)), '-3,50');
    assert.equal(formatMoneyTRY(money(9000)), '90,00 TL');
  });
});

describe('yuzde ve KDV', () => {
  test('percent baz puana cevirir', () => {
    assert.equal(percent(10), 1000);
    assert.equal(percent(12.5), 1250);
    assert.equal(percent(20), 2000);
  });
  test('indirim hesabi', () => {
    assert.equal(applyBasisPoints(money(10000), percent(10)), 1000);
    assert.equal(applyBasisPoints(money(9999), percent(10)), 1000); // 999,9 -> 1000
    assert.equal(applyBasisPoints(money(333), percent(33.33)), 111);
  });
  test('KDV dahil tutardan KDV cikarma', () => {
    // 120,00 TL, %20 KDV dahil -> KDV 20,00
    assert.equal(taxFromGross(money(12000), percent(20)), 2000);
    // 110,00 TL, %10 KDV dahil -> KDV 10,00
    assert.equal(taxFromGross(money(11000), percent(10)), 1000);
    // %1 KDV
    assert.equal(taxFromGross(money(10100), percent(1)), 100);
    assert.equal(taxFromGross(money(0), percent(20)), 0);
  });
});

describe('distribute - toplam korunumu', () => {
  test('kurus artigi kaybolmaz', () => {
    const parts = distribute(money(100), [1, 1, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 100);
    assert.deepEqual(parts, [34, 33, 33]);
  });
  test('agirlikli dagitim', () => {
    const parts = distribute(money(1000), [5000, 3000, 2000]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
    assert.deepEqual(parts, [500, 300, 200]);
  });
  test('zor artik senaryosu', () => {
    const parts = distribute(money(1), [1, 1, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 1);
  });
  test('rastgele 500 senaryoda toplam daima korunur', () => {
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 500; i++) {
      const count = 1 + rnd(8);
      const weights = Array.from({ length: count }, () => rnd(50000));
      const amount = money(rnd(100000));
      const parts = distribute(amount, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), amount, `i=${i}`);
    }
  });
  test('bos liste', () => {
    assert.deepEqual(distribute(money(500), []), []);
  });
  test('sifir agirlikta esit dagitim', () => {
    const parts = distribute(money(10), [0, 0, 0]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 10);
  });
});
