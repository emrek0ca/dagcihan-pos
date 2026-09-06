import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BarcodeParser, normalizeRaw, validateConfig } from '../../src/core/barcode/parser.ts';
import { appendCheckDigit } from '../../src/core/barcode/checkdigit.ts';
import type { BarcodeParserConfig, WeightedBarcodeRule } from '../../src/core/barcode/types.ts';
import { makeLabel, type LabelLayout } from '../fixtures/weighted-labels.ts';

const BASE: Omit<BarcodeParserConfig, 'rules'> = {
  minPlainLength: 4,
  maxPlainLength: 48,
  limits: { maxWeightMilli: 50000, maxPriceKurus: 500000, minPriceKurus: 1 },
};

const WEIGHT_LAYOUT: LabelLayout = { prefix: '27', pluLength: 5, valueLength: 5, valueScale: 3 };
const PRICE_LAYOUT: LabelLayout = { prefix: '28', pluLength: 5, valueLength: 5, valueScale: 2 };

const weightRule: WeightedBarcodeRule = {
  id: 'test-weight',
  enabled: true,
  priority: 10,
  length: 13,
  match: { type: 'prefix', value: '27' },
  checkDigit: { algorithm: 'EAN13' },
  fields: {
    itemCode: { offset: 2, length: 5, lookup: 'PLU', stripLeadingZeros: true },
    value: { offset: 7, length: 5, scale: 3, kind: 'WEIGHT_KG' },
  },
};

const priceRule: WeightedBarcodeRule = {
  ...weightRule,
  id: 'test-price',
  priority: 11,
  match: { type: 'prefix', value: '28' },
  fields: {
    itemCode: { offset: 2, length: 5, lookup: 'PLU', stripLeadingZeros: true },
    value: { offset: 7, length: 5, scale: 2, kind: 'PRICE' },
  },
};

describe('normalizeRaw', () => {
  test('CR/LF, sekme ve bosluk temizlenir', () => {
    assert.equal(normalizeRaw('  8690504060017CRLF'.replace('CRLF', String.fromCharCode(13, 10))), '8690504060017');
    assert.equal(normalizeRaw('869TAB050 4060017'.replace('TAB', String.fromCharCode(9))), '8690504060017');
    assert.equal(normalizeRaw('8690504060017'), '8690504060017');
  });
  test('bos girdi bos doner', () => {
    assert.equal(normalizeRaw(String.fromCharCode(13, 10)), '');
  });
});

describe('tartili barkod cozumleme', () => {
  const parser = new BarcodeParser({ ...BASE, rules: [weightRule, priceRule] });

  test('agirlik gomulu etiket', () => {
    const code = makeLabel(WEIGHT_LAYOUT, 231, 750, false);
    const r = parser.parse(code);
    assert.equal(r.kind, 'WEIGHTED');
    if (r.kind !== 'WEIGHTED') return;
    assert.equal(r.itemCode, '231');
    assert.equal(r.valueKind, 'WEIGHT_KG');
    assert.equal(r.value, 750);
    assert.equal(r.ruleId, 'test-weight');
  });

  test('tutar gomulu etiket', () => {
    const code = makeLabel(PRICE_LAYOUT, 1042, 8990, true);
    const r = parser.parse(code);
    assert.equal(r.kind, 'WEIGHTED');
    if (r.kind !== 'WEIGHTED') return;
    assert.equal(r.itemCode, '1042');
    assert.equal(r.valueKind, 'PRICE');
    assert.equal(r.value, 8990);
  });

  test('kontrol hanesi bozuksa satir eklenmez (INVALID)', () => {
    const code = makeLabel(WEIGHT_LAYOUT, 231, 750, false);
    const broken = code.slice(0, 12) + String((Number(code[12]) + 1) % 10);
    const r = parser.parse(broken);
    assert.equal(r.kind, 'INVALID');
    if (r.kind !== 'INVALID') return;
    assert.equal(r.reason, 'CHECK_DIGIT');
  });

  test('sifir agirlikli etiket reddedilir', () => {
    const code = makeLabel(WEIGHT_LAYOUT, 231, 0, false);
    const r = parser.parse(code);
    assert.equal(r.kind, 'INVALID');
    if (r.kind !== 'INVALID') return;
    assert.equal(r.reason, 'ZERO_VALUE');
  });

  test('sinir disi agirlik tartili satisa girmez', () => {
    const small = new BarcodeParser({
      ...BASE,
      limits: { ...BASE.limits, maxWeightMilli: 500 },
      rules: [weightRule],
    });
    const code = makeLabel(WEIGHT_LAYOUT, 231, 25000, false);
    const r = small.parse(code);
    assert.notEqual(r.kind, 'WEIGHTED');
  });

  test('satir sonu ekli okuma da cozumlenir', () => {
    const code = makeLabel(WEIGHT_LAYOUT, 231, 1234, false);
    const r = parser.parse(code + String.fromCharCode(13, 10));
    assert.equal(r.kind, 'WEIGHTED');
  });

  test('bastaki sifirlar kirpilir', () => {
    const code = makeLabel(WEIGHT_LAYOUT, 7, 500, false);
    const r = parser.parse(code);
    assert.equal(r.kind === 'WEIGHTED' && r.itemCode, '7');
  });

  test('ayni etiket iki kez okunursa ayni sonucu verir (deterministik)', () => {
    const code = makeLabel(WEIGHT_LAYOUT, 231, 750, false);
    assert.deepEqual(parser.parse(code), parser.parse(code));
  });
});

describe('gomulu kontrol haneli format', () => {
  const layout: LabelLayout = {
    prefix: '299', pluLength: 4, valueLength: 4, valueScale: 2, embeddedPriceCheck: true,
  };
  const rule: WeightedBarcodeRule = {
    id: 'test-embedded',
    enabled: true,
    priority: 10,
    length: 13,
    match: { type: 'prefix', value: '299' },
    checkDigit: { algorithm: 'EAN13' },
    fields: {
      itemCode: { offset: 3, length: 4, lookup: 'PLU', stripLeadingZeros: true },
      value: {
        offset: 8, length: 4, scale: 2, kind: 'PRICE',
        embeddedCheck: { algorithm: 'PRICE_CHECK_4_GS1', offset: 7 },
      },
    },
  };
  const parser = new BarcodeParser({ ...BASE, rules: [rule] });

  test('gecerli gomulu kontrol hanesi kabul edilir', () => {
    const code = makeLabel(layout, 1234, 4550, true);
    const r = parser.parse(code);
    assert.equal(r.kind, 'WEIGHTED');
    assert.equal(r.kind === 'WEIGHTED' && r.value, 4550);
  });

  test('gomulu kontrol hanesi bozuksa reddedilir', () => {
    const code = makeLabel(layout, 1234, 4550, true);
    const digit = Number(code[7]);
    const body = code.slice(0, 7) + String((digit + 1) % 10) + code.slice(8, 12);
    const r = parser.parse(appendCheckDigit(body, 'EAN13'));
    assert.equal(r.kind, 'INVALID');
    assert.equal(r.kind === 'INVALID' && r.reason, 'EMBEDDED_CHECK_DIGIT');
  });
});

describe('duz barkod', () => {
  const parser = new BarcodeParser({ ...BASE, rules: [weightRule] });

  test('normal EAN-13 duz gecer', () => {
    const r = parser.parse('8690504060017');
    assert.equal(r.kind, 'PLAIN');
    assert.equal(r.kind === 'PLAIN' && r.checkDigitValid, true);
  });
  test('Code128 benzeri alfanumerik duz gecer', () => {
    const r = parser.parse('ABC-12345');
    assert.equal(r.kind, 'PLAIN');
    assert.equal(r.kind === 'PLAIN' && r.checkDigitValid, null);
  });
  test('cok kisa reddedilir', () => {
    assert.equal(parser.parse('12').kind, 'INVALID');
  });
  test('bos okuma EMPTY', () => {
    assert.equal(parser.parse(String.fromCharCode(13, 10)).kind, 'EMPTY');
  });
});

describe('kural devre disi iken tartili etiket satisa GIRMEZ', () => {
  test('kural kapaliysa etiket duz barkod olur, urun bulunamaz (guvenli)', () => {
    const parser = new BarcodeParser({ ...BASE, rules: [{ ...weightRule, enabled: false }] });
    const code = makeLabel(WEIGHT_LAYOUT, 231, 750, false);
    const r = parser.parse(code);
    assert.equal(r.kind, 'PLAIN');
  });
});

describe('kural onceligi', () => {
  test('dusuk priority once denenir', () => {
    const a: WeightedBarcodeRule = { ...weightRule, id: 'a', priority: 5 };
    const b: WeightedBarcodeRule = { ...weightRule, id: 'b', priority: 1 };
    const parser = new BarcodeParser({ ...BASE, rules: [a, b] });
    const code = makeLabel(WEIGHT_LAYOUT, 231, 750, false);
    const r = parser.parse(code);
    assert.equal(r.kind === 'WEIGHTED' && r.ruleId, 'b');
  });
});

describe('config dogrulama', () => {
  const bad = (rule: WeightedBarcodeRule) => () => validateConfig({ ...BASE, rules: [rule] });

  test('alan barkod disina tasarsa hata', () => {
    assert.throws(bad({
      ...weightRule,
      fields: {
        ...weightRule.fields,
        value: { offset: 10, length: 6, scale: 3, kind: 'WEIGHT_KG' },
      },
    }), /tasiyor/);
  });
  test('alanlar cakisirsa hata', () => {
    assert.throws(bad({
      ...weightRule,
      fields: {
        ...weightRule.fields,
        value: { offset: 4, length: 5, scale: 3, kind: 'WEIGHT_KG' },
      },
    }), /cakisiyor/);
  });
  test('yinelenen id hata', () => {
    assert.throws(() => validateConfig({ ...BASE, rules: [weightRule, weightRule] }), /Yinelenen/);
  });
  test('gecersiz regex hata', () => {
    assert.throws(bad({ ...weightRule, match: { type: 'regex', pattern: '([' } }), /regex/);
  });
  test('PRICE_CHECK_4_GS1 yalnizca 4 haneli alanda', () => {
    assert.throws(bad({
      ...weightRule,
      fields: {
        ...weightRule.fields,
        value: {
          offset: 7, length: 5, scale: 2, kind: 'PRICE',
          embeddedCheck: { algorithm: 'PRICE_CHECK_4_GS1', offset: 6 },
        },
      },
    }), /4 haneli/);
  });
});
