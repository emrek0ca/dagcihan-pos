'use strict';

/**
 * Siparis takip penceresi.
 *
 * Ag istekleri ana surectedir; burada yalnizca gosterim ve kullanici islemi
 * vardir. Durum degisikligi merkeze yazilir, yanit gelmeden liste guncellenmez.
 */

const $ = (id) => document.getElementById(id);

let currentFilter = 'OPEN';
let orders = [];

const STATUS_TEXT = {
  PAID: 'Yeni siparis',
  PREPARING: 'Hazirlaniyor',
  READY: 'Hazir',
  FULFILLED: 'Teslim edildi',
  CANCELLED: 'Iptal',
  REFUNDED: 'Iade',
  PENDING_PAYMENT: 'Odeme bekleniyor',
};

function toast(message, isError) {
  const node = $('toast');
  node.textContent = message;
  node.className = isError ? 'toast err' : 'toast';
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 3000);
}

function money(kurus) {
  return (Number(kurus || 0) / 100).toLocaleString('tr-TR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function amount(line) {
  if (line.unit === 'KG') {
    const kg = Number(line.quantity) / 1000;
    return kg >= 1 ? `${kg.toLocaleString('tr-TR')} kg` : `${Number(line.quantity)} g`;
  }
  return `${line.quantity} adet`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.forEach((child) => { if (child) node.appendChild(child); });
  return node;
}

/** Yeni siparis sesi. Harici dosya yok; iki tonlu kisa bip uretilir. */
function chime() {
  try {
    const ctx = new AudioContext();
    const beep = (freq, at, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.02);
    };
    beep(880, 0, 0.18);
    beep(1320, 0.2, 0.24);
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch {
    /* ses cikmamasi isleyisi engellemez */
  }
}

// ------------------------------ gorunum ------------------------------

function applyState(state) {
  const conn = $('conn');
  conn.className = state.connected ? 'conn ok' : 'conn bad';
  $('connText').textContent = state.connected
    ? 'bagli'
    : (state.lastError ? 'baglanti yok' : 'baglaniyor');

  const loggedIn = Boolean(state.user);
  $('loginView').hidden = loggedIn;
  $('ordersView').hidden = !loggedIn;
  $('logoutBtn').hidden = !loggedIn;
  $('serverHint').textContent = state.serverUrl;

  const warning = $('warning');
  if (state.lastError && loggedIn) {
    warning.hidden = false;
    warning.textContent = `Sunucu hatasi: ${state.lastError}`;
  } else {
    warning.hidden = true;
  }

  orders = state.orders || [];
  renderList();
}

function visibleOrders() {
  if (currentFilter === 'OPEN') {
    return orders.filter((o) => ['PAID', 'PREPARING', 'READY'].includes(o.status));
  }
  return orders.filter((o) => o.status === currentFilter);
}

function renderList() {
  const list = $('list');
  const rows = visibleOrders();
  $('countLabel').textContent = rows.length === 0 ? '' : `${rows.length} siparis`;

  list.innerHTML = '';
  if (rows.length === 0) {
    list.appendChild(el('div', { className: 'empty', textContent: 'Gosterilecek siparis yok.' }));
    return;
  }
  rows.forEach((order) => list.appendChild(card(order)));
}

function card(order) {
  const node = el('div', { className: 'card' + (order.status === 'PAID' ? ' is-new' : '') });

  node.appendChild(el('div', { className: 'head' }, [
    el('span', { className: 'no', textContent: order.orderNo || order.id.slice(0, 8) }),
    el('span', {
      className: 'pill ' + order.status,
      textContent: STATUS_TEXT[order.status] || order.status,
    }),
    el('span', { className: 'total', textContent: money(order.total) + ' TL' }),
  ]));

  const address = order.address || {};
  const who = [
    order.customerName,
    order.customerPhone,
    [address.address, address.district, address.city].filter(Boolean).join(' '),
  ].filter(Boolean).join(' · ');
  node.appendChild(el('div', { className: 'who', textContent: who }));

  const lines = el('div', { className: 'lines' });
  (order.lines || []).forEach((line) => {
    lines.appendChild(el('div', {}, [
      el('span', { textContent: `${line.name} — ${amount(line)}` }),
      el('span', { textContent: money(line.netAmount) + ' TL' }),
    ]));
  });
  if (Number(order.shippingTotal) > 0) {
    lines.appendChild(el('div', {}, [
      el('span', { textContent: 'Kargo' }),
      el('span', { textContent: money(order.shippingTotal) + ' TL' }),
    ]));
  }
  node.appendChild(lines);

  if (order.notes) {
    node.appendChild(el('div', { className: 'note', textContent: 'Not: ' + order.notes }));
  }

  const actions = el('div', { className: 'actions' });
  (order.next || []).forEach(([status, label]) => {
    actions.appendChild(el('button', {
      className: 'btn primary',
      textContent: label,
      onclick: (event) => changeStatus(event.currentTarget, order.id, status),
    }));
  });
  actions.appendChild(el('button', {
    className: 'btn',
    textContent: 'Fis yazdir',
    onclick: () => printTicket(order),
  }));
  node.appendChild(actions);

  return node;
}

async function changeStatus(button, orderId, status) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Gonderiliyor...';
  try {
    const state = await window.siparis.changeStatus(orderId, status);
    applyState(state);
    toast('Durum guncellendi');
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    toast(error.message || 'Durum degistirilemedi', true);
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

/** Hazirlik fisi: paketleme icin siparis dokumu. */
function printTicket(order) {
  const address = order.address || {};
  const rows = (order.lines || [])
    .map((line) => `${escapeHtml(line.name)} — ${escapeHtml(amount(line))}`)
    .join('<br>');

  const html = `<!doctype html><meta charset="utf-8">
<body style="font:13px/1.5 monospace;padding:12px;max-width:300px">
<div style="font-weight:700;font-size:15px">WEB SIPARISI</div>
<div>${escapeHtml(order.orderNo || order.id.slice(0, 8))}</div>
<hr>
<div>${escapeHtml(order.customerName)}</div>
<div>${escapeHtml(order.customerPhone)}</div>
<div>${escapeHtml([address.address, address.district, address.city].filter(Boolean).join(' '))}</div>
<hr>
<div>${rows}</div>
<hr>
<div style="font-weight:700">TOPLAM: ${money(order.total)} TL</div>
${order.notes ? `<div style="margin-top:8px">NOT: ${escapeHtml(order.notes)}</div>` : ''}
</body>`;

  window.siparis.print(html).catch((error) => toast(error.message || 'Yazdirilamadi', true));
}

// ------------------------------ olaylar ------------------------------

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('loginBtn');
  const error = $('loginError');
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Giris yapiliyor...';
  try {
    await window.siparis.login($('email').value.trim(), $('password').value, $('remember').checked);
    $('password').value = '';
    applyState(await window.siparis.state());
  } catch (err) {
    error.textContent = err.message || 'Giris basarisiz';
  } finally {
    button.disabled = false;
    button.textContent = 'Giris yap';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await window.siparis.logout();
  applyState(await window.siparis.state());
});

$('refreshBtn').addEventListener('click', async () => {
  $('refreshBtn').disabled = true;
  try {
    applyState(await window.siparis.refresh());
  } finally {
    $('refreshBtn').disabled = false;
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    renderList();
  });
});

window.siparis.onState((state) => applyState(state));
window.siparis.onNewOrders(({ count }) => {
  chime();
  toast(count === 1 ? 'Yeni siparis geldi' : `${count} yeni siparis geldi`);
});

window.siparis.state().then(applyState);
