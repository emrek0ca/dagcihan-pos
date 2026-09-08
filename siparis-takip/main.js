/**
 * Dagcihan Siparis Takip - masaustu uygulamasi.
 *
 * Merkezi POS platformundan web siparislerini ceker, yeni siparis geldiginde
 * uyarir ve durum degisikligini merkeze yazar. Kasa uygulamasindan BAGIMSIZDIR;
 * ayni anda calisabilirler.
 *
 * Ag istekleri ANA SURECTE yapilir: oturum token'i pencere tarafina hic
 * gecmez, dolayisiyla sayfa icindeki bir hata token'i sizdiramaz.
 */
const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, shell, safeStorage } =
  require('electron');
const { join } = require('node:path');
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs');

const SERVER_URL = 'https://pos-api.witlydesign.com';
const POLL_MS = 15_000;

/** Kasiyerin yapabilecegi gecisler. Sunucu da AYNI kurali uygular. */
const NEXT_STATUS = {
  PAID: [['PREPARING', 'Hazirlamaya basla']],
  PREPARING: [['READY', 'Hazir']],
  READY: [['FULFILLED', 'Teslim edildi']],
};

let mainWindow = null;
let tray = null;
let pollTimer = null;

const state = {
  token: null,
  expiresAt: 0,
  user: null,
  orders: [],
  knownIds: new Set(),
  connected: false,
  lastError: null,
};

// ------------------------------ ayar dosyasi ------------------------------

const dataDir = () => {
  const dir = join(app.getPath('appData'), 'DagcihanSiparisTakip');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

const credentialsPath = () => join(dataDir(), 'credentials.bin');

/**
 * Parola isletim sisteminin anahtar zinciriyle sifrelenir. Sifreleme
 * kullanilamiyorsa parola KAYDEDILMEZ; duz metin olarak diske yazmayiz.
 */
function saveCredentials(email, password) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const blob = safeStorage.encryptString(JSON.stringify({ email, password }));
  writeFileSync(credentialsPath(), blob, { mode: 0o600 });
  return true;
}

function loadCredentials() {
  try {
    if (!existsSync(credentialsPath()) || !safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(readFileSync(credentialsPath())));
  } catch {
    return null;
  }
}

function clearCredentials() {
  try {
    if (existsSync(credentialsPath())) writeFileSync(credentialsPath(), '');
  } catch {
    /* yok sayilir */
  }
}

// ------------------------------ sunucu ------------------------------

async function callServer(method, path, body) {
  const options = {
    method,
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  };
  if (state.token) options.headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${SERVER_URL}${path}`, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Sunucu hatasi (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function login(email, password) {
  const result = await callServer('POST', '/api/v1/auth/login', { email, password });
  state.token = result.token;
  state.expiresAt = Date.parse(result.expiresAt) || Date.now() + 3_600_000;
  state.user = result.user;
  return result.user;
}

/** Oturum suresi dolduysa saklanan bilgilerle sessizce yeniden giris yapilir. */
async function ensureSession() {
  if (state.token && state.expiresAt > Date.now() + 60_000) return true;
  const saved = loadCredentials();
  if (!saved?.email || !saved?.password) return false;
  await login(saved.email, saved.password);
  return true;
}

async function fetchOrders() {
  const orders = await callServer('GET', '/api/v1/orders?limit=100');
  return Array.isArray(orders) ? orders : [];
}

// ------------------------------ dongu ------------------------------

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function updateTray() {
  if (!tray) return;
  const open = state.orders.filter((o) => o.status === 'PAID').length;
  tray.setToolTip(open > 0 ? `${open} yeni siparis` : 'Dagcihan Siparis Takip');
}

function notifyNewOrders(fresh) {
  if (fresh.length === 0) return;

  // Bildirim + pencereyi one al: kasiyer siparisi kacirmasin.
  if (Notification.isSupported()) {
    const first = fresh[0];
    new Notification({
      title: fresh.length === 1 ? 'Yeni web siparisi' : `${fresh.length} yeni web siparisi`,
      body:
        fresh.length === 1
          ? `${first.customer_name || 'Musteri'} - ${(Number(first.total) / 100).toFixed(2)} TL`
          : 'Siparis listesini acin.',
      urgency: 'critical',
    }).show();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(true);
    if (!mainWindow.isVisible()) mainWindow.show();
  }
  send('orders:new', { count: fresh.length });
}

async function poll() {
  try {
    const ok = await ensureSession();
    if (!ok) {
      state.connected = false;
      send('state', publicState());
      return;
    }

    const orders = await fetchOrders();
    // Ilk yuklemede TUM siparisler "yeni" sayilmaz; yalnizca sonraki
    // turlarda gelen odenmis siparisler uyari uretir.
    const firstRun = state.knownIds.size === 0 && state.orders.length === 0;
    const fresh = orders.filter((o) => o.status === 'PAID' && !state.knownIds.has(o.id));

    state.orders = orders;
    orders.forEach((o) => state.knownIds.add(o.id));
    state.connected = true;
    state.lastError = null;

    send('state', publicState());
    updateTray();
    if (!firstRun) notifyNewOrders(fresh);
  } catch (error) {
    if (error.status === 401) {
      state.token = null;
      state.expiresAt = 0;
    }
    state.connected = false;
    state.lastError = error.message;
    send('state', publicState());
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void poll(), POLL_MS);
  void poll();
}

function publicState() {
  return {
    connected: state.connected,
    lastError: state.lastError,
    user: state.user ? { email: state.user.email, name: state.user.displayName } : null,
    serverUrl: SERVER_URL,
    orders: state.orders.map((order) => ({
      id: order.id,
      orderNo: order.order_no,
      status: order.status,
      total: Number(order.total) || 0,
      subtotal: Number(order.subtotal) || 0,
      shippingTotal: Number(order.shipping_total) || 0,
      customerName: order.customer_name || '',
      customerPhone: order.customer_phone || '',
      customerEmail: order.customer_email || '',
      address: order.customer_address || {},
      notes: order.notes || '',
      placedAt: order.placed_at,
      lines: (order.lines || []).map((line) => ({
        name: line.name_snapshot,
        unit: line.unit,
        quantity: Number(line.quantity) || 0,
        netAmount: Number(line.net_amount) || 0,
      })),
      next: NEXT_STATUS[order.status] || [],
    })),
  };
}

// ------------------------------ IPC ------------------------------

ipcMain.handle('login', async (_event, { email, password, remember }) => {
  const user = await login(email, password);
  if (remember) saveCredentials(email, password);
  startPolling();
  return { email: user.email, name: user.displayName };
});

ipcMain.handle('logout', async () => {
  try {
    await callServer('POST', '/api/v1/auth/logout');
  } catch {
    /* oturum zaten dusmus olabilir */
  }
  clearCredentials();
  state.token = null;
  state.user = null;
  state.orders = [];
  state.knownIds = new Set();
  if (pollTimer) clearInterval(pollTimer);
  return true;
});

ipcMain.handle('state', () => publicState());
ipcMain.handle('refresh', async () => {
  await poll();
  return publicState();
});

ipcMain.handle('changeStatus', async (_event, { orderId, status }) => {
  await ensureSession();
  await callServer('POST', `/api/v1/orders/${encodeURIComponent(orderId)}/status`, { status });
  await poll();
  return publicState();
});

ipcMain.handle('print', (_event, { html }) => {
  const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  printWindow.webContents.once('did-finish-load', () => {
    printWindow.webContents.print({ silent: false, printBackground: false }, () => {
      printWindow.destroy();
    });
  });
  return true;
});

ipcMain.handle('hasSavedLogin', () => loadCredentials() !== null);

// ------------------------------ pencere ------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: 'Dagcihan Siparis Takip',
    backgroundColor: '#0f1720',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  void mainWindow.loadFile(join(__dirname, 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Disaridan gelen adresler uygulamanin icinde ACILMAZ.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Kapatma tepsiye alir: siparis uyarilari arka planda calismaya devam eder.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Dagcihan Siparis Takip');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Siparisleri goster', click: () => mainWindow?.show() },
      { label: 'Yenile', click: () => void poll() },
      { type: 'separator' },
      {
        label: 'Cikis',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => mainWindow?.show());
}

// Tek ornek: ikinci kez acilirsa mevcut pencere one gelir.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    createWindow();
    createTray();
    if (loadCredentials()) startPolling();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
    else createWindow();
  });
}
