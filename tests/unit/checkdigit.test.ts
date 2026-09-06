import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyCheckDigit, appendCheckDigit, gtinCheckDigit, mod10CheckDigit, priceCheck4Gs1,
  verifyEmbeddedCheck,
} from '../../src/core/barcode/checkdigit.ts';

describe('EAN-13 kontrol hanesi', () => {
  test('bilinen gecerli barkodlar', () => {
    assert.equal(verifyCheckDigit('5901234123457', 'EAN13'), true);
    assert.equal(verifyCheckDigit('4006381333931', 'EAN13'), true);
    assert.equal(verifyCheckDigit('8690504060017', 'EAN13'), true);
  });
  test('bozuk kontrol hanesi reddedilir', () => {
    assert.equal(verifyCheckDigit('5901234123458', 'EAN13'), false);
    assert.equal(verifyCheckDigit('4006381333930', 'EAN13'), false);
  });
  test('yanlis uzunluk reddedilir', () => {
    assert.equal(verifyCheckDigit('590123412345', 'EAN13'), false);
    assert.equal(verifyCheckDigit('59012341234570', 'EAN13'), false);
  });
  test('rakam disi karakter reddedilir', () => {
    assert.equal(verifyCheckDigit('59012341234A7', 'EAN13'), false);
  });
  test('appendCheckDigit dogru haneyi ekler', () => {
    assert.equal(appendCheckDigit('590123412345', 'EAN13'), '5901234123457');
    assert.equal(gtinCheckDigit('590123412345'), 7);
  });
});

describe('EAN-8 / UPC-A', () => {
  test('bilinen gecerli barkodlar', () => {
    assert.equal(verifyCheckDigit('96385074', 'EAN8'), true);
    assert.equal(verifyCheckDigit('036000291452', 'UPCA'), true);
  });
  test('bozuk olanlar', () => {
    assert.equal(verifyCheckDigit('96385075', 'EAN8'), false);
    assert.equal(verifyCheckDigit('036000291453', 'UPCA'), false);
  });
});

describe('NONE ve MOD10', () => {
  test('NONE her zaman gecerli', () => {
    assert.equal(verifyCheckDigit('herhangi', 'NONE'), true);
  });
  test('MOD10 tutarli', () => {
    const cd = mod10CheckDigit('12345');
    assert.equal(verifyCheckDigit(`12345${cd}`, 'MOD10'), true);
    assert.equal(verifyCheckDigit('123459', 'MOD10'), cd === 9);
  });
});

describe('gomulu fiyat kontrol hanesi (GS1 4 hane)', () => {
  test('deterministik ve 0-9 araliginda', () => {
    for (let i = 0; i < 10000; i += 137) {
      const field = String(i).padStart(4, '0');
      const cd = priceCheck4Gs1(field);
      assert.ok(cd !== null && cd >= 0 && cd <= 9, `alan=${field}`);
      assert.equal(verifyEmbeddedCheck(field, String(cd), 'PRICE_CHECK_4_GS1'), true);
    }
  });
  test('yanlis hane reddedilir', () => {
    const cd = priceCheck4Gs1('1234')!;
    const wrong = String((cd + 1) % 10);
    assert.equal(verifyEmbeddedCheck('1234', wrong, 'PRICE_CHECK_4_GS1'), false);
  });
  test('4 hane disi alan null doner', () => {
    assert.equal(priceCheck4Gs1('123'), null);
    assert.equal(priceCheck4Gs1('12345'), null);
  });
  test('NONE her zaman gecer', () => {
    assert.equal(verifyEmbeddedCheck('1234', '9', 'NONE'), true);
  });
});
