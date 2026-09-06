import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples, type BarcodeSample } from '../../src/core/barcode/analyzer.ts';
import { BarcodeParser } from '../../src/core/barcode/parser.ts';
import { makeLabel, type LabelLayout } from '../fixtures/weighted-labels.ts';

const BASE = {
  minPlainLength: 4,
  maxPlainLength: 48,
  limits: { maxWeightMilli: 50000, maxPriceKurus: 500000, minPriceKurus: 1 },
};

/**
 * Bu test dosyasi projenin en kritik iddiasini kanitlar:
 * "CAS CL3000 formati bilinmiyor olsa bile, magazadan toplanan gercek etiketlerle
 *  format cikarilabilir ve YALNIZCA config guncellenerek sistem calisir."
 */

describe('format kesfi - agirlik gomulu bilinmeyen format', () => {
  const gizliFormat: LabelLayout = { prefix: '21', pluLength: 5, valueLength: 5, valueScale: 3 };
  const urunler = [
    { plu: 231, value: 750 },
    { plu: 231, value: 1240 },
    { plu: 231, value: 320 },
    { plu: 405, value: 500 },
    { plu: 405, value: 2150 },
    { plu: 405, value: 995 },
    { plu: 108, value: 250 },
    { plu: 108, value: 1875 },
    { plu: 962, value: 460 },
    { plu: 962, value: 3300 },
  ];
  const etiketler = urunler.map((u) => makeLabel(gizliFormat, u.plu, u.value, false));
  const sistemdekiPlus = [231, 405, 108, 962, 777, 12];

  test('PLU listesi ile dogru yerlesim bulunur', () => {
    const samples: BarcodeSample[] = etiketler.map((raw) => ({ raw }));
    const candidates = analyzeSamples(samples, { knownPlus: sistemdekiPlus });
    assert.ok(candidates.length > 0, 'aday uretilmedi');

    const top = candidates[0]!;
    assert.equal(top.rule.fields.itemCode.offset, 2);
    assert.equal(top.rule.fields.itemCode.length, 5);
    assert.equal(top.rule.fields.value.offset, 7);
    assert.equal(top.rule.fields.value.length, 5);
    assert.equal(top.rule.fields.value.kind, 'WEIGHT_KG');
    assert.equal(top.rule.fields.value.scale, 3);
    assert.equal(top.evidence.pluMatches, etiketler.length);
  });

  test('bulunan kural parser icine konunca tum etiketler dogru cozulur', () => {
    const samples: BarcodeSample[] = etiketler.map((raw) => ({ raw }));
    const top = analyzeSamples(samples, { knownPlus: sistemdekiPlus })[0]!;

    // Kesfedilen kurali etkinlestir - config'e yazilacak sey tam olarak budur
    const parser = new BarcodeParser({ ...BASE, rules: [{ ...top.rule, enabled: true }] });

    for (const [i, code] of etiketler.entries()) {
      const r = parser.parse(code);
      assert.equal(r.kind, 'WEIGHTED', `etiket ${i} cozulemedi: ${code}`);
      if (r.kind !== 'WEIGHTED') continue;
      assert.equal(Number(r.itemCode), urunler[i]!.plu, `PLU yanlis: ${code}`);
      assert.equal(r.value, urunler[i]!.value, `agirlik yanlis: ${code}`);
    }
  });

  test('etiket uzerindeki gercek deger verilirse guven KESIN olur', () => {
    const samples: BarcodeSample[] = etiketler.map((raw, i) => ({
      raw,
      knownPlu: urunler[i]!.plu,
      knownWeightMilli: urunler[i]!.value,
    }));
    const top = analyzeSamples(samples, { knownPlus: sistemdekiPlus })[0]!;
    assert.equal(top.confidence, 'KESIN');
    assert.equal(top.evidence.exactValueMatches, etiketler.length);
  });
});

describe('format kesfi - tutar gomulu bilinmeyen format', () => {
  const gizliFormat: LabelLayout = { prefix: '28', pluLength: 4, valueLength: 6, valueScale: 2 };
  const urunler = [
    { plu: 12, value: 8990 },
    { plu: 12, value: 14750 },
    { plu: 45, value: 3200 },
    { plu: 45, value: 26500 },
    { plu: 77, value: 5499 },
    { plu: 77, value: 19900 },
    { plu: 91, value: 7350 },
    { plu: 91, value: 41200 },
  ];
  const etiketler = urunler.map((u) => makeLabel(gizliFormat, u.plu, u.value, true));

  test('tutar alani dogru yorumlanir ve round-trip calisir', () => {
    const samples: BarcodeSample[] = etiketler.map((raw, i) => ({
      raw,
      knownPriceKurus: urunler[i]!.value,
    }));
    const candidates = analyzeSamples(samples, { knownPlus: [12, 45, 77, 91] });
    const top = candidates[0]!;
    assert.equal(top.rule.fields.value.kind, 'PRICE');
    assert.equal(top.confidence, 'KESIN');

    const parser = new BarcodeParser({ ...BASE, rules: [{ ...top.rule, enabled: true }] });
    for (const [i, code] of etiketler.entries()) {
      const r = parser.parse(code);
      assert.equal(r.kind, 'WEIGHTED');
      if (r.kind !== 'WEIGHTED') continue;
      assert.equal(r.value, urunler[i]!.value);
      assert.equal(Number(r.itemCode), urunler[i]!.plu);
    }
  });
});

describe('format kesfi - gomulu kontrol haneli format', () => {
  const gizliFormat: LabelLayout = {
    prefix: '212', pluLength: 4, valueLength: 4, valueScale: 2, embeddedPriceCheck: true,
  };
  const urunler = [
    { plu: 231, value: 750 },
    { plu: 231, value: 1240 },
    { plu: 405, value: 5000 },
    { plu: 405, value: 2150 },
    { plu: 108, value: 9950 },
    { plu: 108, value: 1875 },
  ];
  const etiketler = urunler.map((u) => makeLabel(gizliFormat, u.plu, u.value, true));

  test('gomulu kontrol hanesi tespit edilir', () => {
    const samples: BarcodeSample[] = etiketler.map((raw, i) => ({
      raw,
      knownPriceKurus: urunler[i]!.value,
    }));
    const candidates = analyzeSamples(samples, { knownPlus: [231, 405, 108] });
    const withEmbedded = candidates.find(
      (c) => c.rule.fields.value.embeddedCheck?.algorithm === 'PRICE_CHECK_4_GS1',
    );
    assert.ok(withEmbedded !== undefined, 'gomulu kontrol haneli aday bulunamadi');
    assert.equal(withEmbedded.evidence.embeddedCheckOk, etiketler.length);

    const parser = new BarcodeParser({
      ...BASE,
      rules: [{ ...withEmbedded.rule, enabled: true }],
    });
    for (const [i, code] of etiketler.entries()) {
      const r = parser.parse(code);
      assert.equal(r.kind, 'WEIGHTED', code);
      assert.equal(r.kind === 'WEIGHTED' && r.value, urunler[i]!.value);
    }
  });
});

describe('analizor guvenlik davranisi', () => {
  test('bos ornek listesi bos sonuc dondurur', () => {
    assert.deepEqual(analyzeSamples([]), []);
  });
  test('rakam disi ornekler yok sayilir', () => {
    assert.deepEqual(analyzeSamples([{ raw: 'ABC-123' }]), []);
  });
  test('uretilen kurallar varsayilan olarak KAPALI gelir', () => {
    const layout: LabelLayout = { prefix: '21', pluLength: 5, valueLength: 5, valueScale: 3 };
    const samples = [
      { raw: makeLabel(layout, 231, 750, false) },
      { raw: makeLabel(layout, 231, 900, false) },
    ];
    for (const c of analyzeSamples(samples, { knownPlus: [231] })) {
      assert.equal(c.rule.enabled, false, 'kesfedilen kural kendiliginden acilmamali');
    }
  });
  test('kanit yoksa guven DUSUK/ORTA olur, KESIN olmaz', () => {
    const layout: LabelLayout = { prefix: '21', pluLength: 5, valueLength: 5, valueScale: 3 };
    const samples = [
      { raw: makeLabel(layout, 231, 750, false) },
      { raw: makeLabel(layout, 405, 900, false) },
    ];
    for (const c of analyzeSamples(samples)) {
      assert.notEqual(c.confidence, 'KESIN');
    }
  });
});
