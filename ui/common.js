/* Yonetim ekranlarinin paylasilan yardimcilari.
   POS ekrani (app.js) bilincli olarak degistirilmedi: satis davranisi test edilmis
   haliyle korunuyor. */
'use strict';

const POS = {
  token: sessionStorage.getItem('pos-token'),

  fmtMoney(kurus) {
    const value = Number(kurus || 0);
    const neg = value < 0;
    const abs = Math.abs(value);
    const lira = Math.trunc(abs / 100);
    const rest = String(abs % 100).padStart(2, '0');
    return `${neg ? '-' : ''}${String(lira).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${rest}`;
  },

  fmtQty(milli, unit) {
    const abs = Math.abs(Number(milli || 0));
    if (unit === 'EACH' && abs % 1000 === 0) return String(abs / 1000);
    return `${Math.trunc(abs / 1000)},${String(abs % 1000).padStart(3, '0')}`;
  },

  parseMoney(text) {
    const clean = String(text ?? '').trim().replace(/\./g, '').replace(',', '.');
    if (clean === '' || Number.isNaN(Number(clean))) return null;
    return Math.round(Number(clean) * 100);
  },

  parseQty(text) {
    const clean = String(text ?? '').trim().replace(',', '.');
    if (clean === '' || Number.isNaN(Number(clean))) return null;
    return Math.round(Number(clean) * 1000);
  },

  fmtDate(ms) {
    if (!ms) return '-';
    return new Date(ms).toLocaleString('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  },

  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  async api(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(POS.token ? { 'x-pos-token': POS.token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(json?.error?.message || 'Islem basarisiz');
      error.code = json?.error?.code || 'INTERNAL';
      error.userMessage = json?.error?.userMessage || 'Islem tamamlanamadi.';
      error.status = response.status;
      throw error;
    }
    return json;
  },

  el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') Object.assign(node.style, value);
      else node[key] = value;
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  },

  toast(message, kind = 'ok', ms = 3000) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(POS._toastTimer);
    POS._toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  },
};

window.POS = POS;
