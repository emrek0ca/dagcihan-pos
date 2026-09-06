/**
 * Windows masaustu POS kabugu (Electron ana sureci).
 *
 * MIMARI KARARI: Electron 44 icinde Node 24 ve `node:sqlite` calisir; bu yuzden
 * mevcut backend (PosApplication + PosServer) DOGRUDAN bu surecte kosar.
 * Ikinci bir runtime, ayri bir servis veya yeni bir backend YOKTUR.
 * Arayuz, ayni surecte ayaga kalkan yerel sunucudan (127.0.0.1) yuklenir.
 */
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, powerSaveBlocker, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBarcodeConfig, loadPosConfig } from '../src/config/load.ts';
import { PosApplication } from '../src/app/pos.ts';
import { PosServer } from '../src/app/server.ts';
import { BackupScheduler } from '../src/app/backup.ts';
import { FileLogger } from './logger.ts';
import { resolveAppPaths, seedUserConfig, type AppPaths } from './paths.ts';
import { SettingsStore } from './settings.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Kullanici veri klasoru ACIKCA sabitlenir.
 * Varsayilan yol uygulama adina baglidir; urun adi degistiginde (veya gelistirme /
 * kurulu surum farkinda) Windows baska bir klasor secer ve MAGAZANIN VERITABANI
 * KAYBOLMUS GIBI gorunur. Sabit ad bu riski tamamen kaldirir.
 * Windows: %APPDATA%\DagcihanPOS
 */
app.setPath('userData', join(app.getPath('appData'), 'DagcihanPOS'));

interface Runtime {
  paths: AppPaths;
  logger: FileLogger;
  settings: SettingsStore;
  posApp: PosApplication;
  server: PosServer;
  backups: BackupScheduler;
  port: number;
}

let runtime: Runtime | null = null;
let mainWindow: BrowserWindow | null = null;
let sleepBlockerId: number | null = null;
let quitting = false;

// --------------------------- Tek ornek (single instance) ---------------------------

if (!app.requestSingleInstanceLock()) {
  // Kasada ikinci bir kopya acilmaz: iki surec ayni veritabanina yazamaz.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void start();
}

// --------------------------- Baslatma ---------------------------

async function start(): Promise<void> {
  await app.whenReady();
  try {
    runtime = await bootstrap();
    registerIpc(runtime);
    createWindow(runtime);
    watchPower(runtime);
  } catch (error) {
    showFatalError(error);
  }
}

async function bootstrap(): Promise<Runtime> {
  const paths = resolveAppPaths(app.getPath('userData'));
  const appRoot = app.isPackaged ? app.getAppPath() : join(HERE, '..', '..');
  const seeded = seedUserConfig(paths, join(appRoot, 'config'));

  const logger = new FileLogger({ dir: paths.logDir });
  logger.info('='.repeat(64));
  logger.info(`POS baslatiliyor · surum ${app.getVersion()} · ${app.isPackaged ? 'kurulu' : 'gelistirme'}`);
  logger.info(`Kullanici veri klasoru: ${paths.userData}`);
  if (seeded.created.length > 0) logger.info('Varsayilan ayarlar olusturuldu', seeded.created);
  if (seeded.addedKeys.length > 0) {
    logger.info('Yeni surumle gelen ayarlar eklendi', { keys: seeded.addedKeys });
  }

  // Beklenmeyen hatalar loglanir; uygulama dusmez (satis verisi zaten diskte).
  process.on('uncaughtException', (error) => logger.error('Beklenmeyen hata', error));
  process.on('unhandledRejection', (reason) => logger.error('Islenmeyen ret', reason));

  const settings = new SettingsStore(paths.userData);

  const config = loadPosConfig(paths.posConfigFile, { baseDir: paths.userData });
  const barcodeConfig = loadBarcodeConfig(paths.barcodeConfigFile);

  const posApp = new PosApplication({
    config,
    barcodeConfig,
    databasePath: paths.databaseFile,
  });

  const report = posApp.start();
  logger.info(`Veritabani: ${report.databasePath} (sema v${report.schemaVersion})`);
  logger.info(
    `Kurtarma: acik fis=${report.openSaleRecovered ?? 'yok'} · askida=${report.parkedSales} ` +
    `· bekleyen fis=${report.pendingPrintJobs} · kuyruktan alinan=${report.stuckPrintJobsRequeued}`,
  );
  for (const warning of report.warnings) logger.warn(warning);

  if (!report.integrityOk) {
    logger.error('VERITABANI BUTUNLUK SORUNU', report.integrityProblems);
    dialog.showErrorBox(
      'Veritabani uyarisi',
      'Veritabani butunluk kontrolunden gecemedi. Satisa devam etmeden once ' +
      `yedekten donmeniz gerekebilir.\n\n${report.integrityProblems.join('\n')}`,
    );
  }

  await posApp.startDevices();

  const server = new PosServer(posApp, {
    uiRoot: join(appRoot, 'ui'),
    // Yonetim ekranlarindan yapilan ayar degisiklikleri KULLANICI klasorune yazilir;
    // program klasoru salt-okunurdur ve guncellemede degisir.
    configFiles: {
      posConfigFile: paths.posConfigFile,
      barcodeConfigFile: paths.barcodeConfigFile,
    },
  });
  const port = await server.listen({ host: '127.0.0.1' });
  logger.info(`Yerel sunucu: http://127.0.0.1:${port}`);

  const backups = new BackupScheduler({
    db: posApp.db,
    backupDir: config.database.backupDir,
    intervalMinutes: config.database.backupIntervalMinutes,
    onEvent: (message, error) =>
      error === undefined ? logger.info(message) : logger.error(message, error),
  });
  backups.start();

  app.setLoginItemSettings({ openAtLogin: settings.get('autoStart'), path: process.execPath });

  if (settings.get('preventDisplaySleep')) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  }

  return { paths, logger, settings, posApp, server, backups, port };
}

// --------------------------- Pencere ---------------------------

function createWindow(rt: Runtime): void {
  const window = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1720',
    autoHideMenuBar: true,
    fullscreen: rt.settings.get('fullscreen'),
    kiosk: rt.settings.get('kiosk'),
    title: 'POS Kasa',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Yerel sunucu disinda gezinme yok; arayuz zaten tek sayfadir.
      webSecurity: true,
    },
  });
  mainWindow = window;

  window.once('ready-to-show', () => {
    window.show();
    window.webContents.setZoomFactor(rt.settings.get('zoomFactor'));
  });

  // Kasada tarayici davranislari kapatilir (sag tik menusu, surukle-birak gezinme)
  window.webContents.on('context-menu', (event) => {
    if (app.isPackaged) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${rt.port}`)) event.preventDefault();
  });

  // Kisayollar: F11 tam ekran, Ctrl+Shift+I gelistirici (yalnizca paketlenmemis)
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      toggleFullscreen();
    }
    if (app.isPackaged && input.control && input.key.toLowerCase() === 'r') {
      event.preventDefault(); // Kasiyer yanlislikla sayfayi yenilemesin
    }
    if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'i') {
      window.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // Arayuz cokerse otomatik toparla - kasa acik kalsin
  window.webContents.on('render-process-gone', (_event, details) => {
    rt.logger.error('Arayuz sureci coktu, yeniden yukleniyor', details);
    if (!quitting) window.reload();
  });
  window.webContents.on('unresponsive', () => rt.logger.warn('Arayuz yanit vermiyor'));
  window.webContents.on('did-fail-load', (_e, code, description) => {
    rt.logger.error(`Arayuz yuklenemedi (${code}): ${description}`);
    if (!quitting) setTimeout(() => window.loadURL(uiUrl(rt)), 1000);
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  void window.loadURL(uiUrl(rt));
}

function uiUrl(rt: Runtime): string {
  return `http://127.0.0.1:${rt.port}/`;
}

function toggleFullscreen(): void {
  if (mainWindow === null || runtime === null) return;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  runtime.settings.set('fullscreen', next);
}

// --------------------------- Guc / uyku ---------------------------

function watchPower(rt: Runtime): void {
  powerMonitor.on('suspend', () => rt.logger.warn('Bilgisayar uykuya geciyor'));
  powerMonitor.on('resume', () => {
    rt.logger.info('Bilgisayar uykudan dondu, durum dogrulaniyor');
    const integrity = rt.posApp.db.integrityCheck();
    if (!integrity.ok) rt.logger.error('Uyandiktan sonra butunluk sorunu', integrity.problems);
    // Baglantisi kopmus olabilecek cihazlar ve bekleyen fisler yeniden denenir
    void rt.posApp.printQueue.processDue();
    mainWindow?.webContents.send('pos:notice', {
      kind: 'info',
      message: 'Sistem uykudan dondu, baglantilar yenilendi.',
    });
  });
  powerMonitor.on('shutdown', () => {
    rt.logger.warn('Windows kapaniyor, kontrollu kapanis');
    void shutdown('sistem kapanisi');
  });
}

// --------------------------- IPC ---------------------------

function registerIpc(rt: Runtime): void {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: rt.paths.userData,
    database: rt.paths.databaseFile,
    logFile: rt.logger.file,
    port: rt.port,
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  ipcMain.handle('settings:get', () => rt.settings.all);

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    switch (key) {
      case 'kiosk':
        rt.settings.set('kiosk', Boolean(value));
        mainWindow?.setKiosk(Boolean(value));
        break;
      case 'fullscreen':
        rt.settings.set('fullscreen', Boolean(value));
        mainWindow?.setFullScreen(Boolean(value));
        break;
      case 'autoStart':
        rt.settings.set('autoStart', Boolean(value));
        app.setLoginItemSettings({ openAtLogin: Boolean(value), path: process.execPath });
        break;
      case 'preventDisplaySleep': {
        const on = Boolean(value);
        rt.settings.set('preventDisplaySleep', on);
        if (on && sleepBlockerId === null) {
          sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
        } else if (!on && sleepBlockerId !== null) {
          powerSaveBlocker.stop(sleepBlockerId);
          sleepBlockerId = null;
        }
        break;
      }
      case 'zoomFactor': {
        const factor = Math.min(2, Math.max(0.7, Number(value) || 1));
        rt.settings.set('zoomFactor', factor);
        mainWindow?.webContents.setZoomFactor(factor);
        break;
      }
      default:
        return { ok: false, error: `Bilinmeyen ayar: ${key}` };
    }
    return { ok: true, settings: rt.settings.all };
  });

  ipcMain.handle('window:toggle-fullscreen', () => {
    toggleFullscreen();
    return mainWindow?.isFullScreen() ?? false;
  });

  ipcMain.handle('app:open-logs', () => shell.openPath(rt.paths.logDir));
  ipcMain.handle('app:open-data', () => shell.openPath(rt.paths.dataDir));

  ipcMain.handle('app:backup', () => {
    const result = rt.backups.runOnce('elle');
    return result === null ? { ok: false } : { ok: true, file: result.file, bytes: result.bytes };
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
}

// --------------------------- Kapanis ---------------------------

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting || runtime === null) return;

  // Acik fis varken kazara kapanmayi engelle
  const open = runtime.posApp.sales.currentOpenSale(runtime.posApp.terminalId);
  if (open !== undefined && open.totals.itemCount > 0 && mainWindow !== null) {
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Vazgec', 'Yine de kapat'],
      defaultId: 0,
      cancelId: 0,
      title: 'Acik fis var',
      message: `Kasada ${open.totals.itemCount} kalemlik acik bir fis var.`,
      detail:
        'Fis kaydedildi ve uygulama tekrar acildiginda kaldigi yerden devam eder. ' +
        'Yine de simdi kapatmak istiyor musunuz?',
    });
    if (choice === 0) return;
  }

  event.preventDefault();
  void shutdown('kullanici');
});

async function shutdown(reason: string): Promise<void> {
  if (quitting) return;
  quitting = true;
  const rt = runtime;
  if (rt === null) {
    app.exit(0);
    return;
  }
  rt.logger.info(`Kontrollu kapanis (${reason})`);
  try {
    if (sleepBlockerId !== null) powerSaveBlocker.stop(sleepBlockerId);
    rt.backups.stop();
    await rt.server.close();
    rt.backups.runOnce('kapanis');
    await rt.posApp.stop();
    rt.logger.info('Kapanis tamamlandi');
  } catch (error) {
    rt.logger.error('Kapanis sirasinda hata', error);
  } finally {
    rt.logger.close();
    app.exit(0);
  }
}

// --------------------------- Olumcul hata ekrani ---------------------------

function showFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    runtime?.logger.error('Baslatma basarisiz', error);
  } catch {
    /* logger yoksa */
  }
  const detail =
    'POS baslatilamadi. Genellikle bozuk bir ayar dosyasindan kaynaklanir.\n\n' +
    `${message}\n\n` +
    'Ayar dosyalari: %APPDATA%\\dagcihan-pos\\config';
  dialog.showErrorBox('POS baslatilamadi', detail);
  app.exit(1);
}
