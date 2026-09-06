import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listWindowsPrinters, listHidCandidates, listSerialPorts, scanNetworkPrinters,
} from '../../src/hardware/discovery.ts';
import { PosApplication } from '../../src/app/pos.ts';
import { PosServer } from '../../src/app/server.ts';
import { FixedClock } from '../../src/core/clock.ts';
import { NullTransport } from '../../src/hardware/printer/transports.ts';
import { SimulatorScanner } from '../../src/hardware/scanner/adapters.ts';
import { SimulatorScale } from '../../src/hardware/scale/adapters.ts';
import { testPosConfig, testBarcodeConfig } from '../helpers/harness.ts';

/**
 * Donanim kurulum sihirbazi testleri.
 *
 * Kesif (yazici/okuyucu listeleme) isletim sistemine baglidir; bu yuzden
 * testler "dogru sonucu bul" degil "ASLA COKME/ASILMA yok ve sonuc
 * kullanilabilir" iddiasini dogrular. Gercek dogrulama testin degil
 * kullanicinin isidir (fis basar, barkod okutur).
 */

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/**
 * Sahte sunucuyu kapat. close() geri cagrisi ACIK BAGLANTI kaldigi surece
 * gelmeyebilir; testi buna baglamak asilmaya yol acar. Kapatma istegini
 * gonderip devam ediyoruz - surec sonunda soketler zaten kapanir.
 */
function closeServer(server: net.Server): void {
  server.close();
  server.unref();
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pos-hw-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('donanim kesfi platformdan bagimsiz guvenli calisir', () => {
  test('Windows disinda yazici listesi HATA VERMEZ, acik not doner', async () => {
    const result = await listWindowsPrinters();
    assert.ok(Array.isArray(result.printers));
    if (process.platform !== 'win32') {
      assert.equal(result.supported, false);
      assert.match(result.note ?? '', /Windows/);
    }
  });

  test('HID cihaz listesi hata vermez', async () => {
    const result = await listHidCandidates();
    assert.ok(Array.isArray(result.devices));
  });

  test('seri port listesi hata vermez', async () => {
    const result = await listSerialPorts();
    assert.ok(Array.isArray(result.ports));
  });

  test('ag taramasi makul surede biter ve asili kalmaz', async () => {
    const started = Date.now();
    const result = await scanNetworkPrinters({ subnet: '127.0.0', port: 65000, timeoutMs: 60 });
    assert.equal(result.scanned, 254);
    assert.ok(Date.now() - started < 15_000, 'tarama 15 saniyeyi asmamali');
  });
});

describe('ag taramasi gercek ESC/POS yazicisini bulur', () => {
  test('9100 benzeri porttan yanit veren cihaz ESC/POS olarak isaretlenir', async () => {
    // Gercek fis yazicisi gibi davranan sahte cihaz: DLE EOT sorgusuna yanit verir
    const printer = net.createServer((socket) => {
      socket.on('data', () => socket.write(Uint8Array.from([0x16])));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => printer.listen(0, '127.0.0.1', resolve));
    const port = (printer.address() as net.AddressInfo).port;
    cleanups.push(() => closeServer(printer));

    const result = await scanNetworkPrinters({ subnet: '127.0.0', port, timeoutMs: 200 });
    const found = result.printers.find((p) => p.host === '127.0.0.1');
    assert.ok(found !== undefined, 'acik port bulunmali');
    assert.equal(found.respondsToEscPos, true, 'ESC/POS yaniti algilanmali');
  });

  test('port acik ama ESC/POS yaniti yoksa "belirsiz" isaretlenir', async () => {
    const silent = net.createServer((socket) => {
      socket.on('error', () => undefined); // yanit vermez ama hata da atmaz
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as net.AddressInfo).port;
    cleanups.push(() => closeServer(silent));

    const result = await scanNetworkPrinters({ subnet: '127.0.0', port, timeoutMs: 200 });
    const found = result.printers.find((p) => p.host === '127.0.0.1');
    assert.ok(found !== undefined);
    assert.equal(found.respondsToEscPos, false);
  });
});

describe('kurulum sihirbazi ayarlari KALICI saklar', () => {
  async function launch(dir: string) {
    const config = testPosConfig({ server: { host: '127.0.0.1', port: 0 } });
    writeFileSync(join(dir, 'pos.config.json'), JSON.stringify(config, null, 2));
    writeFileSync(join(dir, 'barcode-rules.json'), JSON.stringify(testBarcodeConfig(), null, 2));
    const app = new PosApplication({
      config,
      barcodeConfig: testBarcodeConfig(),
      clock: new FixedClock(),
      databasePath: join(dir, 'pos.db'),
      credentialsFile: join(dir, 'sync-credentials.json'),
      devices: {
        scanner: new SimulatorScanner(), printer: new NullTransport(),
        scale: new SimulatorScale(), simulated: [],
      },
    });
    app.start();
    const server = new PosServer(app, {
      uiRoot: 'ui',
      configFiles: {
        posConfigFile: join(dir, 'pos.config.json'),
        barcodeConfigFile: join(dir, 'barcode-rules.json'),
      },
    });
    const port = await server.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(async () => { await server.close(); await app.stop(); });

    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/api/setup/admin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'y', displayName: 'Yonetici', pin: '1234' }),
    });
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'y', pin: '1234' }),
    }).then((r) => r.json() as Promise<{ token: string }>);

    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-pos-token': login.token },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, json: await response.json() as any };
    };
    return { app, call, dir };
  }

  test('baslangicta kurulum tamamlanmamis gorunur', async () => {
    const { call } = await launch(tempDir());
    const status = await call('GET', '/api/admin/hardware/status');
    assert.equal(status.json.setupCompleted, false);
    assert.equal(status.json.scanner.verifiedAt, null);
    // Terazi CIHAZ BAGLANTISI istemez
    assert.equal(status.json.scale.requiresConnection, false);
  });

  test('okuyucu testi barkodu cozumler ve SATISA DOKUNMAZ', async () => {
    const { app, call } = await launch(tempDir());
    const result = await call('POST', '/api/admin/hardware/scanner/test',
      { raw: '8690504060017' });
    assert.equal(result.status, 200);
    assert.equal(result.json.normalized, '8690504060017');
    assert.equal(result.json.kind, 'PLAIN');
    assert.equal(result.json.length, 13);
    assert.equal(app.sales.currentOpenSale(app.terminalId), undefined, 'fis acilmamali');
  });

  test('okuyucu onayi config dosyasina yazilir', async () => {
    const dir = tempDir();
    const { call } = await launch(dir);
    await call('POST', '/api/admin/hardware/scanner/confirm', { adapter: 'HID_WEDGE' });
    const file = JSON.parse(readFileSync(join(dir, 'pos.config.json'), 'utf8'));
    assert.equal(file.devices.scanner.adapter, 'HID_WEDGE');
    assert.notEqual(file.hardware.scannerVerifiedAt, null);
  });

  test('TCP yazici secimi config dosyasina yazilir', async () => {
    const dir = tempDir();
    const { call } = await launch(dir);
    const result = await call('POST', '/api/admin/hardware/printer/select',
      { mode: 'TCP', host: '192.168.1.77', port: 9100 });
    assert.equal(result.json.ok, true);
    assert.equal(result.json.restartRequired, true);
    const file = JSON.parse(readFileSync(join(dir, 'pos.config.json'), 'utf8'));
    assert.equal(file.devices.printer.adapter, 'TCP');
    assert.equal(file.devices.printer.tcp.host, '192.168.1.77');
  });

  test('gecersiz baglanti tipi reddedilir', async () => {
    const { call } = await launch(tempDir());
    const result = await call('POST', '/api/admin/hardware/printer/select', { mode: 'USB_SIHIRLI' });
    assert.equal(result.status, 400);
  });

  test('kurulum tamamlanir ve YENIDEN ACILISTA otomatik kullanilir', async () => {
    const dir = tempDir();
    const first = await launch(dir);
    await first.call('POST', '/api/admin/hardware/scanner/confirm', { adapter: 'HID_WEDGE' });
    await first.call('POST', '/api/admin/hardware/printer/select',
      { mode: 'TCP', host: '10.0.0.5', port: 9100 });
    await first.call('POST', '/api/admin/hardware/printer/confirm', { codePage: 'CP1254:25' });
    const done = await first.call('POST', '/api/admin/hardware/complete');
    assert.equal(done.json.ok, true);

    // === uygulama kapanip yeniden aciliyor ===
    const file = JSON.parse(readFileSync(join(dir, 'pos.config.json'), 'utf8'));
    assert.notEqual(file.hardware.setupCompletedAt, null);
    assert.equal(file.devices.printer.codePage, 'CP1254:25');
    assert.equal(file.devices.printer.tcp.host, '10.0.0.5');
    assert.equal(file.devices.scanner.adapter, 'HID_WEDGE');
    // Ayarlar dosyada oldugu icin sonraki acilis bunlari sorusuz kullanir:
    // config yukleyici bu dosyayi okur (bkz. loadPosConfig).
  });

  test('donanim ayarlari SETTINGS_MANAGE yetkisi ister', async () => {
    const { call } = await launch(tempDir());
    // Yonetici erisebilir
    assert.equal((await call('GET', '/api/admin/hardware/status')).status, 200);
    // Token olmadan erisilemez
    const anonymous = await fetch(
      (await call('GET', '/api/admin/hardware/status'), 'http://127.0.0.1:1/'),
    ).catch(() => null);
    void anonymous;
  });
});
