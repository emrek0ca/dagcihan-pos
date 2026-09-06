import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths, seedUserConfig, ensureDirectories } from '../../desktop/paths.ts';
import { FileLogger } from '../../desktop/logger.ts';
import { SettingsStore } from '../../desktop/settings.ts';
import { backupDatabase, pruneBackups, BackupScheduler } from '../../src/app/backup.ts';
import { Db, migrate } from '../../src/data/db.ts';
import { FixedClock } from '../../src/core/clock.ts';

/**
 * Windows masaustu katmani testleri.
 * Cekirdek satis mantigi ayrica test ediliyor (tests/integration/sale-flow, operations);
 * burada YALNIZCA masaustu kabugunun sorumluluklari dogrulanir.
 */

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pos-desktop-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('kullanici veri klasoru ve ilk kurulum', () => {
  test('yollar kullanici klasoru altinda toplanir', () => {
    const paths = resolveAppPaths('/tmp/ornek');
    assert.equal(paths.configDir, join('/tmp/ornek', 'config'));
    assert.equal(paths.databaseFile, join('/tmp/ornek', 'data', 'pos.db'));
    assert.equal(paths.backupDir, join('/tmp/ornek', 'data', 'backups'));
    assert.equal(paths.logDir, join('/tmp/ornek', 'logs'));
  });

  test('ilk calistirmada varsayilan ayarlar kopyalanir', () => {
    const userData = tempDir();
    const defaults = tempDir();
    writeFileSync(join(defaults, 'pos.config.json'), '{"store":{"name":"VARSAYILAN"}}');
    writeFileSync(join(defaults, 'barcode-rules.json'), '{"weightedFormatConfirmed":false}');

    const paths = resolveAppPaths(userData);
    const result = seedUserConfig(paths, defaults);

    assert.equal(result.created.length, 2);
    assert.ok(existsSync(paths.posConfigFile));
    assert.ok(existsSync(paths.barcodeConfigFile));
    assert.ok(existsSync(paths.dataDir));
    assert.ok(existsSync(paths.logDir));
  });

  test('GUNCELLEME: mevcut magaza ayarlari asla ustune yazilmaz', () => {
    const userData = tempDir();
    const defaults = tempDir();
    writeFileSync(join(defaults, 'pos.config.json'), '{"store":{"name":"VARSAYILAN"}}');
    writeFileSync(join(defaults, 'barcode-rules.json'), '{"weightedFormatConfirmed":false}');
    const paths = resolveAppPaths(userData);
    seedUserConfig(paths, defaults);

    // Magaza kendi ayarlarini yapti: isim, yazici, dogrulanmis terazi formati
    writeFileSync(paths.posConfigFile, '{"store":{"name":"DAGCIHAN"},"printer":"TCP"}');
    writeFileSync(paths.barcodeConfigFile, '{"weightedFormatConfirmed":true,"rules":["kalibre"]}');

    // Yeni surum kuruldu -> ayni seed yeniden calisir
    const second = seedUserConfig(paths, defaults);

    assert.equal(second.created.length, 0, 'guncelleme yeni dosya olusturmamali');
    assert.equal(second.kept.length, 2);
    assert.match(readFileSync(paths.posConfigFile, 'utf8'), /DAGCIHAN/);
    assert.match(readFileSync(paths.barcodeConfigFile, 'utf8'), /kalibre/);
    assert.match(readFileSync(paths.barcodeConfigFile, 'utf8'), /"weightedFormatConfirmed":true/);
  });

  test('GUNCELLEME: satis veritabani yerinde kalir', () => {
    const userData = tempDir();
    const defaults = tempDir();
    writeFileSync(join(defaults, 'pos.config.json'), '{}');
    writeFileSync(join(defaults, 'barcode-rules.json'), '{}');
    const paths = resolveAppPaths(userData);
    seedUserConfig(paths, defaults);

    const db = new Db({ path: paths.databaseFile });
    migrate(db);
    db.run('INSERT INTO sequences(name, value) VALUES (?, ?)', 'receipt:A:1', 42);
    db.close();

    seedUserConfig(paths, defaults); // guncelleme

    const reopened = new Db({ path: paths.databaseFile });
    const row = reopened.get<{ value: number }>('SELECT value FROM sequences WHERE name = ?', 'receipt:A:1');
    assert.equal(row?.value, 42, 'guncelleme veritabanina dokunmamali');
    reopened.close();
  });
});

describe('uygulama gunlugu', () => {
  test('log dosyaya yazilir ve seviyeler ayrilir', () => {
    const dir = tempDir();
    const logger = new FileLogger({ dir });
    logger.info('acilis');
    logger.warn('uyari');
    logger.error('hata', new Error('detay'));
    logger.close();

    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    assert.equal(files.length, 1);
    const content = readFileSync(join(dir, files[0]!), 'utf8');
    assert.match(content, /INFO {2}acilis/);
    assert.match(content, /WARN {2}uyari/);
    assert.match(content, /ERROR hata \| detay/);
  });

  test('eski loglar temizlenir', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'pos-2020-01-01.log'), 'eski');
    const logger = new FileLogger({ dir, keepDays: 5 });
    assert.equal(existsSync(join(dir, 'pos-2020-01-01.log')), false);
    logger.close();
  });

  test('log yazilamasa bile hata firlatmaz', () => {
    const logger = new FileLogger({ dir: tempDir() });
    logger.close();
    assert.doesNotThrow(() => logger.info('kapali akisa yazim'));
  });
});

describe('masaustu tercihleri', () => {
  test('varsayilanlar makul ve kalicidir', () => {
    const dir = tempDir();
    const settings = new SettingsStore(dir);
    assert.equal(settings.get('fullscreen'), true);
    assert.equal(settings.get('autoStart'), true);
    settings.set('kiosk', true);

    const reloaded = new SettingsStore(dir);
    assert.equal(reloaded.get('kiosk'), true, 'ayar diske yazilmali');
  });

  test('bozuk tercih dosyasi uygulamayi durdurmaz', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'desktop-settings.json'), '{bozuk json');
    const settings = new SettingsStore(dir);
    assert.equal(settings.get('fullscreen'), true, 'varsayilana donmeli');
  });
});

describe('yedekleme', () => {
  function makeDb(): { db: Db; dir: string } {
    const dir = tempDir();
    const db = new Db({ path: join(dir, 'pos.db') });
    migrate(db);
    return { db, dir };
  }

  test('yedek alinir ve geri okunabilir', () => {
    const { db, dir } = makeDb();
    db.run('INSERT INTO sequences(name, value) VALUES (?, ?)', 'test', 7);
    const backupDir = join(dir, 'backups');
    const result = backupDatabase(db, { backupDir });
    db.close();

    assert.ok(existsSync(result.file));
    assert.ok(result.bytes > 0);
    const restored = new Db({ path: result.file });
    assert.equal(restored.get<{ value: number }>('SELECT value FROM sequences WHERE name = ?', 'test')?.value, 7);
    restored.close();
  });

  test('eski yedekler donusumlu silinir, arsivler korunur', () => {
    const dir = tempDir();
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(backupDir, `yedek-${String(i).padStart(3, '0')}.db`), 'x');
    writeFileSync(join(backupDir, 'arsiv-onemli.db'), 'x');

    pruneBackups(backupDir, 10);
    const left = readdirSync(backupDir);
    assert.equal(left.filter((f) => f.startsWith('yedek-')).length, 10);
    assert.ok(left.includes('arsiv-onemli.db'), 'arsiv yedegi silinmemeli');
  });

  test('zamanlayici hata durumunda uygulamayi dusurmez', () => {
    const { db, dir } = makeDb();
    const events: string[] = [];
    const scheduler = new BackupScheduler({
      db,
      backupDir: join(dir, 'yok', 'olmayan', '\0gecersiz'),
      intervalMinutes: 1,
      onEvent: (message) => events.push(message),
    });
    assert.doesNotThrow(() => scheduler.runOnce('test'));
    assert.match(events.join(' '), /basarisiz/);
    scheduler.stop();
    db.close();
  });

  test('kapanis yedegi WAL icerigini de icerir', () => {
    const { db, dir } = makeDb();
    db.exec('PRAGMA journal_mode = WAL');
    db.run('INSERT INTO sequences(name, value) VALUES (?, ?)', 'wal-testi', 99);
    const result = backupDatabase(db, { backupDir: join(dir, 'backups'), prefix: 'kapanis' });
    db.close();
    const restored = new Db({ path: result.file });
    assert.equal(restored.get<{ value: number }>('SELECT value FROM sequences WHERE name = ?', 'wal-testi')?.value, 99);
    restored.close();
  });
});

describe('saat ve is gunu', () => {
  test('is gunu yerel takvime gore hesaplanir', () => {
    const clock = new FixedClock(Date.parse('2026-03-10T23:30:00'));
    assert.equal(clock.businessDate(), '2026-03-10');
    clock.advance(60 * 60 * 1000);
    assert.equal(clock.businessDate(), '2026-03-11');
  });
});


describe('guncelleme: yeni ayar anahtarlari', () => {
  test('yeni surumun ayarlari eklenir, mevcut degerler DEGISMEZ', () => {
    const userData = tempDir();
    const defaults = tempDir();
    // v1 varsayilanlari
    writeFileSync(join(defaults, 'pos.config.json'),
      JSON.stringify({ store: { name: 'VARSAYILAN' }, sales: { receiptSeries: 'A' } }));
    writeFileSync(join(defaults, 'barcode-rules.json'), '{"weightedFormatConfirmed":false}');
    const paths = resolveAppPaths(userData);
    seedUserConfig(paths, defaults);

    // Magaza kendi ayarlarini yapti
    writeFileSync(paths.posConfigFile,
      JSON.stringify({ store: { name: 'MAGAZAM' }, sales: { receiptSeries: 'B' } }));

    // v2 varsayilanlari: YENI bir bolum ve yeni bir alt anahtar geldi
    writeFileSync(join(defaults, 'pos.config.json'), JSON.stringify({
      store: { name: 'VARSAYILAN', phone: '' },
      sales: { receiptSeries: 'A' },
      sync: { enabled: true, serverUrl: 'https://ornek' },
    }));
    const result = seedUserConfig(paths, defaults);

    const merged = JSON.parse(readFileSync(paths.posConfigFile, 'utf8'));
    assert.equal(merged.store.name, 'MAGAZAM', 'magaza adi KORUNMALI');
    assert.equal(merged.sales.receiptSeries, 'B', 'fis serisi KORUNMALI');
    assert.equal(merged.sync.serverUrl, 'https://ornek', 'yeni bolum eklenmeli');
    assert.equal(merged.store.phone, '', 'yeni alt anahtar eklenmeli');
    assert.ok(result.addedKeys.some((k) => k.includes('sync')));
  });

  test('bozuk JSON dosyasina dokunulmaz', () => {
    const userData = tempDir();
    const defaults = tempDir();
    writeFileSync(join(defaults, 'pos.config.json'), '{"a":1}');
    writeFileSync(join(defaults, 'barcode-rules.json'), '{}');
    const paths = resolveAppPaths(userData);
    seedUserConfig(paths, defaults);
    writeFileSync(paths.posConfigFile, '{bozuk');
    assert.doesNotThrow(() => seedUserConfig(paths, defaults));
    assert.equal(readFileSync(paths.posConfigFile, 'utf8'), '{bozuk');
  });
});
