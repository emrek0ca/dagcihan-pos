/* POS kasa arayuzu.
 *
 * Kurallar:
 *  - Is mantigi burada YOKTUR. Tum hesap ve dogrulama sunucudadir.
 *  - Barkod okuma ODAK GEREKTIRMEZ: tuslar belge duzeyinde yakalanir.
 *  - Her islem sonrasi durum sunucudan gelir (SSE), ekranda tahmin yurutulmez.
 */
'use strict';

const state = {
  token: null,
  user: null,
  sale: null,
  cashSession: null,
  terminal: null,
  devices: null,
  selectedLine: null,
  lastCompleted: null,
  busy: false,
};

// ------------------------------ Yardimcilar ------------------------------

const $ = (id) => document.getElementById(id);

function formatMoney(kurus) {
  const value = Number(kurus || 0);
  const neg = value < 0;
  const abs = Math.abs(value);
  const lira = Math.trunc(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${String(lira).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${rest}`;
}

function formatQty(milli, unit) {
  const abs = Math.abs(milli);
  if (unit === 'EACH' && abs % 1000 === 0) return String(abs / 1000);
  return `${Math.trunc(abs / 1000)},${String(abs % 1000).padStart(3, '0')}`;
}

function parseAmountInput(text) {
  const clean = String(text).trim().replace(/\./g, '').replace(',', '.');
  if (clean === '' || Number.isNaN(Number(clean))) return null;
  return Math.round(Number(clean) * 100);
}

function parseQtyInput(text) {
  const clean = String(text).trim().replace(',', '.');
  if (clean === '' || Number.isNaN(Number(clean))) return null;
  return Math.round(Number(clean) * 1000);
}

/* Sesli geri bildirim - gurultulu magazada gorsel yetmez */
let audioContext = null;
function beep(kind) {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    const now = audioContext.currentTime;
    if (kind === 'ok') {
      osc.frequency.setValueAtTime(1180, now);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.start(now); osc.stop(now + 0.1);
    } else {
      osc.type = 'square';
      osc.frequency.setValueAtTime(220, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
      osc.start(now); osc.stop(now + 0.34);
    }
  } catch { /* ses yoksa sessiz devam */ }
}

let toastTimer = null;
function toast(message, kind = 'ok', ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------ API ------------------------------

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'x-pos-token': state.token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(json?.error?.message || 'Islem basarisiz');
    error.code = json?.error?.code || 'INTERNAL';
    error.userMessage = json?.error?.userMessage || 'Islem tamamlanamadi.';
    throw error;
  }
  return json;
}

async function guarded(fn, { silent = false } = {}) {
  if (state.busy) return null;
  state.busy = true;
  try {
    return await fn();
  } catch (error) {
    if (!silent) {
      beep('err');
      toast(error.userMessage || error.message, 'err', 4200);
    }
    return null;
  } finally {
    state.busy = false;
  }
}

// ------------------------------ Durum / render ------------------------------

function applyState(next) {
  state.user = next.user;
  state.sale = next.sale;
  state.cashSession = next.cashSession;
  state.terminal = next.terminal;
  state.devices = next.devices;
  state.weightedFormatConfirmed = next.weightedFormatConfirmed;
  state.sync = next.sync;
  state.hardwareSetupCompleted = next.hardwareSetupCompleted;
  state.parkedCount = next.parkedCount;
  state.onlineOrders = next.onlineOrders;
  if (next.store) $('storeName').textContent = next.store.name;
  render();
}

function render() {
  $('terminalName').textContent = state.terminal ? state.terminal.name : '-';
  $('userChip').textContent = state.user ? state.user.name : 'Giris yap';

  const scanner = $('statusScanner');
  const scannerState = state.devices?.scanner?.state;
  scanner.className = `status ${scannerState === 'CONNECTED' ? 'ok' : scannerState === 'ERROR' ? 'bad' : 'warn'}`;

  const admin = $('adminChip');
  admin.hidden = !state.user || state.user.role === 'CASHIER';

  // Siparis butonu yalnizca merkez baglantisi varken gorunur: baglanti yoksa
  // gosterilecek siparis de yoktur, kasiyeri bos butonla mesgul etmeyiz.
  const ordersChip = $('ordersChip');
  if (ordersChip) {
    const syncEnabled = Boolean(state.sync && state.sync.enabled);
    ordersChip.hidden = !syncEnabled || !state.user;
    if (syncEnabled && state.user) {
      updateOrdersChip(state.onlineOrders ? state.onlineOrders.unseen : 0);
    }
  }

  updateBanner();

  // Merkezi sunucu gostergesi: SATISI ETKILEMEZ, yalnizca bilgi amaclidir.
  const sync = $('statusSync');
  const syncState = state.sync;
  if (!syncState || !syncState.enabled) {
    sync.hidden = true;
  } else {
    sync.hidden = false;
    const label = $('syncLabel');
    if (syncState.state === 'ERROR') {
      sync.className = 'status bad';
      label.textContent = 'Merkez: hata';
    } else if (syncState.state === 'OFFLINE') {
      sync.className = 'status warn';
      label.textContent = syncState.pending > 0
        ? `Merkez: ${syncState.pending} bekliyor` : 'Merkez: cevrimdisi';
    } else if (syncState.pending > 0) {
      sync.className = 'status warn';
      label.textContent = `Merkez: ${syncState.pending} bekliyor`;
    } else {
      sync.className = 'status ok';
      label.textContent = 'Merkez: guncel';
    }
  }

  const printer = $('statusPrinter');
  const pending = state.devices?.printerPending ?? 0;
  const failed = state.devices?.printerFailed ?? 0;
  printer.className = `status ${failed > 0 ? 'bad' : pending > 0 ? 'warn' : 'ok'}`;
  $('printerLabel').textContent =
    failed > 0 ? `Yazici: ${failed} hata` : pending > 0 ? `Yazici: ${pending} bekliyor` : 'Yazici';

  renderCart();
}

/* Kalici uyari seridi: gecici toast yerine kasiyerin surekli gordugu uyari.
   Magazada tartili barkod kapaliysa bunu bilmesi sart. */
let connectionLost = false;
function updateBanner() {
  const banner = $('banner');
  const messages = [];
  if (connectionLost) {
    messages.push('BAGLANTI KOPTU — sunucuya ulasilamiyor, satis kaydedilemeyebilir.');
  }
  if (state.hardwareSetupCompleted === false && state.user && state.user.role !== 'CASHIER') {
    messages.push('Donanim kurulumu tamamlanmadi — Yonetim > Donanim Kurulumu.');
  }
  if (state.weightedFormatConfirmed === false) {
    messages.push('Terazi barkod formati tanimli degil — tartili urunler okutulamaz.');
  }
  if ((state.devices?.printerFailed ?? 0) > 0) {
    messages.push(`${state.devices.printerFailed} fis basilamadi — yaziciyi kontrol edin.`);
  }
  if (state.sync?.state === 'ERROR') {
    messages.push('Merkezi sunucu baglantisinda sorun var — satis etkilenmez, kayitlar bekliyor.');
  }
  if (messages.length === 0) {
    banner.hidden = true;
    return;
  }
  banner.textContent = messages.join('   ·   ');
  banner.hidden = false;
}

function renderCart() {
  const body = $('cartBody');
  const sale = state.sale;
  const items = sale ? sale.items : [];

  if (items.length === 0) {
    body.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = state.cashSession
      ? '<div class="empty-icon">⌁</div><p>Barkodu okutun</p><span>veya <b>Urun Ara</b> ile ekleyin</span>'
      : '<div class="empty-icon">🔒</div><p>Kasa acik degil</p><span><b>Kasa</b> tusundan acilis yapin</span>';
    body.appendChild(empty);
  } else {
    body.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = `row${item.voided ? ' voided' : ''}${state.selectedLine === item.lineNo ? ' selected' : ''}`;
      row.dataset.line = item.lineNo;

      const discount = item.discountAmount + item.saleDiscountShare;
      const single = item.unit === 'EACH' && item.quantity === 1000;
      row.innerHTML = `
        <div>
          <span class="name">${escapeHtml(item.name)}</span>
          <span class="meta">${item.rawBarcode ? escapeHtml(item.rawBarcode) : 'elle eklendi'}${
            item.priceSource === 'BARCODE_PRICE' ? ' · etiket tutari' : ''}</span>
        </div>
        <div class="qty">${single ? '1' : formatQty(item.quantity, item.unit)}${item.unit === 'KG' ? ' kg' : ''}</div>
        <div class="price">${formatMoney(item.unitPrice)}</div>
        <div class="amount">${formatMoney(item.net)}${
          discount > 0 ? `<span class="off">-${formatMoney(discount)}</span>` : ''}</div>`;
      body.appendChild(row);
    }
    const last = body.lastElementChild;
    if (last) {
      last.classList.add('flash');
      body.scrollTop = body.scrollHeight;
    }
  }

  const totals = sale ? sale.totals : null;
  $('lineCount').textContent = totals ? totals.itemCount : 0;
  $('subtotal').textContent = formatMoney(totals ? totals.grossTotal : 0);
  $('taxTotal').textContent = formatMoney(totals ? totals.taxTotal : 0);
  $('total').textContent = formatMoney(totals ? totals.total : 0);
  const hasDiscount = totals && totals.discountTotal > 0;
  $('discountRow').hidden = !hasDiscount;
  if (hasDiscount) $('discountTotal').textContent = `-${formatMoney(totals.discountTotal)}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  const next = await api('GET', '/api/state');
  applyState(next);
}

// ------------------------------ SSE ------------------------------

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => applyState(JSON.parse(event.data)));
  source.addEventListener('scan', (event) => {
    const outcome = JSON.parse(event.data);
    if (outcome.duplicateIgnored) return;
    if (outcome.ok) {
      beep('ok');
      if (outcome.warnings?.length) toast(outcome.warnings.join(' '), 'warn', 4000);
    } else if (outcome.error) {
      beep('err');
      toast(outcome.error.userMessage, 'err', 4200);
    }
  });
  source.onopen = () => {
    if (connectionLost) {
      connectionLost = false;
      updateBanner();
      void refresh();
    }
  };
  source.onerror = () => {
    // EventSource kendi yeniden baglanir; kasiyer durumu gormeli
    connectionLost = true;
    updateBanner();
  };
}

// ------------------------------ Barkod yakalama ------------------------------

/* Okuyucu klavye gibi davranir. Odak gerekmez: tuslar belge duzeyinde toplanir.
   Bir metin alanina yaziliyorsa karisilmaz. */
const wedge = { buffer: '', timer: null, lastAt: 0 };

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function flushWedge() {
  const raw = wedge.buffer.trim();
  wedge.buffer = '';
  clearTimeout(wedge.timer);
  if (raw.length < 3) return;
  void guarded(() => api('POST', '/api/scan', { raw }), { silent: true })
    .catch(() => {});
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
    return;
  }
  const shortcut = SHORTCUTS[event.key];
  if (shortcut && !isTyping(event.target)) {
    event.preventDefault();
    handleAction(shortcut);
    return;
  }
  if (isTyping(event.target)) return;
  if (!state.user) return;

  if (event.key === 'Enter') {
    if (wedge.buffer.length > 0) {
      event.preventDefault();
      flushWedge();
    }
    return;
  }
  if (event.key.length !== 1) return;

  const now = Date.now();
  if (now - wedge.lastAt > 500) wedge.buffer = '';
  wedge.lastAt = now;
  wedge.buffer += event.key;
  clearTimeout(wedge.timer);
  wedge.timer = setTimeout(flushWedge, 140);
}, true);

const SHORTCUTS = {
  F1: 'pay', F2: 'search', F3: 'quantity', F4: 'discount',
  F5: 'orders',
  F6: 'park', F7: 'parked', F8: 'reprint', F9: 'voidSale', F10: 'cash',
  Delete: 'voidLine',
};

// ------------------------------ Modal ------------------------------

function openModal(title, build, { wide = false } = {}) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.innerHTML = '';
  $('modalPanel').className = wide ? 'panel wide' : 'panel';
  build(body);
  $('modalOverlay').hidden = false;
  const first = body.querySelector('input, button:not(.close)');
  if (first && first.tagName === 'INPUT') setTimeout(() => first.focus(), 40);
}

function closeModal() {
  $('modalOverlay').hidden = true;
  $('modalBody').innerHTML = '';
}

$('modalClose').addEventListener('click', closeModal);
$('modalOverlay').addEventListener('click', (event) => {
  if (event.target === $('modalOverlay')) closeModal();
});

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function field(labelText, inputProps) {
  const input = el('input', inputProps);
  const label = el('label', {}, [labelText, input]);
  return { label, input };
}

function numpad(input, { decimals = true } = {}) {
  const pad = el('div', { className: 'numpad' });
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', decimals ? ',' : '00', '0', '⌫'];
  for (const key of keys) {
    const button = el('button', { type: 'button', textContent: key });
    button.addEventListener('click', () => {
      if (key === '⌫') input.value = input.value.slice(0, -1);
      else input.value += key;
      input.dispatchEvent(new Event('input'));
    });
    pad.appendChild(button);
  }
  return pad;
}

// ------------------------------ Islemler ------------------------------

function requireSale() {
  if (!state.sale || state.sale.totals.itemCount === 0) {
    toast('Fis bos.', 'warn');
    return false;
  }
  return true;
}

function selectedItem() {
  if (!state.sale) return null;
  const active = state.sale.items.filter((i) => !i.voided);
  if (active.length === 0) return null;
  if (state.selectedLine !== null) {
    const found = active.find((i) => i.lineNo === state.selectedLine);
    if (found) return found;
  }
  return active[active.length - 1];
}

$('cartBody').addEventListener('click', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  state.selectedLine = Number(row.dataset.line);
  renderCart();
});

document.querySelector('.pad').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (button) handleAction(button.dataset.action);
});

$('userChip').addEventListener('click', () => {
  if (!state.user) { showLogin(); return; }
  openModal('Oturum', (body) => {
    body.appendChild(el('p', { className: 'hint', textContent: `${state.user.name} (${state.user.role})` }));
    const logout = el('button', { className: 'btn danger', textContent: 'Cikis yap', type: 'button' });
    logout.addEventListener('click', async () => {
      await guarded(() => api('POST', '/api/logout'));
      state.token = null;
      state.user = null;
      closeModal();
      showLogin();
    });
    body.appendChild(logout);
  });
});

$('statusPrinter').addEventListener('click', () => showPrinterPanel());

$('statusSync').addEventListener('click', () => {
  const sync = state.sync;
  if (!sync) return;
  const durum = sync.state === 'ONLINE' ? 'Baglanti var'
    : sync.state === 'OFFLINE' ? 'Sunucuya ulasilamiyor'
    : sync.state === 'ERROR' ? 'Hata' : sync.state;
  toast(
    `Merkez: ${durum}${sync.storeName ? ' · ' + sync.storeName : ''}` +
    (sync.pending > 0 ? ` · ${sync.pending} kayit gonderilmeyi bekliyor` : ' · tum kayitlar gonderildi'),
    sync.state === 'ERROR' ? 'err' : sync.pending > 0 ? 'warn' : 'ok',
    5000,
  );
});

$('adminChip').addEventListener('click', () => {
  if (state.sale && state.sale.totals.itemCount > 0) {
    toast('Once acik fisi tamamlayin veya askiya alin.', 'warn');
    return;
  }
  location.href = '/admin.html';
});

function handleAction(action) {
  switch (action) {
    case 'pay': showPayment(); break;
    case 'search': showSearch(); break;
    case 'quantity': showQuantity(); break;
    case 'discount': showDiscount(); break;
    case 'voidLine': voidLine(); break;
    case 'park': parkSale(); break;
    case 'parked': showParked(); break;
    case 'reprint': showReprint(); break;
    case 'voidSale': voidSale(); break;
    case 'cash': showCash(); break;
    case 'orders': openOrders(); break;
  }
}

// ------------------------------ Odeme ------------------------------

function showPayment() {
  if (!requireSale()) return;
  const total = state.sale.totals.total;
  const saleId = state.sale.id;

  openModal('Odeme', (body) => {
    const summary = el('div', { className: 'pay-summary' }, [
      el('span', { className: 'label', textContent: 'Odenecek' }),
      el('span', { className: 'value', textContent: formatMoney(total) }),
    ]);
    body.appendChild(summary);

    const { label, input } = field('Alinan nakit (TL)', {
      id: 'payTendered', inputMode: 'decimal', autocomplete: 'off',
      value: formatMoney(total),
    });
    body.appendChild(label);

    const change = el('div', { className: 'pay-summary change' }, [
      el('span', { className: 'label', textContent: 'Para ustu' }),
      el('span', { className: 'value', textContent: '0,00' }),
    ]);
    body.appendChild(change);

    const updateChange = () => {
      const tendered = parseAmountInput(input.value) ?? 0;
      change.querySelector('.value').textContent = formatMoney(Math.max(0, tendered - total));
    };
    input.addEventListener('input', updateChange);
    // Kasiyer tutari yazip Enter'a bassin diye: nakit onayi klavyeden
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const tendered = parseAmountInput(input.value);
      if (tendered === null || tendered < total) {
        toast('Alinan tutar yetersiz.', 'err');
        beep('err');
        return;
      }
      void completeSale(saleId, total, [{ method: 'CASH', tendered }]);
    });
    updateChange();

    const quick = el('div', { className: 'quick' });
    const steps = [total, 5000, 10000, 20000, 50000, 10000000];
    const labels = ['Tam', '50', '100', '200', '500', 'Sil'];
    steps.forEach((value, index) => {
      const button = el('button', { type: 'button', textContent: labels[index] });
      button.addEventListener('click', () => {
        if (labels[index] === 'Sil') input.value = '';
        else if (labels[index] === 'Tam') input.value = formatMoney(total);
        else {
          const current = parseAmountInput(input.value) ?? 0;
          input.value = formatMoney(current + value);
        }
        updateChange();
      });
      quick.appendChild(button);
    });
    body.appendChild(quick);
    body.appendChild(numpad(input));

    const actions = el('div', { className: 'actions' });
    const cash = el('button', { className: 'btn ok big', type: 'button', textContent: 'NAKIT' });
    const card = el('button', { className: 'btn primary big', type: 'button', textContent: 'KART' });
    cash.addEventListener('click', () => {
      const tendered = parseAmountInput(input.value);
      if (tendered === null || tendered < total) {
        toast('Alinan tutar yetersiz.', 'err');
        beep('err');
        return;
      }
      void completeSale(saleId, total, [{ method: 'CASH', tendered }]);
    });
    card.addEventListener('click', () => {
      void completeSale(saleId, total, [{ method: 'CARD', tendered: total }]);
    });
    actions.append(cash, card);
    body.appendChild(actions);
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

async function completeSale(saleId, expectedTotal, payments) {
  const idempotencyKey = `${saleId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const result = await guarded(() => api('POST', '/api/sale/complete', {
    saleId, payments, expectedTotal, idempotencyKey,
  }));
  if (!result) return;
  state.lastCompleted = result;
  state.selectedLine = null;
  closeModal();
  beep('ok');
  const change = result.changeDue > 0 ? ` · PARA USTU ${formatMoney(result.changeDue)}` : '';
  toast(`Fis ${result.receiptSeries}${result.receiptNo} tamamlandi${change}`, 'ok', 5200);
  await refresh();
}

// ------------------------------ Urun arama ------------------------------

function showSearch() {
  openModal('Urun Ara', (body) => {
    const { label, input } = field('Ad, kod, PLU veya barkod', {
      id: 'searchTerm', autocomplete: 'off', spellcheck: false,
    });
    body.appendChild(label);
    const list = el('div', { className: 'list' });
    body.appendChild(list);

    let timer = null;
    const search = async () => {
      const term = input.value.trim();
      if (term.length < 2) { list.innerHTML = ''; return; }
      const products = await guarded(() => api('GET', `/api/products/search?q=${encodeURIComponent(term)}`), { silent: true });
      list.innerHTML = '';
      if (!products || products.length === 0) {
        list.appendChild(el('p', { className: 'hint', textContent: 'Sonuc yok.' }));
        return;
      }
      for (const product of products) {
        const item = el('button', { className: 'list-item', type: 'button' }, [
          el('div', {}, [
            el('div', { className: 'li-name', textContent: product.name }),
            el('div', {
              className: 'li-meta',
              textContent: `${product.code} · ${product.unit === 'KG' ? 'kilo' : 'adet'} · stok ${formatQty(product.stockQty, product.unit)}`,
            }),
          ]),
          el('div', { className: 'li-price', textContent: formatMoney(product.unitPrice) }),
        ]);
        item.addEventListener('click', () => void addProduct(product));
        list.appendChild(item);
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 180);
    });
  }, { wide: true });
}

async function addProduct(product) {
  if (product.unit === 'KG') {
    closeModal();
    showQuantityPrompt(product);
    return;
  }
  const sale = await guarded(() => api('POST', '/api/items', { productId: product.id, quantity: 1000 }));
  if (sale) {
    beep('ok');
    closeModal();
    await refresh();
  }
}

function showQuantityPrompt(product) {
  openModal(`${product.name} — miktar (kg)`, (body) => {
    const { label, input } = field('Miktar', { inputMode: 'decimal', value: '' });
    body.appendChild(label);
    body.appendChild(el('p', { className: 'hint', textContent: `Birim fiyat ${formatMoney(product.unitPrice)} / kg` }));
    body.appendChild(numpad(input));
    const ok = el('button', { className: 'btn primary big', type: 'button', textContent: 'EKLE' });
    ok.addEventListener('click', async () => {
      const qty = parseQtyInput(input.value);
      if (!qty || qty <= 0) { toast('Gecersiz miktar.', 'err'); return; }
      const sale = await guarded(() => api('POST', '/api/items', { productId: product.id, quantity: qty }));
      if (sale) { beep('ok'); closeModal(); await refresh(); }
    });
    body.appendChild(ok);
  });
}

// ------------------------------ Miktar / indirim / silme ------------------------------

function showQuantity() {
  if (!requireSale()) return;
  const item = selectedItem();
  if (!item) return;
  if (item.priceSource === 'BARCODE_PRICE') {
    toast('Terazi etiketli satirda miktar degistirilemez. Satiri silip yeniden okutun.', 'warn', 4600);
    return;
  }
  openModal(`${item.name} — miktar`, (body) => {
    const { label, input } = field(item.unit === 'KG' ? 'Yeni miktar (kg)' : 'Yeni adet', {
      inputMode: 'decimal', value: formatQty(item.quantity, item.unit),
    });
    body.appendChild(label);
    body.appendChild(numpad(input, { decimals: item.unit === 'KG' }));
    const ok = el('button', { className: 'btn primary big', type: 'button', textContent: 'ONAYLA' });
    ok.addEventListener('click', async () => {
      const qty = parseQtyInput(input.value);
      if (!qty || qty <= 0) { toast('Gecersiz miktar.', 'err'); return; }
      const sale = await guarded(() => api('POST', `/api/items/${item.lineNo}/quantity`, { quantity: qty }));
      if (sale) { closeModal(); await refresh(); }
    });
    body.appendChild(ok);
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

function showDiscount() {
  if (!requireSale()) return;
  const item = selectedItem();
  openModal('Indirim', (body) => {
    const scope = el('select', {});
    scope.appendChild(el('option', { value: 'SALE', textContent: 'Fis geneli' }));
    if (item) scope.appendChild(el('option', { value: 'LINE', textContent: `Satir: ${item.name}` }));
    body.appendChild(el('label', {}, ['Uygulama', scope]));

    const type = el('select', {});
    type.appendChild(el('option', { value: 'PERCENT', textContent: 'Yuzde (%)' }));
    type.appendChild(el('option', { value: 'AMOUNT', textContent: 'Tutar (TL)' }));
    body.appendChild(el('label', {}, ['Tur', type]));

    const { label, input } = field('Deger', { inputMode: 'decimal', value: '' });
    body.appendChild(label);
    body.appendChild(numpad(input));

    const apply = el('button', { className: 'btn primary big', type: 'button', textContent: 'UYGULA' });
    const remove = el('button', { className: 'btn ghost', type: 'button', textContent: 'Indirimi kaldir' });

    const send = async (discount) => {
      const path = scope.value === 'LINE' && item
        ? `/api/items/${item.lineNo}/discount` : '/api/sale/discount';
      let result = await guarded(() => api('POST', path, { discount }), { silent: true })
        .catch(() => null);
      if (result === null) {
        // Yetki gerekiyorsa yonetici onayi iste
        const approval = await askApproval('Indirim limiti asiliyor');
        if (!approval) return;
        result = await guarded(() => api('POST', path, { discount, approval }));
      }
      if (result) { closeModal(); await refresh(); }
    };

    apply.addEventListener('click', () => {
      const raw = input.value.trim();
      if (raw === '') { toast('Deger girin.', 'err'); return; }
      const value = type.value === 'PERCENT'
        ? Math.round(Number(raw.replace(',', '.')) * 100)
        : parseAmountInput(raw);
      if (!value || value <= 0) { toast('Gecersiz deger.', 'err'); return; }
      void send({ type: type.value, value });
    });
    remove.addEventListener('click', () => void send(null));
    body.append(apply, remove);
  });
}

async function voidLine() {
  if (!requireSale()) return;
  const item = selectedItem();
  if (!item) return;
  const sale = await guarded(() => api('POST', `/api/items/${item.lineNo}/void`, { reason: 'kasiyer iptali' }));
  if (sale) {
    state.selectedLine = null;
    toast(`${item.name} silindi`, 'ok', 1800);
    await refresh();
  }
}

async function parkSale() {
  if (!requireSale()) return;
  const result = await guarded(() => api('POST', '/api/sale/park', { saleId: state.sale.id }));
  if (result) { toast('Fis askiya alindi.', 'ok'); state.selectedLine = null; await refresh(); }
}

function showParked() {
  void (async () => {
    const list = await guarded(() => api('GET', '/api/sale/parked'));
    if (!list) return;
    openModal('Askidaki Fisler', (body) => {
      if (list.length === 0) {
        body.appendChild(el('p', { className: 'hint', textContent: 'Askida fis yok.' }));
        return;
      }
      const container = el('div', { className: 'list' });
      for (const sale of list) {
        const time = new Date(sale.openedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        const button = el('button', { className: 'list-item', type: 'button' }, [
          el('div', {}, [
            el('div', { className: 'li-name', textContent: `${sale.totals.itemCount} kalem` }),
            el('div', { className: 'li-meta', textContent: `Saat ${time}` }),
          ]),
          el('div', { className: 'li-price', textContent: formatMoney(sale.totals.total) }),
        ]);
        button.addEventListener('click', async () => {
          const result = await guarded(() => api('POST', '/api/sale/resume', { saleId: sale.id }));
          if (result) { closeModal(); await refresh(); }
        });
        container.appendChild(button);
      }
      body.appendChild(container);
    });
  })();
}

function showReprint() {
  void (async () => {
    const list = await guarded(() => api('GET', '/api/sales/recent'));
    if (!list) return;
    openModal('Fis Tekrar Basimi', (body) => {
      if (list.length === 0) {
        body.appendChild(el('p', { className: 'hint', textContent: 'Tamamlanmis fis yok.' }));
        return;
      }
      const container = el('div', { className: 'list' });
      for (const sale of list) {
        const time = new Date(sale.completedAt).toLocaleString('tr-TR', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        const button = el('button', { className: 'list-item', type: 'button' }, [
          el('div', {}, [
            el('div', { className: 'li-name', textContent: `${sale.receiptSeries}${sale.receiptNo}` }),
            el('div', { className: 'li-meta', textContent: `${time} · ${sale.totals.itemCount} kalem` }),
          ]),
          el('div', { className: 'li-price', textContent: formatMoney(sale.totals.total) }),
        ]);
        button.addEventListener('click', async () => {
          const result = await guarded(() => api('POST', '/api/print/reprint', { saleId: sale.id }));
          if (result) { closeModal(); toast('Fis kopyasi kuyruga alindi.', 'ok'); await refresh(); }
        });
        container.appendChild(button);
      }
      body.appendChild(container);
    }, { wide: true });
  })();
}

function voidSale() {
  if (!state.sale) { toast('Acik fis yok.', 'warn'); return; }
  openModal('Fis Iptali', (body) => {
    body.appendChild(el('p', {
      className: 'hint',
      textContent: `${state.sale.totals.itemCount} kalem, ${formatMoney(state.sale.totals.total)} TL iptal edilecek.`,
    }));
    const { label, input } = field('Iptal nedeni', { value: 'musteri vazgecti' });
    body.appendChild(label);
    const confirm = el('button', { className: 'btn danger big', type: 'button', textContent: 'FISI IPTAL ET' });
    confirm.addEventListener('click', async () => {
      const saleId = state.sale.id;
      const reason = input.value || 'iptal';
      let result = await guarded(() => api('POST', '/api/sale/void', { saleId, reason }), { silent: true })
        .catch(() => null);
      if (result === null) {
        const approval = await askApproval('Fis iptali icin yonetici onayi');
        if (!approval) return;
        result = await guarded(() => api('POST', '/api/sale/void', { saleId, reason, approval }));
      }
      if (result) {
        closeModal();
        state.selectedLine = null;
        toast('Fis iptal edildi.', 'warn');
        await refresh();
      }
    });
    body.appendChild(confirm);
  });
}

// ------------------------------ Kasa ------------------------------

function showCash() {
  void (async () => {
    const session = state.cashSession;
    if (!session) {
      openModal('Kasa Acilisi', (body) => {
        const { label, input } = field('Acilis devri (TL)', { inputMode: 'decimal', value: '0,00' });
        body.appendChild(label);
        body.appendChild(numpad(input));
        const ok = el('button', { className: 'btn primary big', type: 'button', textContent: 'KASAYI AC' });
        ok.addEventListener('click', async () => {
          const openingFloat = parseAmountInput(input.value) ?? 0;
          const result = await guarded(() => api('POST', '/api/cash/open', { openingFloat }));
          if (result) { closeModal(); toast('Kasa acildi.', 'ok'); await refresh(); }
        });
        body.appendChild(ok);
      });
      return;
    }

    const summary = await guarded(() => api('GET', '/api/cash/summary'));
    if (!summary) return;
    openModal('Kasa Durumu', (body) => {
      const rows = [
        ['Acilis devri', summary.session.openingFloat],
        ['Fis sayisi', summary.salesCount, true],
        ['Satis toplami', summary.salesTotal],
        ['Nakit satis', summary.cashSales],
        ['Kart satis', summary.cardSales],
        ['Iade toplami', summary.refundTotal],
        ['Kasa giris', summary.paidIn],
        ['Kasa cikis', summary.paidOut],
      ];
      for (const [name, value, plain] of rows) {
        body.appendChild(el('div', { className: 'kv' }, [
          el('span', { textContent: name }),
          el('b', { textContent: plain ? String(value) : formatMoney(value) }),
        ]));
      }
      body.appendChild(el('div', { className: 'kv strong' }, [
        el('span', { textContent: 'Beklenen nakit' }),
        el('b', { textContent: formatMoney(summary.expectedCash) }),
      ]));

      const actions = el('div', { className: 'actions' });
      const inOut = el('button', { className: 'btn', type: 'button', textContent: 'Kasa Giris/Cikis' });
      const close = el('button', { className: 'btn danger', type: 'button', textContent: 'Gun Sonu (Z)' });
      inOut.addEventListener('click', () => showCashMovement());
      close.addEventListener('click', () => showCashClose(summary));
      actions.append(inOut, close);
      body.appendChild(actions);
    });
  })();
}

function showCashMovement() {
  openModal('Kasa Giris / Cikis', (body) => {
    const type = el('select', {});
    type.appendChild(el('option', { value: 'PAID_IN', textContent: 'Kasaya giris' }));
    type.appendChild(el('option', { value: 'PAID_OUT', textContent: 'Kasadan cikis' }));
    body.appendChild(el('label', {}, ['Islem', type]));
    const { label, input } = field('Tutar (TL)', { inputMode: 'decimal', value: '' });
    body.appendChild(label);
    const note = field('Aciklama', { value: '' });
    body.appendChild(note.label);
    body.appendChild(numpad(input));
    const ok = el('button', { className: 'btn primary big', type: 'button', textContent: 'KAYDET' });
    ok.addEventListener('click', async () => {
      const amount = parseAmountInput(input.value);
      if (!amount || amount <= 0) { toast('Gecersiz tutar.', 'err'); return; }
      const result = await guarded(() => api('POST', '/api/cash/movement', {
        type: type.value, amount, note: note.input.value,
      }));
      if (result) { closeModal(); toast('Kasa hareketi kaydedildi.', 'ok'); await refresh(); }
    });
    body.appendChild(ok);
  });
}

function showCashClose(summary) {
  openModal('Gun Sonu — Kasa Kapanisi', (body) => {
    body.appendChild(el('div', { className: 'kv strong' }, [
      el('span', { textContent: 'Beklenen nakit' }),
      el('b', { textContent: formatMoney(summary.expectedCash) }),
    ]));
    const { label, input } = field('Sayilan nakit (TL)', { inputMode: 'decimal', value: '' });
    body.appendChild(label);
    const diff = el('p', { className: 'hint', textContent: 'Fark: -' });
    body.appendChild(diff);
    input.addEventListener('input', () => {
      const counted = parseAmountInput(input.value);
      diff.textContent = counted === null ? 'Fark: -'
        : `Fark: ${formatMoney(counted - summary.expectedCash)} TL`;
    });
    body.appendChild(numpad(input));
    const ok = el('button', { className: 'btn danger big', type: 'button', textContent: 'KASAYI KAPAT VE Z BAS' });
    ok.addEventListener('click', async () => {
      const countedCash = parseAmountInput(input.value);
      if (countedCash === null) { toast('Sayilan tutari girin.', 'err'); return; }
      let result = await guarded(() => api('POST', '/api/cash/close', { countedCash }), { silent: true })
        .catch(() => null);
      if (result === null) {
        const approval = await askApproval('Gun sonu icin yonetici onayi');
        if (!approval) return;
        result = await guarded(() => api('POST', '/api/cash/close', { countedCash, approval }));
      }
      if (result) { closeModal(); toast('Kasa kapatildi, Z raporu basiliyor.', 'ok', 5000); await refresh(); }
    });
    body.appendChild(ok);
  });
}

function showPrinterPanel() {
  void (async () => {
    const jobs = await guarded(() => api('GET', '/api/print/jobs'));
    if (!jobs) return;
    openModal('Yazici Kuyrugu', (body) => {
      if (jobs.length === 0) {
        body.appendChild(el('p', { className: 'hint', textContent: 'Kuyruk bos, tum fisler basildi.' }));
      } else {
        const list = el('div', { className: 'list' });
        for (const job of jobs) {
          list.appendChild(el('div', { className: 'list-item' }, [
            el('div', {}, [
              el('div', { className: 'li-name', textContent: `#${job.id} ${job.kind}` }),
              el('div', { className: 'li-meta', textContent: `${job.status} · deneme ${job.attempts}${job.lastError ? ` · ${job.lastError}` : ''}` }),
            ]),
          ]));
        }
        body.appendChild(list);
        const retry = el('button', { className: 'btn primary', type: 'button', textContent: 'Yeniden Dene' });
        retry.addEventListener('click', async () => {
          const result = await guarded(() => api('POST', '/api/print/retry'));
          if (result) { closeModal(); toast(`${result.retried} is yeniden kuyruga alindi.`, 'ok'); await refresh(); }
        });
        body.appendChild(retry);
      }
    });
  })();
}

// ------------------------------ Yonetici onayi ------------------------------

function askApproval(reason) {
  return new Promise((resolve) => {
    openModal('Yonetici Onayi', (body) => {
      body.appendChild(el('p', { className: 'hint', textContent: reason }));
      const user = field('Yonetici kullanici adi', { autocomplete: 'off' });
      const pin = field('PIN', { type: 'password', inputMode: 'numeric', autocomplete: 'off' });
      body.append(user.label, pin.label);
      body.appendChild(numpad(pin.input, { decimals: false }));
      const ok = el('button', { className: 'btn primary big', type: 'button', textContent: 'ONAYLA' });
      ok.addEventListener('click', () => {
        if (!user.input.value || !pin.input.value) { toast('Bilgileri girin.', 'err'); return; }
        closeModal();
        resolve({ username: user.input.value, pin: pin.input.value });
      });
      body.appendChild(ok);
      $('modalClose').onclick = () => { closeModal(); resolve(null); };
      setTimeout(() => user.input.focus(), 40);
    });
  });
}

// ------------------------------ Giris ------------------------------

function showLogin() {
  $('loginOverlay').hidden = false;
  $('app').hidden = true;
  setTimeout(() => $('loginUser').focus(), 60);
}

for (const pad of document.querySelectorAll('.overlay .numpad[data-target]')) {
  const target = pad.dataset.target;
  for (const key of ['7', '8', '9', '4', '5', '6', '1', '2', '3', '', '0', '⌫']) {
    const button = el('button', { type: 'button', textContent: key });
    if (key === '') button.style.visibility = 'hidden';
    button.addEventListener('click', () => {
      const input = $(target);
      if (key === '⌫') input.value = input.value.slice(0, -1);
      else input.value += key;
    });
    pad.appendChild(button);
  }
}

/* Ilk kurulum: temiz bir bilgisayarda kasiyerin terminal acmasi gerekmesin diye
   ilk yonetici hesabi dogrudan uygulamadan olusturulur. */
function showSetup() {
  $('setupOverlay').hidden = false;
  $('loginOverlay').hidden = true;
  $('app').hidden = true;
  setTimeout(() => $('setupName').focus(), 60);
}

$('setupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('setupError');
  error.hidden = true;
  try {
    const result = await api('POST', '/api/setup/admin', {
      displayName: $('setupName').value.trim(),
      username: $('setupUser').value.trim(),
      pin: $('setupPin').value,
      storeName: $('setupStore').value.trim(),
      terminalCode: $('setupTerminal').value.trim(),
    });

    // Magaza adi/kasa kodu ayar dosyasina yazildi; uygulama bu ayarlari acilista
    // okudugu icin bir kez yeniden baslamasi gerekiyor. Kasiyerden bir sey
    // beklemeden kendimiz yapiyoruz.
    if (result.restartRequired && window.pos) {
      toast('Kurulum tamamlandi, uygulama yeniden baslatiliyor...', 'ok', 4000);
      setTimeout(() => window.pos.relaunch(), 1200);
      return;
    }
    const storeName = $('setupStore').value.trim();
    $('setupOverlay').hidden = true;
    $('loginUser').value = $('setupUser').value.trim();
    $('setupPin').value = '';
    if (storeName !== '') {
      $('loginStore').textContent = storeName;
      $('storeName').textContent = storeName;
    }
    showLogin();
    toast(
      result.restartRequired
        ? 'Kurulum tamamlandi. Magaza adinin fise yansimasi icin uygulamayi yeniden baslatin.'
        : 'Kurulum tamamlandi. Simdi giris yapin.',
      'ok', 6000,
    );
  } catch (err) {
    // Kurulum baska bir pencerede/oturumda tamamlandiysa kullanici burada kilitli kalmasin
    if (err.code === 'UNAUTHORIZED') {
      $('setupOverlay').hidden = true;
      showLogin();
      toast('Kurulum daha once tamamlanmis. Mevcut hesapla giris yapin.', 'warn', 6000);
      return;
    }
    error.textContent = err.userMessage || 'Hesap olusturulamadi.';
    error.hidden = false;
  }
});

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('loginError');
  error.hidden = true;
  try {
    const result = await api('POST', '/api/login', {
      username: $('loginUser').value.trim(),
      pin: $('loginPin').value,
    });
    state.token = result.token;
    sessionStorage.setItem('pos-token', result.token);
    $('loginPin').value = '';
    $('loginOverlay').hidden = true;
    $('app').hidden = false;
    await refresh();
    beep('ok');
    if (!state.cashSession) toast('Kasa acik degil. F10 ile acilis yapin.', 'warn', 5000);
    if (state.hardwareSetupCompleted === false && state.user.role !== 'CASHIER') {
      toast('Donanim kurulumuna yonlendiriliyorsunuz...', 'warn', 4000);
      setTimeout(() => { location.href = '/admin.html#hardware'; }, 1500);
      return;
    }
    if (state.weightedFormatConfirmed === false) {
      toast('Terazi barkod formati tanimli degil — tartili urunler okutulamaz.', 'warn', 8000);
    }
  } catch (err) {
    error.textContent = err.userMessage || 'Giris basarisiz.';
    error.hidden = false;
    beep('err');
  }
});

// ------------------------------ Baslangic ------------------------------

setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}, 1000);

(async () => {
  connectEvents();
  // Sayfa yenilendiginde ayni oturumla devam et (cokme sonrasi PIN yeniden istenir)
  state.token = sessionStorage.getItem('pos-token');
  try {
    const setup = await api('GET', '/api/setup/status');
    if (setup.needsSetup) {
      $('loginStore').textContent = setup.store || 'POS Kasa';
      // Magaza adi zaten tanimliysa kurulumda tekrar sorulmaz
      if (!setup.needsStoreName) {
        $('setupStoreRow').hidden = true;
        $('setupTerminalRow').hidden = true;
      }
      if (setup.terminalCode) $('setupTerminal').value = setup.terminalCode;
      showSetup();
      return;
    }
    const initial = await api('GET', '/api/state');
    $('loginStore').textContent = initial.store?.name || 'POS';
    if (initial.user && state.token) {
      $('loginOverlay').hidden = true;
      $('app').hidden = false;
      applyState(initial);
    } else {
      state.token = null;
      sessionStorage.removeItem('pos-token');
      showLogin();
      applyState(initial);
    }
  } catch {
    showLogin();
  }
})();

/* =====================================================================
 *  WEB SIPARISLERI
 *
 *  Siparisler merkezi sunucudan senkron isciyle cekilir; burasi yalnizca
 *  gosterir. Durum degisikligi ONCE merkeze yazilir (kasa tek basina karar
 *  vermez), merkez onaylamazsa ekranda da degismez.
 * ===================================================================== */

let ordersUnseen = 0;
let ordersOpen = false;

const ORDER_STATUS_TEXT = {
  PAID: 'Yeni siparis',
  PREPARING: 'Hazirlaniyor',
  READY: 'Hazir',
  FULFILLED: 'Teslim edildi',
  CANCELLED: 'Iptal',
};

/** Kasiyerin yapabilecegi gecisler. Sunucu da AYNI kurali uygular. */
const ORDER_NEXT = {
  PAID: [['PREPARING', 'Hazirlamaya basla']],
  PREPARING: [['READY', 'Hazir']],
  READY: [['FULFILLED', 'Teslim edildi']],
};

/** Yeni siparis sesi. Harici dosya yok; kisa bir bip uretilir. */
function playOrderChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const play = (freq, startAt, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startAt + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + duration + 0.02);
    };
    play(880, 0, 0.18);
    play(1320, 0.2, 0.22);
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch (error) {
    // Ses cikmamasi satisi engellemez; sessizce gecilir.
  }
}

function updateOrdersChip(unseen) {
  const chip = $('ordersChip');
  const badge = $('ordersBadge');
  if (!chip || !badge) return;

  const previous = ordersUnseen;
  ordersUnseen = Number(unseen) || 0;

  badge.hidden = ordersUnseen === 0;
  badge.textContent = String(ordersUnseen);
  chip.classList.toggle('has-new', ordersUnseen > 0);

  // Sayi ARTTIYSA yeni siparis gelmistir: kasiyeri sesle uyar.
  if (ordersUnseen > previous) {
    playOrderChime();
    if (!ordersOpen) toast(`Yeni web siparisi geldi (${ordersUnseen})`, 'warn');
  }
}

function formatKurus(value) {
  return (Number(value || 0) / 100).toLocaleString('tr-TR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function formatOrderLine(line) {
  if (line.unit === 'KG') {
    const kg = Number(line.quantity) / 1000;
    return kg >= 1 ? `${kg.toLocaleString('tr-TR')} kg` : `${Number(line.quantity)} g`;
  }
  return `${line.quantity} adet`;
}

async function openOrders() {
  ordersOpen = true;
  openModal('Web Siparisleri', (body) => {
    body.innerHTML = '<div class="order-empty">Yukleniyor...</div>';
    loadOrdersInto(body);
  }, { wide: true });

  const overlay = $('modalOverlay');
  const stop = () => { ordersOpen = false; overlay.removeEventListener('click', stop); };
  overlay.addEventListener('click', stop);
}

async function loadOrdersInto(body) {
  let payload;
  try {
    payload = await api('GET', '/api/orders/online');
  } catch (error) {
    body.innerHTML = '';
    body.appendChild(el('div', { className: 'order-empty', textContent:
      'Siparisler alinamadi: ' + (error.userMessage || error.message) }));
    return;
  }

  const orders = payload.orders || [];
  body.innerHTML = '';

  if (payload.lastError) {
    body.appendChild(el('div', { className: 'order-warning', textContent:
      'Merkezle son baglanti hatasi: ' + payload.lastError }));
  }

  if (orders.length === 0) {
    body.appendChild(el('div', { className: 'order-empty', textContent: 'Bekleyen web siparisi yok.' }));
  } else {
    const list = el('div', { className: 'order-list' });
    orders.forEach((order) => list.appendChild(buildOrderCard(order, body)));
    body.appendChild(list);
  }

  // Ekranda gorulen siparisler "goruldu" isaretlenir; uyari tekrar calmaz.
  const unseenIds = orders.filter((o) => !o.seenAt).map((o) => o.id);
  if (unseenIds.length > 0) {
    try {
      await api('POST', '/api/orders/online/seen', { ids: unseenIds });
      updateOrdersChip(0);
    } catch (error) {
      // Isaretleme basarisiz olsa da liste gosterilmeye devam eder.
    }
  }
}

function buildOrderCard(order, body) {
  const card = el('div', { className: 'order-card' + (order.seenAt ? '' : ' is-new') });

  const head = el('div', { className: 'row' }, [
    el('span', { className: 'no', textContent: order.orderNo || order.id.slice(0, 8) }),
    el('span', { className: 'order-pill ' + order.status,
                 textContent: ORDER_STATUS_TEXT[order.status] || order.status }),
    el('span', { className: 'spacer' }),
    el('span', { className: 'total', textContent: formatKurus(order.total) + ' TL' }),
  ]);
  card.appendChild(head);

  const address = order.address || {};
  const whoParts = [order.customerName, order.customerPhone,
    [address.address, address.district, address.city].filter(Boolean).join(' ')];
  card.appendChild(el('div', { className: 'who', textContent: whoParts.filter(Boolean).join(' - ') }));

  const lines = el('div', { className: 'lines' });
  (order.lines || []).forEach((line) => {
    lines.appendChild(el('div', {}, [
      el('span', { textContent: `${line.name} - ${formatOrderLine(line)}` }),
      el('span', { textContent: formatKurus(line.netAmount) + ' TL' }),
    ]));
  });
  if (Number(order.shippingTotal) > 0) {
    lines.appendChild(el('div', {}, [
      el('span', { textContent: 'Kargo' }),
      el('span', { textContent: formatKurus(order.shippingTotal) + ' TL' }),
    ]));
  }
  card.appendChild(lines);

  if (order.notes) {
    card.appendChild(el('div', { className: 'note', textContent: 'Not: ' + order.notes }));
  }

  const actions = el('div', { className: 'actions' });
  (ORDER_NEXT[order.status] || []).forEach(([status, label]) => {
    actions.appendChild(el('button', {
      className: 'btn primary', textContent: label,
      onclick: () => changeOrderStatus(order.id, status, body),
    }));
  });
  actions.appendChild(el('button', {
    className: 'btn', textContent: 'Fis yazdir',
    onclick: () => printOrderTicket(order),
  }));
  card.appendChild(actions);

  return card;
}

async function changeOrderStatus(orderId, status, body) {
  try {
    await api('POST', `/api/orders/online/${orderId}/status`, { status });
    toast('Siparis durumu guncellendi', 'ok');
    await loadOrdersInto(body);
  } catch (error) {
    toast(error.userMessage || error.message || 'Durum degistirilemedi', 'error');
  }
}

/** Hazirlik fisi: mutfak/paketleme icin siparis dokumu. */
function printOrderTicket(order) {
  const lines = (order.lines || [])
    .map((line) => `${line.name} - ${formatOrderLine(line)}`)
    .join('\n');
  const address = order.address || {};
  const text = [
    'WEB SIPARISI',
    order.orderNo || order.id.slice(0, 8),
    '',
    order.customerName,
    order.customerPhone,
    [address.address, address.district, address.city].filter(Boolean).join(' '),
    '',
    lines,
    '',
    'TOPLAM: ' + formatKurus(order.total) + ' TL',
    order.notes ? 'NOT: ' + order.notes : '',
  ].filter(Boolean).join('\n');

  // Tarayici yazdirma penceresi: fis yazicisi Windows'ta varsayilan yaziciysa
  // dogrudan basar. ESC/POS kuyrugu satis fisleri icindir, karistirmayiz.
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '100%';
  document.body.appendChild(frame);
  frame.contentDocument.body.innerHTML =
    `<pre style="font:14px/1.4 monospace;white-space:pre-wrap">${text.replace(/[<>&]/g, '')}</pre>`;
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 1500);
}

const ordersChipEl = document.getElementById('ordersChip');
if (ordersChipEl) ordersChipEl.addEventListener('click', openOrders);
