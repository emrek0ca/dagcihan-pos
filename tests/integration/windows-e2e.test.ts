import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PosApplication } from '../../src/app/pos.ts';
import { PosServer } from '../../src/app/server.ts';
import { FixedClock } from '../../src/core/clock.ts';
import { NullTransport } from '../../src/hardware/printer/transports.ts';
import { SimulatorScanner } from '../../src/hardware/scanner/adapters.ts';
import { SimulatorScale } from '../../src/hardware/scale/adapters.ts';
import { testPosConfig, testBarcodeConfig } from '../helpers/harness.ts';
import { makeLabel, type LabelLayout } from '../fixtures/weighted-labels.ts';
import type { BarcodeConfigFile } from '../../src/config/types.ts';

/**
 * Windows uygulamasi ucdan uca senaryolari.
 *
 * Electron penceresi disindaki HER SEY burada gercek haliyle calisir:
 * ayni PosApplication, ayni yerel HTTP sunucusu, ayni veritabani dosyasi,
 * ayni fis kuyrugu. "Uygulamayi kill etmek" = surec nesnelerini atip
 * ayni klasorle yeniden acmak.
 */

const WEIGHT: LabelLayout = { prefix: '27', pluLength: 5, valueLength: 5, valueScale: 3 };

interface Instance {
  app: PosApplication;
  server: PosServer;
  base: string;
  printer: NullTransport;
  clock: FixedClock;
}

let dirs: string[] = [];
let live: Instance[] = [];

async function launch(options: {
  dir: string;
  barcodeConfig?: BarcodeConfigFile;
  clockAt?: number;
  printer?: NullTransport;
}): Promise<Instance> {
  const clock = new FixedClock(options.clockAt ?? Date.parse('2026-04-01T09:00:00'));
  const printer = options.printer ?? new NullTransport();
  const config = testPosConfig({ server: { host: '127.0.0.1', port: 0 } });
  const app = new PosApplication({
    config,
    barcodeConfig: options.barcodeConfig ?? testBarcodeConfig([], false),
    clock,
    databasePath: join(options.dir, 'pos.db'),
    devices: { scanner: new SimulatorScanner(), printer, scale: new SimulatorScale(), simulated: [] },
  });
  app.start();
  const server = new PosServer(app, {
    uiRoot: 'ui',
    configFiles: {
      posConfigFile: join(options.dir, 'pos.config.json'),
      barcodeConfigFile: join(options.dir, 'barcode-rules.json'),
    },
  });
  const port = await server.listen({ host: '127.0.0.1', port: 0 });
  const instance: Instance = { app, server, base: `http://127.0.0.1:${port}`, printer, clock };
  live.push(instance);
  return instance;
}

async function shutdown(instance: Instance): Promise<void> {
  await instance.server.close();
  await instance.app.stop();
  live = live.filter((i) => i !== instance);
}

/** Beklenmeyen kapanma: kontrollu kapanis YAPILMAZ, surec yok olur */
async function kill(instance: Instance): Promise<void> {
  await instance.server.close();
  instance.app.db.close();
  live = live.filter((i) => i !== instance);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pos-e2e-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const instance of [...live]) {
    try { await shutdown(instance); } catch { /* zaten kapali */ }
  }
  live = [];
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function call(base: string, method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { 'x-pos-token': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

/** Temiz kurulum: yonetici olustur, giris yap, urunleri ekle, kasayi ac */
async function prepare(instance: Instance) {
  const setup = await call(instance.base, 'GET', '/api/setup/status');
  assert.equal(setup.json.needsSetup, true, 'temiz kurulumda ilk kurulum istenmeli');

  await call(instance.base, 'POST', '/api/setup/admin', {
    username: 'yonetici', displayName: 'Yonetici', pin: '4821',
  });
  const login = await call(instance.base, 'POST', '/api/login', { username: 'yonetici', pin: '4821' });
  assert.equal(login.status, 200);
  const token = login.json.token as string;

  const findik = await call(instance.base, 'POST', '/api/admin/products', {
    code: 'F001', name: 'Ic Findik', unit: 'KG', unitPrice: 30000, taxRateBp: 100,
    stockQty: 50000, plus: [231],
  }, token);
  const su = await call(instance.base, 'POST', '/api/admin/products', {
    code: 'S001', name: 'Su 0.5L', unit: 'EACH', unitPrice: 750, taxRateBp: 1000,
    stockQty: 200000, barcodes: ['8690504060017'],
  }, token);

  await call(instance.base, 'POST', '/api/cash/open', { openingFloat: 20000 }, token);
  return { token, findik: findik.json, su: su.json };
}

describe('senaryo 1: uygulamayi ac, barkod okut, odeme al, fis bas', () => {
  test('temiz makinede kurulumdan fise kadar tek akis', async () => {
    const dir = tempDir();
    const instance = await launch({ dir });
    const { token } = await prepare(instance);

    const scan = await call(instance.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    assert.equal(scan.status, 200);
    assert.equal(scan.json.productName, 'Su 0.5L');
    const saleId = scan.json.sale.id as number;

    const complete = await call(instance.base, 'POST', '/api/sale/complete', {
      saleId,
      payments: [{ method: 'CASH', tendered: 1000 }],
      expectedTotal: 750,
      idempotencyKey: 'e2e-1',
    }, token);
    assert.equal(complete.status, 200);
    assert.equal(complete.json.receiptNo, 1);
    assert.equal(complete.json.changeDue, 250);

    await instance.app.printQueue.processDue();
    assert.equal(instance.printer.written.length, 1, 'fis basilmali');
  });
});

describe('senaryo 2: hizli ardisik barkod', () => {
  test('farkli urunler cok hizli okutuldugunda hepsi sepete girer', async () => {
    const dir = tempDir();
    const instance = await launch({ dir, barcodeConfig: testBarcodeConfig(undefined, true) });
    const { token } = await prepare(instance);

    // Gercek magaza: kasiyer farkli urunleri pesi sira okutur.
    // Tartili etiketlerin her biri farklidir (agirlik degisir) -> ayri satir olmali.
    const codes: string[] = [];
    for (let i = 0; i < 12; i++) codes.push(makeLabel(WEIGHT, 231, 200 + i * 25, false));
    for (let i = 0; i < 13; i++) codes.push(`869050406001${i % 10}`);

    const results = await Promise.all(
      codes.map((raw) => call(instance.base, 'POST', '/api/scan', { raw }, token)),
    );
    // Tartili etiketler ve tanimli duz barkod eklenir; tanimsizlar hata doner ama
    // KUYRUGU BOZMAZ - kritik olan islemin devam etmesidir.
    const accepted = results.filter((r) => r.status === 200).length;
    assert.ok(accepted >= 12, `en az 12 okuma islenmeli, islenen: ${accepted}`);

    const state = await call(instance.base, 'GET', '/api/state', undefined, token);
    const items = state.json.sale.items as { lineNo: number; quantity: number }[];
    const weighted = items.filter((i) => i.quantity !== 1000 && i.quantity % 1000 !== 0);
    assert.equal(weighted.length, 12, 'her tartili etiket ayri satir olmali');
    // Satir numaralari bosluksuz ve sirali -> yaris kosulu yok
    assert.deepEqual(
      items.map((i) => i.lineNo),
      Array.from({ length: items.length }, (_, i) => i + 1),
    );
  });

  test('ayni urun tekrar tekrar okutulunca miktar birikir', async () => {
    const dir = tempDir();
    const instance = await launch({ dir });
    const { token } = await prepare(instance);

    // Gercekci hiz: ayni urun icin okumalar arasi ~400 ms
    for (let i = 0; i < 6; i++) {
      await call(instance.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
      instance.clock.advance(400);
    }
    const state = await call(instance.base, 'GET', '/api/state', undefined, token);
    const items = state.json.sale.items as { quantity: number }[];
    assert.equal(items.length, 1, 'ayni urun tek satirda toplanmali');
    assert.equal(items[0]!.quantity, 6000, '6 adet birikmeli');
    assert.equal(state.json.sale.totals.total, 6 * 750);
  });

  test('cift okuma sicramasi (ayni etiket, ayni anda) elenir', async () => {
    const dir = tempDir();
    const instance = await launch({ dir });
    const { token } = await prepare(instance);

    // Okuyucu tek okumayi iki kez gonderirse (donanim sicramasi) ikincisi sayilmaz
    await Promise.all([
      call(instance.base, 'POST', '/api/scan', { raw: '8690504060017' }, token),
      call(instance.base, 'POST', '/api/scan', { raw: '8690504060017' }, token),
    ]);
    const state = await call(instance.base, 'GET', '/api/state', undefined, token);
    const items = state.json.sale.items as { quantity: number }[];
    assert.equal(items[0]!.quantity, 1000, 'sicrama musteriye fazla urun yazmamali');
  });
});

describe('senaryo 3: satis ortasinda uygulama kill, yeniden ac, kurtar', () => {
  test('acik fis ayni icerikle geri gelir ve tamamlanabilir', async () => {
    const dir = tempDir();
    const first = await launch({ dir });
    const { token } = await prepare(first);

    await call(first.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    await call(first.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    const before = await call(first.base, 'GET', '/api/state', undefined, token);
    const saleId = before.json.sale.id as number;
    const total = before.json.sale.totals.total as number;

    await kill(first); // === beklenmeyen kapanma ===

    const second = await launch({ dir });
    const report = second.app.start();
    assert.equal(report.openSaleRecovered, saleId, 'acik fis kurtarilmali');

    // Kasiyer tekrar giris yapar (oturum bellekte tutulur), fis yerinde durur
    const login = await call(second.base, 'POST', '/api/login', { username: 'yonetici', pin: '4821' });
    const token2 = login.json.token as string;
    const after = await call(second.base, 'GET', '/api/state', undefined, token2);
    assert.equal(after.json.sale.id, saleId);
    assert.equal(after.json.sale.totals.total, total);

    const complete = await call(second.base, 'POST', '/api/sale/complete', {
      saleId, payments: [{ method: 'CASH', tendered: total }], expectedTotal: total,
      idempotencyKey: 'e2e-recover',
    }, token2);
    assert.equal(complete.status, 200);
  });
});

describe('senaryo 4: yazici cevrimdisi', () => {
  test('satis tamamlanir, yazici gelince kuyruk basilir', async () => {
    const dir = tempDir();
    const printer = new NullTransport();
    printer.failNext(true);
    const instance = await launch({ dir, printer });
    const { token } = await prepare(instance);

    await call(instance.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    const state = await call(instance.base, 'GET', '/api/state', undefined, token);
    const complete = await call(instance.base, 'POST', '/api/sale/complete', {
      saleId: state.json.sale.id,
      payments: [{ method: 'CASH', tendered: 750 }],
      idempotencyKey: 'e2e-printer',
    }, token);

    assert.equal(complete.status, 200, 'yazici bozukken de satis tamamlanmali');
    await instance.app.printQueue.processDue();
    assert.equal(instance.printer.written.length, 0);
    assert.ok(instance.app.printQueue.pendingCount() + instance.app.printQueue.failedCount() >= 1);

    // Yazici duzeldi
    printer.failNext(false);
    await call(instance.base, 'POST', '/api/admin/maintenance/print-retry', {}, token);
    instance.clock.advance(120000);
    await instance.app.printQueue.processDue();
    assert.equal(instance.printer.written.length, 1, 'yazici gelince fis basilmali');
  });

  test('bekleyen fis uygulama yeniden acildiginda kaybolmaz', async () => {
    const dir = tempDir();
    const printer = new NullTransport();
    printer.failNext(true);
    const first = await launch({ dir, printer });
    const { token } = await prepare(first);
    await call(first.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    const state = await call(first.base, 'GET', '/api/state', undefined, token);
    await call(first.base, 'POST', '/api/sale/complete', {
      saleId: state.json.sale.id, payments: [{ method: 'CASH', tendered: 750 }],
      idempotencyKey: 'e2e-pending',
    }, token);
    await first.app.printQueue.processDue();
    await kill(first);

    const workingPrinter = new NullTransport();
    const second = await launch({ dir, printer: workingPrinter });
    const report = second.app.start();
    assert.ok(report.pendingPrintJobs >= 1, 'bekleyen fis kuyrukta kalmali');
    second.clock.advance(120000);
    await second.app.printQueue.processDue();
    assert.equal(workingPrinter.written.length, 1);
  });
});

describe('senaryo 5: ayni satis iki kez kaydedilmez', () => {
  test('ayni idempotency anahtari tek fis uretir', async () => {
    const dir = tempDir();
    const instance = await launch({ dir });
    const { token } = await prepare(instance);
    await call(instance.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    const state = await call(instance.base, 'GET', '/api/state', undefined, token);
    const payload = {
      saleId: state.json.sale.id,
      payments: [{ method: 'CASH', tendered: 750 }],
      idempotencyKey: 'e2e-dup',
    };
    const first = await call(instance.base, 'POST', '/api/sale/complete', payload, token);
    const second = await call(instance.base, 'POST', '/api/sale/complete', payload, token);
    assert.equal(first.json.receiptNo, second.json.receiptNo);

    const count = instance.app.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sales WHERE status='COMPLETED'")!.n;
    assert.equal(count, 1);
  });
});

describe('senaryo 6: yeniden baslatma sonrasi veri korunur', () => {
  test('urun, stok, satis ve kasa oturumu aynen durur', async () => {
    const dir = tempDir();
    const first = await launch({ dir });
    const { token } = await prepare(first);
    await call(first.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    const state = await call(first.base, 'GET', '/api/state', undefined, token);
    await call(first.base, 'POST', '/api/sale/complete', {
      saleId: state.json.sale.id, payments: [{ method: 'CASH', tendered: 750 }],
      idempotencyKey: 'e2e-persist',
    }, token);
    await shutdown(first); // kontrollu kapanis

    const second = await launch({ dir });
    second.app.start();
    const login = await call(second.base, 'POST', '/api/login', { username: 'yonetici', pin: '4821' });
    const token2 = login.json.token as string;

    const products = await call(second.base, 'GET', '/api/admin/products', undefined, token2);
    assert.equal(products.json.length, 2, 'urunler korunmali');
    const su = products.json.find((p: { code: string }) => p.code === 'S001');
    assert.equal(su.stockQty, 200000 - 1000, 'stok korunmali');

    const sales = await call(second.base, 'GET', '/api/admin/sales', undefined, token2);
    assert.equal(sales.json.length, 1, 'satis gecmisi korunmali');
    assert.equal(sales.json[0].total, 750);

    const cash = await call(second.base, 'GET', '/api/cash/summary', undefined, token2);
    assert.equal(cash.json.expectedCash, 20000 + 750, 'kasa oturumu korunmali');
  });
});

describe('senaryo 7: normal barkod ile tartili barkod ayrimi', () => {
  test('format tanimlanmadan tartili etiket satisa GIRMEZ', async () => {
    const dir = tempDir();
    const instance = await launch({ dir, barcodeConfig: testBarcodeConfig([], false) });
    const { token } = await prepare(instance);

    const plain = await call(instance.base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    assert.equal(plain.status, 200, 'normal barkod calismali');

    const weighted = await call(instance.base, 'POST', '/api/scan',
      { raw: makeLabel(WEIGHT, 231, 750, false) }, token);
    assert.equal(weighted.status, 400);
    assert.equal(weighted.json.error.code, 'WEIGHTED_FORMAT_NOT_CONFIGURED');
  });

  test('kalibrasyon sonrasi tartili etiket dogru fiyatla girer', async () => {
    const dir = tempDir();
    // Yonetim ekraninin yazacagi gercek config dosyalari
    writeFileSync(join(dir, 'barcode-rules.json'), JSON.stringify({
      weightedFormatConfirmed: false, discoveryPrefixes: ['2'],
      minPlainLength: 4, maxPlainLength: 48,
      limits: { maxWeightMilli: 50000, maxPriceKurus: 500000, minPriceKurus: 1 },
      rules: [],
    }));

    const first = await launch({ dir, barcodeConfig: testBarcodeConfig([], false) });
    const { token } = await prepare(first);

    // Kasada cozulemeyen etiketler birikir
    const labels = [[231, 750], [231, 1240], [231, 500]] as const;
    for (const [plu, grams] of labels) {
      await call(first.base, 'POST', '/api/scan', { raw: makeLabel(WEIGHT, plu, grams, false) }, token);
    }

    // Yonetim -> Terazi Barkodu -> cozumle
    const analyze = await call(first.base, 'POST', '/api/admin/barcode/analyze', {
      samples: [{ raw: makeLabel(WEIGHT, 231, 750, false), knownPlu: 231, knownWeightMilli: 750 }],
    }, token);
    assert.ok(analyze.json.candidates.length > 0);
    const best = analyze.json.candidates[0];
    assert.equal(best.confidence, 'KESIN');

    const applied = await call(first.base, 'POST', '/api/admin/barcode/apply',
      { rule: best.rule }, token);
    assert.equal(applied.json.ok, true);
    assert.equal(applied.json.restartRequired, true);

    // Config dosyasina yazildi mi
    const written = JSON.parse(readFileSync(join(dir, 'barcode-rules.json'), 'utf8'));
    assert.equal(written.weightedFormatConfirmed, true);
    assert.equal(written.rules[0].enabled, true);

    await shutdown(first);

    // Yeniden baslatma -> yeni kural yuklu
    const second = await launch({
      dir,
      barcodeConfig: { ...written, discoveryPrefixes: ['2'] } as BarcodeConfigFile,
    });
    second.app.start();
    const login = await call(second.base, 'POST', '/api/login', { username: 'yonetici', pin: '4821' });
    const token2 = login.json.token as string;

    const scan = await call(second.base, 'POST', '/api/scan',
      { raw: makeLabel(WEIGHT, 231, 750, false) }, token2);
    assert.equal(scan.status, 200);
    assert.equal(scan.json.productName, 'Ic Findik');
    // 0,750 kg x 300,00 TL/kg = 225,00 TL
    assert.equal(scan.json.sale.totals.total, 22500);

    // Normal barkod hala calisiyor
    const plain = await call(second.base, 'POST', '/api/scan', { raw: '8690504060017' }, token2);
    assert.equal(plain.status, 200);
    assert.equal(plain.json.sale.totals.total, 22500 + 750);
  });
});

describe('senaryo 8: yonetim ekranlari mevcut backend uzerinden calisir', () => {
  test('urun, stok, kasiyer ve rapor uc noktalari', async () => {
    const dir = tempDir();
    const instance = await launch({ dir });
    const { token, findik } = await prepare(instance);

    // Fiyat guncelleme
    const updated = await call(instance.base, 'PUT', `/api/admin/products/${findik.id}`,
      { unitPrice: 32000 }, token);
    assert.equal(updated.json.unitPrice, 32000);

    // Barkod ve PLU yonetimi
    const withBarcode = await call(instance.base, 'POST', `/api/admin/products/${findik.id}/barcodes`,
      { barcode: '2000000000019' }, token);
    assert.ok(withBarcode.json.barcodes.includes('2000000000019'));
    const removed = await call(instance.base, 'DELETE',
      `/api/admin/products/${findik.id}/barcodes/2000000000019`, undefined, token);
    assert.equal(removed.json.barcodes.length, 0);

    const withPlu = await call(instance.base, 'POST', `/api/admin/products/${findik.id}/plus`,
      { plu: 999 }, token);
    assert.ok(withPlu.json.plus.includes(999));

    // Stok duzeltme
    const adjust = await call(instance.base, 'POST', '/api/admin/stock/adjust', {
      productId: findik.id, delta: -1500, type: 'WASTE', note: 'fire',
    }, token);
    assert.equal(adjust.json.balanceAfter, 50000 - 1500);
    const verify = await call(instance.base, 'GET', '/api/admin/stock/verify', undefined, token);
    assert.equal(verify.json.ok, true);

    // Kasiyer olusturma ve yetki siniri
    const cashier = await call(instance.base, 'POST', '/api/admin/users', {
      username: 'kasiyer', displayName: 'Kasiyer', pin: '1234', role: 'CASHIER',
    }, token);
    assert.equal(cashier.status, 200);
    const cashierLogin = await call(instance.base, 'POST', '/api/login',
      { username: 'kasiyer', pin: '1234' });
    const denied = await call(instance.base, 'GET', '/api/admin/users', undefined,
      cashierLogin.json.token);
    assert.equal(denied.status, 401, 'kasiyer kullanici yonetimini goremez');

    // Raporlar
    const daily = await call(instance.base, 'GET', '/api/admin/reports/daily', undefined, token);
    assert.equal(daily.status, 200);
    const diagnostics = await call(instance.base, 'GET', '/api/admin/diagnostics', undefined, token);
    assert.equal(diagnostics.json.database.ok, true);
    assert.equal(diagnostics.json.audit.ok, true);
  });

  test('yazici ayarlari config dosyasina yazilir', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'pos.config.json'), JSON.stringify(testPosConfig()));
    const instance = await launch({ dir });
    const { token } = await prepare(instance);

    const result = await call(instance.base, 'PUT', '/api/admin/printer/settings', {
      adapter: 'TCP', codePage: 'CP1254:25', tcp: { host: '192.168.1.50', port: 9100 },
    }, token);
    assert.equal(result.json.restartRequired, true);

    const written = JSON.parse(readFileSync(join(dir, 'pos.config.json'), 'utf8'));
    assert.equal(written.devices.printer.adapter, 'TCP');
    assert.equal(written.devices.printer.codePage, 'CP1254:25');
    assert.equal(written.devices.printer.tcp.host, '192.168.1.50');
  });

  test('ilk kurulum yalnizca bir kez calisir', async () => {
    const dir = tempDir();
    const instance = await launch({ dir });
    await prepare(instance);
    const second = await call(instance.base, 'POST', '/api/setup/admin', {
      username: 'baska', displayName: 'Baska', pin: '1111',
    });
    assert.equal(second.status, 401);
    const status = await call(instance.base, 'GET', '/api/setup/status');
    assert.equal(status.json.needsSetup, false);
  });
});
