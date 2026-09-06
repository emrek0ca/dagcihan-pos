import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { money } from '../../src/core/money/money.ts';
import {
  quantity, parseQuantity, formatQuantity, formatQuantityWithUnit,
  lineAmount, deriveQuantity, isWholeUnits, ONE_UNIT,
} from '../../src/core/quantity/quantity.ts';

describe('parseQuantity', () => {
  test('kg ondalik', () => {
    assert.equal(parseQuantity('0,750'), 750);
    assert.equal(parseQuantity('0.750'), 750);
    assert.equal(parseQuantity('1'), 1000);
    assert.equal(parseQuantity('2,5'), 2500);
    assert.equal(parseQuantity('0,005'), 5);
  });
  test('4. haneye gore yuvarlar', () => {
    assert.equal(parseQuantity('0,7505'), 751);
    assert.equal(parseQuantity('0,7504'), 750);
  });
  test('gecersiz', () => {
    assert.throws(() => parseQuantity('x'), RangeError);
  });
});

describe('formatQuantity', () => {
  test('kg 3 hane', () => {
    assert.equal(formatQuantity(quantity(750), 'KG'), '0,750');
    assert.equal(formatQuantity(quantity(1250), 'KG'), '1,250');
    assert.equal(formatQuantityWithUnit(quantity(750), 'KG'), '0,750 kg');
  });
  test('adet tam sayi gosterir', () => {
    assert.equal(formatQuantity(quantity(3000), 'EACH'), '3');
    assert.equal(formatQuantityWithUnit(quantity(1000), 'EACH'), '1 adet');
  });
});

describe('lineAmount - satir tutari', () => {
  test('0,750 kg x 120,00 TL/kg = 90,00 TL', () => {
    assert.equal(lineAmount(quantity(750), money(12000)), 9000);
  });
  test('1 adet x 24,90 TL = 24,90 TL', () => {
    assert.equal(lineAmount(ONE_UNIT, money(2490)), 2490);
  });
  test('3 adet x 24,90 = 74,70', () => {
    assert.equal(lineAmount(quantity(3000), money(2490)), 7470);
  });
  test('yuvarlama gerektiren gercek senaryo: 0,333 kg x 89,90', () => {
    // 29,9367 -> 29,94
    assert.equal(lineAmount(quantity(333), money(8990)), 2994);
  });
  test('0,001 kg x 1,00 -> 0,00 (asagi yuvarlanir, negatif olmaz)', () => {
    assert.equal(lineAmount(quantity(1), money(100)), 0);
  });
});

describe('deriveQuantity - tutar gomulu barkod icin', () => {
  test('90,00 TL / 120,00 TL-kg = 0,750 kg', () => {
    assert.equal(deriveQuantity(money(9000), money(12000)), 750);
  });
  test('birim fiyat sifirsa turetilemez', () => {
    assert.equal(deriveQuantity(money(9000), money(0)), null);
  });
});

describe('isWholeUnits', () => {
  test('adet kontrolu', () => {
    assert.equal(isWholeUnits(quantity(3000)), true);
    assert.equal(isWholeUnits(quantity(2500)), false);
  });
});
