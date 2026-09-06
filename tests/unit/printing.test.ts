import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeText, toAscii } from '../../src/hardware/printer/encoding.ts';
import { EscPosBuilder, decodeStatus } from '../../src/hardware/printer/escpos.ts';
import { renderReceipt } from '../../src/modules/printing/render.ts';
import { escPosToPlainText } from '../../src/modules/printing/preview.ts';
import type { ReceiptDocument } from '../../src/modules/printing/document.ts';

const OPTIONS = { codePage: 'CP857' as const, codePageIndex: 15, charactersPerLine: 48 };

function textOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x0a) out += '\n';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
  }
  return out;
}

describe('Turkce karakter kodlamasi', () => {
  test('CP857 Turkce harfleri tek bayta cevirir', () => {
    const bytes = encodeText('ıİşŞğĞçÇöÖüÜ', 'CP857');
    assert.deepEqual([...bytes], [0x8d, 0x98, 0x9f, 0x9e, 0xa7, 0xa6, 0x87, 0x80, 0x94, 0x99, 0x81, 0x9a]);
  });
  test('CP1254 Turkce harfleri tek bayta cevirir', () => {
    const bytes = encodeText('ıİşŞğĞ', 'CP1254');
    assert.deepEqual([...bytes], [0xfd, 0xdd, 0xfe, 0xde, 0xf0, 0xd0]);
  });
  test('ASCII modunda harfler cevrilir, fis bozulmaz', () => {
    assert.equal(textOf(encodeText('Ic Fındık ŞEKER', 'ASCII')), 'Ic Findik SEKER');
  });
  test('eslenemeyen karakter fisi bozmaz', () => {
    const bytes = encodeText('fiyat 10₺', 'CP857');
    assert.equal(textOf(bytes), 'fiyat 10TL');
  });
  test('toAscii tum Turkce harfleri kapsar', () => {
    assert.equal(toAscii('ĞÜŞİÖÇğüşıöç'), 'GUSIOCgusioc');
  });
  test('ASCII karakterler degismez', () => {
    assert.deepEqual([...encodeText('ABC 123', 'CP857')], [65, 66, 67, 32, 49, 50, 51]);
  });
});

describe('ESC/POS komutlari', () => {
  test('init kod sayfasi secimini icerir', () => {
    const bytes = new EscPosBuilder(OPTIONS).init().build();
    assert.deepEqual([...bytes], [0x1b, 0x40, 0x1b, 0x74, 15]);
  });
  test('iki sutun saga yaslanir ve satir genisligini korur', () => {
    const bytes = new EscPosBuilder(OPTIONS).columns('Ic Findik', '225,00').build();
    const line = textOf(bytes).replace('\n', '');
    assert.equal(line.length, 48);
    assert.ok(line.startsWith('Ic Findik'));
    assert.ok(line.endsWith('225,00'));
  });
  test('uzun urun adi kirpilir ama TUTAR asla kirpilmaz', () => {
    const long = 'Cok Uzun Bir Urun Adi '.repeat(5);
    const line = textOf(new EscPosBuilder(OPTIONS).columns(long, '1.234,56').build()).replace('\n', '');
    assert.ok(line.length <= 48);
    assert.ok(line.endsWith('1.234,56'), 'tutar tam gorunmeli');
  });
  test('kesme komutu uretilir', () => {
    const bytes = [...new EscPosBuilder(OPTIONS).cut().build()];
    assert.ok(bytes.join(',').includes('29,86,66,0'), 'GS V 66 0 bulunmali');
  });
  test('cekmece komutu uretilir', () => {
    assert.deepEqual([...new EscPosBuilder(OPTIONS).openDrawer().build()], [0x1b, 0x70, 0, 25, 250]);
  });
  test('CODE128 barkod veriyi tasir', () => {
    const bytes = new EscPosBuilder(OPTIONS).barcodeCode128('A42').build();
    assert.ok(textOf(bytes).includes('{BA42'));
  });
});

describe('yazici durum cozumu', () => {
  test('normal durum: cevrimici, kagit var', () => {
    const status = decodeStatus({ printer: 0x16, offline: 0x12, error: 0x12, paper: 0x12 });
    assert.equal(status.online, true);
    assert.equal(status.paperOut, false);
    assert.equal(status.coverOpen, false);
  });
  test('kagit bitti', () => {
    assert.equal(decodeStatus({ paper: 0x72 }).paperOut, true);
  });
  test('kapak acik', () => {
    assert.equal(decodeStatus({ offline: 0x16 }).coverOpen, true);
  });
  test('cevrimdisi', () => {
    assert.equal(decodeStatus({ printer: 0x1e }).online, false);
  });
});

describe('fis cikti icerigi', () => {
  const doc: ReceiptDocument = {
    kind: 'RECEIPT',
    storeName: 'DAGCIHAN KURUYEMIS',
    storeLines: ['Merkez Mah. No 1'],
    title: 'SATIS FISI',
    meta: [
      { label: 'Tarih', value: '06.09.2026' },
      { label: 'Fis No', value: 'A1' },
      { label: 'Kasa', value: '1 Nolu Kasa' },
      { label: 'Kasiyer', value: 'Ayse Kaya' },
    ],
    lines: [
      { name: 'Ic Findik', detail: '0,750 kg x 300,00', amount: '225,00' },
      { name: 'Su 0.5L', detail: '', amount: '7,50' },
    ],
    totals: [{ label: 'TOPLAM', value: '232,50', emphasize: true }],
    taxRows: [{ label: 'KDV %1', base: '230,20', tax: '2,30' }],
    payments: [
      { label: 'NAKIT', value: '250,00' },
      { label: 'PARA USTU', value: '17,50' },
    ],
    footer: ['Tesekkurler'],
    barcodeData: 'A1',
    copy: false,
    openDrawer: true,
  };

  test('zorunlu alanlarin tamami fiste yer alir', () => {
    const text = textOf(renderReceipt(doc, OPTIONS));
    for (const required of [
      'DAGCIHAN KURUYEMIS', 'SATIS FISI', '06.09.2026', 'A1', '1 Nolu Kasa', 'Ayse Kaya',
      'Ic Findik', '0,750 kg x 300,00', '225,00', 'TOPLAM', '232,50',
      'NAKIT', '250,00', 'PARA USTU', 'KDV %1', 'Tesekkurler',
    ]) {
      assert.ok(text.includes(required), `fiste eksik: ${required}`);
    }
  });

  test('kopya fisi acikca isaretlenir', () => {
    const text = textOf(renderReceipt({ ...doc, copy: true }, OPTIONS));
    assert.ok(text.includes('KOPYA'), 'tekrar basimda kopya damgasi olmali');
  });

  test('simulator fisi gercek sanilmaz', () => {
    const text = textOf(renderReceipt({ ...doc, simulated: true }, OPTIONS));
    assert.ok(text.includes('SIMULATOR'));
    assert.ok(text.includes('GECERSIZ'));
  });

  test('nakit odemede cekmece darbesi gonderilir', () => {
    const bytes = [...renderReceipt(doc, OPTIONS)].join(',');
    assert.ok(bytes.includes('27,112,0,25,250'), 'cekmece komutu bulunmali');
  });

  test('kart odemede cekmece acilmaz', () => {
    const bytes = [...renderReceipt({ ...doc, openDrawer: false }, OPTIONS)].join(',');
    assert.ok(!bytes.includes('27,112,0,25,250'));
  });

  test('hicbir satir yazici genisligini asmaz', () => {
    const text = escPosToPlainText(renderReceipt(doc, OPTIONS));
    for (const line of text.split('\n')) {
      assert.ok(line.length <= 48, `cok uzun satir (${line.length}): ${line}`);
    }
  });
});
