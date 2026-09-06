/* POS yonetim ekranlari.
 *
 * Tum veriler MEVCUT backend'in /api/admin/* uc noktalarindan gelir.
 * Burada is mantigi yoktur; hesaplama, yetki ve dogrulama sunucudadir.
 */
'use strict';

const { api, el, toast, fmtMoney, fmtQty, parseMoney, parseQty, fmtDate, today } = POS;
const $ = (id) => document.getElementById(id);

const view = { current: 'dashboard', user: null, cache: {}, cleanup: null };

// ------------------------------ Giris kapisi ------------------------------

async function boot() {
  try {
    const state = await api('GET', '/api/state');
    if (state.user) {
      view.user = state.user;
      $('brandName').textContent = state.store?.name || 'POS';
      openAdmin();
      return;
    }
  } catch { /* oturum yok */ }
  $('gateOverlay').hidden = false;
  setTimeout(() => $('gateUser').focus(), 60);
}

$('gateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('gateError');
  error.hidden = true;
  try {
    const result = await api('POST', '/api/login', {
      username: $('gateUser').value.trim(),
      pin: $('gatePin').value,
    });
    POS.token = result.token;
    sessionStorage.setItem('pos-token', result.token);
    view.user = result.user;
    $('gateOverlay').hidden = true;
    openAdmin();
  } catch (err) {
    error.textContent = err.userMessage || 'Giris basarisiz.';
    error.hidden = false;
  }
});

$('gateBack').addEventListener('click', () => { location.href = '/'; });
$('backToPos').addEventListener('click', () => { location.href = '/'; });

function openAdmin() {
  $('gateOverlay').hidden = true;
  $('admin').hidden = false;
  $('whoAmI').textContent = `${view.user.name} · ${view.user.role}`;
  // Kasiyer rolu yalnizca goruntuleyebilecegi ekranlari gorur
  const allowed = {
    CASHIER: ['dashboard', 'sales', 'cash', 'reports'],
    MANAGER: ['dashboard', 'products', 'stock', 'sales', 'cash', 'reports', 'hardware', 'printer', 'sync'],
    ADMIN: null,
  }[view.user.role];
  for (const button of document.querySelectorAll('.nav')) {
    if (allowed !== null && !allowed.includes(button.dataset.view)) button.hidden = true;
    button.addEventListener('click', () => show(button.dataset.view));
  }
  // Adres cubugundaki #ekran ile dogrudan bir ekran acilabilir
  const requested = location.hash.replace('#', '');
  show(VIEWS[requested] !== undefined && !document.querySelector(`.nav[data-view="${requested}"]`)?.hidden
    ? requested : 'dashboard');
}

function show(name) {
  // Onceki ekran global dinleyici biraktiysa (donanim sihirbazindaki barkod
  // yakalama gibi) once onu temizle: baska ekranda okuma yakalanmasin.
  if (typeof view.cleanup === 'function') {
    try { view.cleanup(); } catch { /* temizlik hatasi gecisi engellemez */ }
    view.cleanup = null;
  }
  view.current = name;
  for (const button of document.querySelectorAll('.nav')) {
    button.classList.toggle('active', button.dataset.view === name);
  }
  $('headActions').innerHTML = '';
  $('viewBody').innerHTML = '<div class="empty-state">Yukleniyor...</div>';
  const renderer = VIEWS[name];
  if (!renderer) {
    $('viewBody').innerHTML = '<div class="empty-state">Ekran bulunamadi.</div>';
    return;
  }
  $('viewTitle').textContent = renderer.title;
  Promise.resolve(renderer.render($('viewBody'), $('headActions'))).catch((error) => {
    $('viewBody').innerHTML = '';
    $('viewBody').appendChild(el('div', { className: 'empty-state' },
      error.status === 401 ? 'Bu ekran icin yetkiniz yok.' : (error.userMessage || error.message)));
  });
}

// ------------------------------ Modal ------------------------------

function openModal(title, build, { wide = false } = {}) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.innerHTML = '';
  $('modalPanel').className = wide ? 'panel wide' : 'panel';
  build(body);
  $('modalOverlay').hidden = false;
  const first = body.querySelector('input, select');
  if (first) setTimeout(() => first.focus(), 50);
}
function closeModal() { $('modalOverlay').hidden = true; $('modalBody').innerHTML = ''; }
$('modalClose').addEventListener('click', closeModal);
$('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function field(label, props = {}, hint) {
  const input = el('input', props);
  return { input, node: el('label', {}, [label, input, hint ? el('span', { className: 'hint', textContent: hint }) : null]) };
}
function selectField(label, options, value) {
  const select = el('select', {});
  for (const [val, text] of options) {
    select.appendChild(el('option', { value: val, textContent: text, selected: val === value }));
  }
  return { input: select, node: el('label', {}, [label, select]) };
}
function table(headers, rows) {
  const thead = el('thead', {}, el('tr', {}, headers.map((h) =>
    el('th', { textContent: typeof h === 'string' ? h : h.text, className: typeof h === 'object' && h.num ? 'num' : '' }))));
  const tbody = el('tbody', {}, rows);
  return el('div', { className: 'table-wrap' }, el('table', { className: 'data' }, [thead, tbody]));
}
function card(label, value, note, kind) {
  return el('div', { className: `card${kind ? ` ${kind}` : ''}` }, [
    el('div', { className: 'card-label', textContent: label }),
    el('div', { className: 'card-value', textContent: value }),
    note ? el('div', { className: 'card-note', textContent: note }) : null,
  ]);
}
function actionButton(text, onClick, className = '') {
  const button = el('button', { type: 'button', textContent: text, className });
  button.addEventListener('click', onClick);
  return button;
}

async function guarded(fn) {
  try { return await fn(); }
  catch (error) { toast(error.userMessage || error.message, 'err', 4500); return null; }
}

// ============================== GENEL BAKIS ==============================

const VIEWS = {};

VIEWS.dashboard = {
  title: 'Genel Bakis',
  async render(body, actions) {
    const [daily, diag] = await Promise.all([
      api('GET', `/api/admin/reports/daily?date=${today()}`),
      api('GET', '/api/admin/diagnostics').catch(() => null),
    ]);
    body.innerHTML = '';
    actions.appendChild(actionButton('Yenile', () => show('dashboard'), 'btn'));

    if (diag && !diag.weightedFormatConfirmed) {
      body.appendChild(el('div', { className: 'warn-banner' }, [
        el('b', { textContent: 'Terazi barkod formati tanimli degil' }),
        'Tartili urunler kasada okutulamaz. "Terazi Barkodu" ekranindan kalibrasyonu tamamlayin.',
      ]));
    }
    if (diag && diag.simulatedDevices.length > 0) {
      body.appendChild(el('div', { className: 'warn-banner' }, [
        el('b', { textContent: 'Simulator cihaz kullaniliyor' }),
        diag.simulatedDevices.join(', ') + ' — gercek magaza kullaniminda kapatilmali.',
      ]));
    }

    body.appendChild(el('div', { className: 'cards' }, [
      card('Bugun satis', fmtMoney(daily.salesTotal), `${daily.salesCount} fis`),
      card('Ortalama sepet', fmtMoney(daily.averageBasket)),
      card('Nakit', fmtMoney(daily.cashTotal)),
      card('Kart', fmtMoney(daily.cardTotal)),
      card('Iade', fmtMoney(daily.refundTotal), `${daily.refundCount} iade`),
      card('Indirim', fmtMoney(daily.discountTotal)),
    ]));

    if (diag) {
      const section = el('div', { className: 'section' }, el('h2', { textContent: 'Sistem durumu' }));
      section.appendChild(el('div', { className: 'cards' }, [
        card('Veritabani', diag.database.ok ? 'Saglam' : 'SORUNLU', null, diag.database.ok ? 'ok' : 'bad'),
        card('Denetim zinciri', diag.audit.ok ? 'Saglam' : 'KIRIK',
          `${diag.audit.checked} kayit`, diag.audit.ok ? 'ok' : 'bad'),
        card('Stok tutarliligi', diag.stock.ok ? 'Tutarli' : `${diag.stock.mismatches.length} fark`,
          null, diag.stock.ok ? 'ok' : 'warn'),
        card('Fis kuyrugu', String(diag.printQueue.pending),
          diag.printQueue.failed > 0 ? `${diag.printQueue.failed} basarisiz` : 'bekleyen is',
          diag.printQueue.failed > 0 ? 'bad' : diag.printQueue.pending > 0 ? 'warn' : 'ok'),
        card('Barkod okuyucu', diag.scanner.state === 'CONNECTED' ? 'Bagli' : diag.scanner.state,
          diag.scanner.detail || null, diag.scanner.state === 'CONNECTED' ? 'ok' : 'warn'),
      ]));
      body.appendChild(section);
    }

    if (daily.taxBreakdown.length > 0) {
      const section = el('div', { className: 'section' }, el('h2', { textContent: 'KDV dokumu (bugun)' }));
      section.appendChild(table(
        ['Oran', { text: 'Matrah', num: true }, { text: 'KDV', num: true }],
        daily.taxBreakdown.map((t) => el('tr', {}, [
          el('td', { textContent: `%${t.rateBp / 100}` }),
          el('td', { className: 'num', textContent: fmtMoney(t.base) }),
          el('td', { className: 'num', textContent: fmtMoney(t.tax) }),
        ])),
      ));
      body.appendChild(section);
    }
  },
};

// ============================== URUNLER ==============================

VIEWS.products = {
  title: 'Urunler',
  async render(body, actions) {
    actions.appendChild(actionButton('Yeni Urun', () => productForm(null), 'btn primary'));

    const search = field('', { placeholder: 'Ad, kod, PLU veya barkod ara', autocomplete: 'off' });
    const toolbar = el('div', { className: 'toolbar' }, [search.node]);
    const container = el('div', {});
    body.innerHTML = '';
    body.append(toolbar, container);

    let timer = null;
    const load = async () => {
      const term = search.input.value.trim();
      const list = await api('GET', `/api/admin/products?q=${encodeURIComponent(term)}`);
      container.innerHTML = '';
      if (list.length === 0) {
        container.appendChild(el('div', { className: 'empty-state', textContent: 'Urun bulunamadi.' }));
        return;
      }
      container.appendChild(table(
        ['Kod', 'Ad', 'Birim', { text: 'Fiyat', num: true }, 'KDV', { text: 'Stok', num: true },
          'PLU', 'Barkod', 'Durum', ''],
        list.map((p) => el('tr', {}, [
          el('td', { textContent: p.code }),
          el('td', { textContent: p.name }),
          el('td', { textContent: p.unit === 'KG' ? 'kilo' : 'adet' }),
          el('td', { className: 'num', textContent: fmtMoney(p.unitPrice) }),
          el('td', { textContent: `%${p.taxRateBp / 100}` }),
          el('td', { className: 'num', textContent: p.trackStock ? fmtQty(p.stockQty, p.unit) : '-' }),
          el('td', { className: 'muted', textContent: p.plus.join(', ') || '-' }),
          el('td', { className: 'muted', textContent: p.barcodes.join(', ') || '-' }),
          el('td', {}, el('span', {
            className: `pill ${p.active ? 'ok' : 'bad'}`,
            textContent: p.active ? 'aktif' : 'pasif',
          })),
          el('td', {}, el('div', { className: 'row-actions' }, [
            actionButton('Duzenle', () => productForm(p)),
            actionButton(p.active ? 'Pasife al' : 'Aktif et', async () => {
              await guarded(() => api('POST', `/api/admin/products/${p.id}/active`, { active: !p.active }));
              load();
            }),
          ])),
        ])),
      ));
    };

    search.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    await load();

    function productForm(product) {
      const isNew = product === null;
      openModal(isNew ? 'Yeni Urun' : product.name, (panel) => {
        const code = field('Urun kodu', { value: product?.code ?? '', disabled: !isNew });
        const name = field('Urun adi', { value: product?.name ?? '' });
        const unit = selectField('Birim', [['EACH', 'Adet'], ['KG', 'Kilo (tartili)']], product?.unit ?? 'EACH');
        const price = field('Birim fiyat (TL)', {
          value: product ? fmtMoney(product.unitPrice) : '', inputMode: 'decimal',
        }, 'Kilo ile satilanlarda TL/kg');
        const tax = selectField('KDV orani', [['100', '%1'], ['1000', '%10'], ['2000', '%20'], ['0', '%0']],
          String(product?.taxRateBp ?? 100));
        const stock = field('Stok', {
          value: product ? fmtQty(product.stockQty, product.unit) : '0', inputMode: 'decimal',
          disabled: !isNew,
        }, isNew ? 'Acilis stogu' : 'Degistirmek icin Stok ekranini kullanin');

        const grid = el('div', { className: 'form-grid' }, [
          code.node, name.node, unit.node, price.node, tax.node, stock.node,
        ]);
        panel.appendChild(grid);

        if (!isNew) {
          panel.appendChild(el('h3', { textContent: 'Barkodlar', style: { margin: '6px 0 0' } }));
          const barcodeList = el('div', { className: 'row-actions', style: { flexWrap: 'wrap' } });
          const renderBarcodes = (codes) => {
            barcodeList.innerHTML = '';
            for (const barcode of codes) {
              barcodeList.appendChild(actionButton(`${barcode} ✕`, async () => {
                const result = await guarded(() =>
                  api('DELETE', `/api/admin/products/${product.id}/barcodes/${encodeURIComponent(barcode)}`));
                if (result) renderBarcodes(result.barcodes);
              }, 'danger'));
            }
            if (codes.length === 0) barcodeList.appendChild(el('span', { className: 'hint', textContent: 'Barkod yok' }));
          };
          renderBarcodes(product.barcodes);
          const newBarcode = field('Barkod ekle (okutabilirsiniz)', { placeholder: 'Barkodu okutun veya yazin' });
          newBarcode.input.addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const value = newBarcode.input.value.trim();
            if (value === '') return;
            const result = await guarded(() =>
              api('POST', `/api/admin/products/${product.id}/barcodes`, { barcode: value }));
            if (result) { renderBarcodes(result.barcodes); newBarcode.input.value = ''; }
          });
          panel.append(barcodeList, newBarcode.node);

          panel.appendChild(el('h3', { textContent: 'Terazi PLU', style: { margin: '6px 0 0' } }));
          const pluList = el('div', { className: 'row-actions', style: { flexWrap: 'wrap' } });
          const renderPlus = (plus) => {
            pluList.innerHTML = '';
            for (const plu of plus) {
              pluList.appendChild(actionButton(`${plu} ✕`, async () => {
                const result = await guarded(() =>
                  api('DELETE', `/api/admin/products/${product.id}/plus/${plu}`));
                if (result) renderPlus(result.plus);
              }, 'danger'));
            }
            if (plus.length === 0) pluList.appendChild(el('span', { className: 'hint', textContent: 'PLU yok' }));
          };
          renderPlus(product.plus);
          const newPlu = field('PLU ekle', { inputMode: 'numeric', placeholder: 'Terazideki PLU numarasi' });
          newPlu.input.addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const value = Number(newPlu.input.value);
            if (!value) return;
            const result = await guarded(() =>
              api('POST', `/api/admin/products/${product.id}/plus`, { plu: value }));
            if (result) { renderPlus(result.plus); newPlu.input.value = ''; }
          });
          panel.append(pluList, newPlu.node);
        }

        const save = el('button', { className: 'btn primary big', type: 'button', textContent: 'KAYDET' });
        save.addEventListener('click', async () => {
          const unitPrice = parseMoney(price.input.value);
          if (unitPrice === null) { toast('Gecersiz fiyat.', 'err'); return; }
          const payload = {
            name: name.input.value.trim(),
            unit: unit.input.value,
            unitPrice,
            taxRateBp: Number(tax.input.value),
          };
          const result = isNew
            ? await guarded(() => api('POST', '/api/admin/products', {
                ...payload, code: code.input.value.trim(), stockQty: parseQty(stock.input.value) ?? 0,
              }))
            : await guarded(() => api('PUT', `/api/admin/products/${product.id}`, payload));
          if (result) { closeModal(); toast('Kaydedildi.'); load(); }
        });
        panel.appendChild(save);
      }, { wide: true });
    }
  },
};

// ============================== STOK ==============================

VIEWS.stock = {
  title: 'Stok',
  async render(body, actions) {
    actions.appendChild(actionButton('Tutarlilik Kontrolu', async () => {
      const result = await guarded(() => api('GET', '/api/admin/stock/verify'));
      if (!result) return;
      if (result.ok) { toast('Stok defteri ile bakiye tutarli.'); return; }
      openModal('Stok tutarsizliklari', (panel) => {
        panel.appendChild(table(['Urun', { text: 'Kayitli', num: true }, { text: 'Defter', num: true }],
          result.mismatches.map((m) => el('tr', {}, [
            el('td', { textContent: m.name }),
            el('td', { className: 'num', textContent: String(m.stored / 1000) }),
            el('td', { className: 'num', textContent: String(m.computed / 1000) }),
          ]))));
        const fix = el('button', { className: 'btn danger big', type: 'button', textContent: 'DEFTERDEN YENIDEN KUR' });
        fix.addEventListener('click', async () => {
          const done = await guarded(() => api('POST', '/api/admin/stock/rebuild'));
          if (done) { closeModal(); toast(`${done.updated} urun bakiyesi duzeltildi.`); }
        });
        panel.appendChild(fix);
      }, { wide: true });
    }, 'btn'));

    const search = field('', { placeholder: 'Urun ara', autocomplete: 'off' });
    body.innerHTML = '';
    body.appendChild(el('div', { className: 'toolbar' }, [search.node]));
    const container = el('div', {});
    body.appendChild(container);

    const load = async () => {
      const list = await api('GET', `/api/admin/products?q=${encodeURIComponent(search.input.value.trim())}`);
      const tracked = list.filter((p) => p.trackStock);
      container.innerHTML = '';
      container.appendChild(table(
        ['Kod', 'Ad', { text: 'Stok', num: true }, 'Birim', ''],
        tracked.map((p) => el('tr', {}, [
          el('td', { textContent: p.code }),
          el('td', { textContent: p.name }),
          el('td', { className: 'num', textContent: fmtQty(p.stockQty, p.unit) }),
          el('td', { textContent: p.unit === 'KG' ? 'kg' : 'adet' }),
          el('td', {}, el('div', { className: 'row-actions' }, [
            actionButton('Giris', () => movementForm(p, 'PURCHASE')),
            actionButton('Fire', () => movementForm(p, 'WASTE')),
            actionButton('Sayim', () => countForm(p)),
            actionButton('Hareketler', () => movementsView(p)),
          ])),
        ])),
      ));
    };
    let timer = null;
    search.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    await load();

    function movementForm(product, type) {
      const isOut = type === 'WASTE';
      openModal(`${product.name} — ${isOut ? 'fire / cikis' : 'mal kabul'}`, (panel) => {
        const amount = field(`Miktar (${product.unit === 'KG' ? 'kg' : 'adet'})`, { inputMode: 'decimal' });
        const note = field('Aciklama', {});
        panel.append(amount.node, note.node);
        const save = el('button', { className: 'btn primary big', type: 'button', textContent: 'KAYDET' });
        save.addEventListener('click', async () => {
          const qty = parseQty(amount.input.value);
          if (!qty || qty <= 0) { toast('Gecersiz miktar.', 'err'); return; }
          const done = await guarded(() => api('POST', '/api/admin/stock/adjust', {
            productId: product.id, delta: isOut ? -qty : qty, type, note: note.input.value,
          }));
          if (done) { closeModal(); toast('Stok hareketi kaydedildi.'); load(); }
        });
        panel.appendChild(save);
      });
    }

    function countForm(product) {
      openModal(`${product.name} — sayim`, (panel) => {
        panel.appendChild(el('p', { className: 'hint', textContent: `Sistemdeki stok: ${fmtQty(product.stockQty, product.unit)}` }));
        const counted = field('Sayilan miktar', { inputMode: 'decimal' });
        const note = field('Aciklama', {});
        panel.append(counted.node, note.node);
        const save = el('button', { className: 'btn primary big', type: 'button', textContent: 'SAYIMI UYGULA' });
        save.addEventListener('click', async () => {
          const qty = parseQty(counted.input.value);
          if (qty === null || qty < 0) { toast('Gecersiz miktar.', 'err'); return; }
          const done = await guarded(() => api('POST', '/api/admin/stock/count', {
            productId: product.id, countedQty: qty, note: note.input.value,
          }));
          if (done) { closeModal(); toast('Sayim uygulandi.'); load(); }
        });
        panel.appendChild(save);
      });
    }

    async function movementsView(product) {
      const detail = await guarded(() => api('GET', `/api/admin/products/${product.id}`));
      if (!detail) return;
      openModal(`${product.name} — stok hareketleri`, (panel) => {
        if (detail.movements.length === 0) {
          panel.appendChild(el('div', { className: 'empty-state', textContent: 'Hareket yok.' }));
          return;
        }
        panel.appendChild(table(['Tarih', 'Tur', { text: 'Degisim', num: true }, { text: 'Bakiye', num: true }, 'Not'],
          detail.movements.map((m) => el('tr', {}, [
            el('td', { textContent: fmtDate(m.at) }),
            el('td', { textContent: m.type }),
            el('td', { className: 'num', textContent: `${m.delta > 0 ? '+' : ''}${m.delta / 1000}` }),
            el('td', { className: 'num', textContent: String(m.balanceAfter / 1000) }),
            el('td', { className: 'muted', textContent: m.note || '-' }),
          ]))));
      }, { wide: true });
    }
  },
};

// ============================== SATISLAR ==============================

VIEWS.sales = {
  title: 'Satislar',
  async render(body, actions) {
    const date = field('Is gunu', { type: 'date', value: today() });
    const type = selectField('Belge', [['', 'Tumu'], ['SALE', 'Satis'], ['REFUND', 'Iade']], '');
    body.innerHTML = '';
    const toolbar = el('div', { className: 'toolbar' }, [date.node, type.node]);
    const container = el('div', {});
    body.append(toolbar, container);
    actions.appendChild(actionButton('Yenile', () => load(), 'btn'));

    const load = async () => {
      const params = new URLSearchParams({ date: date.input.value });
      if (type.input.value) params.set('type', type.input.value);
      const list = await api('GET', `/api/admin/sales?${params}`);
      container.innerHTML = '';
      if (list.length === 0) {
        container.appendChild(el('div', { className: 'empty-state', textContent: 'Bu gun icin kayit yok.' }));
        return;
      }
      container.appendChild(table(
        ['Fis', 'Tur', 'Durum', 'Saat', 'Kasiyer', { text: 'Kalem', num: true }, { text: 'Tutar', num: true }, ''],
        list.map((s) => el('tr', {}, [
          el('td', { textContent: s.receipt }),
          el('td', {}, el('span', {
            className: `pill ${s.docType === 'REFUND' ? 'warn' : 'info'}`,
            textContent: s.docType === 'REFUND' ? 'iade' : 'satis',
          })),
          el('td', {}, el('span', {
            className: `pill ${s.status === 'COMPLETED' ? 'ok' : 'bad'}`,
            textContent: s.status === 'COMPLETED' ? 'tamam' : 'iptal',
          })),
          el('td', { textContent: fmtDate(s.completedAt) }),
          el('td', { textContent: s.cashier }),
          el('td', { className: 'num', textContent: String(s.itemCount) }),
          el('td', { className: 'num', textContent: fmtMoney(s.total) }),
          el('td', {}, el('div', { className: 'row-actions' }, [
            actionButton('Detay', () => detail(s.id)),
          ])),
        ])),
      ));
    };
    await load();
    date.input.addEventListener('change', load);
    type.input.addEventListener('change', load);

    async function detail(id) {
      const sale = await guarded(() => api('GET', `/api/sales/${id}`));
      if (!sale) return;
      openModal(`Fis ${sale.receiptSeries ?? ''}${sale.receiptNo ?? '-'}`, (panel) => {
        panel.appendChild(table(
          ['Urun', { text: 'Miktar', num: true }, { text: 'Birim', num: true }, { text: 'Tutar', num: true }],
          sale.items.map((i) => el('tr', { className: i.voided ? 'muted' : '' }, [
            el('td', { textContent: i.name + (i.voided ? ' (iptal)' : '') }),
            el('td', { className: 'num', textContent: fmtQty(i.quantity, i.unit) }),
            el('td', { className: 'num', textContent: fmtMoney(i.unitPrice) }),
            el('td', { className: 'num', textContent: fmtMoney(i.net) }),
          ])),
        ));
        panel.appendChild(el('div', { className: 'kv strong' }, [
          el('span', { textContent: 'TOPLAM' }),
          el('b', { textContent: fmtMoney(sale.totals.total) }),
        ]));
        for (const p of sale.payments) {
          panel.appendChild(el('div', { className: 'kv' }, [
            el('span', { textContent: p.method === 'CASH' ? 'Nakit' : 'Kart' }),
            el('b', { textContent: fmtMoney(p.tendered) }),
          ]));
        }

        const buttons = el('div', { className: 'actions' });
        buttons.appendChild(actionButton('Fisi Tekrar Bas', async () => {
          const done = await guarded(() => api('POST', '/api/print/reprint', { saleId: sale.id }));
          if (done) toast('Fis kopyasi kuyruga alindi.');
        }, 'btn'));
        if (sale.docType === 'SALE' && sale.status === 'COMPLETED') {
          buttons.appendChild(actionButton('Iade Yap', () => { closeModal(); refundForm(sale); }, 'btn danger'));
        }
        panel.appendChild(buttons);
      }, { wide: true });
    }

    function refundForm(sale) {
      openModal(`Iade — ${sale.receiptSeries}${sale.receiptNo}`, (panel) => {
        panel.appendChild(el('p', { className: 'hint', textContent: 'Iade edilecek satirlari ve miktarlari secin.' }));
        const inputs = new Map();
        const rows = sale.items.filter((i) => !i.voided).map((item) => {
          const check = el('input', { type: 'checkbox' });
          const qty = el('input', {
            value: fmtQty(item.quantity, item.unit), inputMode: 'decimal',
            style: { maxWidth: '120px', minHeight: '40px' },
          });
          inputs.set(item.lineNo, { check, qty, item });
          return el('tr', {}, [
            el('td', {}, check),
            el('td', { textContent: item.name }),
            el('td', { className: 'num', textContent: fmtQty(item.quantity, item.unit) }),
            el('td', { className: 'num' }, qty),
            el('td', { className: 'num', textContent: fmtMoney(item.net) }),
          ]);
        });
        panel.appendChild(table(['', 'Urun', { text: 'Satilan', num: true }, { text: 'Iade', num: true }, { text: 'Tutar', num: true }], rows));

        const approvalUser = field('Yonetici kullanici adi', { autocomplete: 'off' });
        const approvalPin = field('Yonetici PIN', { type: 'password', inputMode: 'numeric' });
        panel.append(approvalUser.node, approvalPin.node);

        const confirm = el('button', { className: 'btn danger big', type: 'button', textContent: 'IADE FISI OLUSTUR' });
        confirm.addEventListener('click', async () => {
          const lines = [];
          for (const [lineNo, entry] of inputs) {
            if (!entry.check.checked) continue;
            const qty = parseQty(entry.qty.value);
            if (!qty || qty <= 0) { toast('Gecersiz iade miktari.', 'err'); return; }
            lines.push({ lineNo, quantity: qty });
          }
          if (lines.length === 0) { toast('Iade edilecek satir secin.', 'err'); return; }
          const payload = { originalSaleId: sale.id, lines };
          if (approvalUser.input.value && approvalPin.input.value) {
            payload.approval = { username: approvalUser.input.value, pin: approvalPin.input.value };
          }
          const refund = await guarded(() => api('POST', '/api/refund', payload));
          if (!refund) return;
          const done = await guarded(() => api('POST', '/api/sale/complete', {
            saleId: refund.id,
            payments: [{ method: 'CASH', tendered: refund.totals.total }],
            expectedTotal: refund.totals.total,
            idempotencyKey: `refund-${refund.id}-${Date.now()}`,
          }));
          if (done) {
            closeModal();
            toast(`Iade tamamlandi: ${fmtMoney(done.total)} TL musteriye odenecek.`, 'ok', 6000);
            load();
          }
        });
        panel.appendChild(confirm);
      }, { wide: true });
    }
  },
};

// ============================== KASA ==============================

VIEWS.cash = {
  title: 'Kasa Oturumlari',
  async render(body) {
    const sessions = await api('GET', '/api/admin/cash/sessions');
    body.innerHTML = '';
    if (sessions.length === 0) {
      body.appendChild(el('div', { className: 'empty-state', textContent: 'Kasa oturumu yok.' }));
      return;
    }
    body.appendChild(table(
      ['Oturum', 'Is gunu', 'Durum', 'Acilis', 'Kapanis',
        { text: 'Devir', num: true }, { text: 'Sayilan', num: true }, { text: 'Fark', num: true }, ''],
      sessions.map((s) => el('tr', {}, [
        el('td', { textContent: `#${s.id}` }),
        el('td', { textContent: s.businessDate }),
        el('td', {}, el('span', {
          className: `pill ${s.status === 'OPEN' ? 'warn' : 'ok'}`,
          textContent: s.status === 'OPEN' ? 'acik' : 'kapali',
        })),
        el('td', { textContent: fmtDate(s.openedAt) }),
        el('td', { textContent: s.closedAt ? fmtDate(s.closedAt) : '-' }),
        el('td', { className: 'num', textContent: fmtMoney(s.openingFloat) }),
        el('td', { className: 'num', textContent: s.countedCash === null ? '-' : fmtMoney(s.countedCash) }),
        el('td', {
          className: 'num',
          textContent: s.variance === null ? '-' : fmtMoney(s.variance),
          style: { color: s.variance ? (s.variance < 0 ? '#ff8b87' : '#8ee6a4') : '' },
        }),
        el('td', {}, el('div', { className: 'row-actions' }, [
          actionButton('Ozet', () => summary(s.id)),
          actionButton('Rapor Bas', async () => {
            const done = await guarded(() => api('POST', `/api/admin/cash/sessions/${s.id}/print`,
              { kind: s.status === 'OPEN' ? 'X_REPORT' : 'Z_REPORT' }));
            if (done) toast('Rapor kuyruga alindi.');
          }),
        ])),
      ])),
    ));

    async function summary(id) {
      const s = await guarded(() => api('GET', `/api/admin/cash/sessions/${id}`));
      if (!s) return;
      openModal(`Kasa Oturumu #${id}`, (panel) => {
        const rows = [
          ['Acilis devri', fmtMoney(s.session.openingFloat)],
          ['Fis sayisi', String(s.salesCount)],
          ['Satis toplami', fmtMoney(s.salesTotal)],
          ['Nakit satis', fmtMoney(s.cashSales)],
          ['Kart satis', fmtMoney(s.cardSales)],
          ['Iade', `${s.refundCount} · ${fmtMoney(s.refundTotal)}`],
          ['Indirim', fmtMoney(s.discountTotal)],
          ['Kasa giris', fmtMoney(s.paidIn)],
          ['Kasa cikis', fmtMoney(s.paidOut)],
          ['Iptal fis', String(s.voidedSales)],
        ];
        for (const [k, v] of rows) {
          panel.appendChild(el('div', { className: 'kv' }, [el('span', { textContent: k }), el('b', { textContent: v })]));
        }
        panel.appendChild(el('div', { className: 'kv strong' }, [
          el('span', { textContent: 'Beklenen nakit' }), el('b', { textContent: fmtMoney(s.expectedCash) }),
        ]));
        if (s.session.countedCash !== null) {
          panel.appendChild(el('div', { className: 'kv strong' }, [
            el('span', { textContent: 'Fark' }), el('b', { textContent: fmtMoney(s.session.variance) }),
          ]));
        }
      });
    }
  },
};

// ============================== RAPORLAR ==============================

VIEWS.reports = {
  title: 'Raporlar',
  async render(body, actions) {
    const from = field('Baslangic', { type: 'date', value: today() });
    const to = field('Bitis', { type: 'date', value: today() });
    body.innerHTML = '';
    body.appendChild(el('div', { className: 'toolbar' }, [from.node, to.node,
      actionButton('Getir', () => load(), 'btn primary')]));
    const container = el('div', {});
    body.appendChild(container);
    actions.appendChild(actionButton('Bugun', () => {
      from.input.value = today(); to.input.value = today(); load();
    }, 'btn'));
    actions.appendChild(actionButton('Son 7 gun', () => {
      const d = new Date(); d.setDate(d.getDate() - 6);
      from.input.value = d.toISOString().slice(0, 10);
      to.input.value = today();
      load();
    }, 'btn'));

    const load = async () => {
      container.innerHTML = '<div class="empty-state">Yukleniyor...</div>';
      const [days, top] = await Promise.all([
        api('GET', `/api/admin/reports/range?from=${from.input.value}&to=${to.input.value}`),
        api('GET', `/api/admin/reports/top?from=${from.input.value}&to=${to.input.value}`),
      ]);
      container.innerHTML = '';
      if (days.length === 0) {
        container.appendChild(el('div', { className: 'empty-state', textContent: 'Bu aralikta satis yok.' }));
        return;
      }
      const totals = days.reduce((acc, d) => ({
        sales: acc.sales + d.salesTotal, refunds: acc.refunds + d.refundTotal,
        count: acc.count + d.salesCount, cash: acc.cash + d.cashTotal, card: acc.card + d.cardTotal,
      }), { sales: 0, refunds: 0, count: 0, cash: 0, card: 0 });

      container.appendChild(el('div', { className: 'cards' }, [
        card('Toplam satis', fmtMoney(totals.sales), `${totals.count} fis`),
        card('Iade', fmtMoney(totals.refunds)),
        card('Net', fmtMoney(totals.sales - totals.refunds)),
        card('Nakit', fmtMoney(totals.cash)),
        card('Kart', fmtMoney(totals.card)),
      ]));

      const daysSection = el('div', { className: 'section' }, el('h2', { textContent: 'Gun bazinda' }));
      daysSection.appendChild(table(
        ['Gun', { text: 'Fis', num: true }, { text: 'Satis', num: true }, { text: 'Iade', num: true },
          { text: 'Nakit', num: true }, { text: 'Kart', num: true }, { text: 'Ort. sepet', num: true }],
        days.map((d) => el('tr', {}, [
          el('td', { textContent: d.businessDate }),
          el('td', { className: 'num', textContent: String(d.salesCount) }),
          el('td', { className: 'num', textContent: fmtMoney(d.salesTotal) }),
          el('td', { className: 'num', textContent: fmtMoney(d.refundTotal) }),
          el('td', { className: 'num', textContent: fmtMoney(d.cashTotal) }),
          el('td', { className: 'num', textContent: fmtMoney(d.cardTotal) }),
          el('td', { className: 'num', textContent: fmtMoney(d.averageBasket) }),
        ])),
      ));
      container.appendChild(daysSection);

      const topSection = el('div', { className: 'section' }, el('h2', { textContent: 'En cok satan urunler' }));
      topSection.appendChild(table(
        ['Urun', { text: 'Miktar', num: true }, { text: 'Tutar', num: true }, { text: 'Satir', num: true }],
        top.map((p) => el('tr', {}, [
          el('td', { textContent: p.name }),
          el('td', { className: 'num', textContent: `${fmtQty(p.quantity, p.unit)} ${p.unit === 'KG' ? 'kg' : 'adet'}` }),
          el('td', { className: 'num', textContent: fmtMoney(p.total) }),
          el('td', { className: 'num', textContent: String(p.lineCount) }),
        ])),
      ));
      container.appendChild(topSection);
    };
    await load();
  },
};

// ============================== KASIYERLER ==============================

VIEWS.users = {
  title: 'Kasiyerler',
  async render(body, actions) {
    actions.appendChild(actionButton('Yeni Kullanici', () => userForm(), 'btn primary'));
    const load = async () => {
      const users = await api('GET', '/api/admin/users');
      body.innerHTML = '';
      body.appendChild(table(
        ['Kullanici adi', 'Ad soyad', 'Rol', 'Durum', ''],
        users.map((u) => el('tr', {}, [
          el('td', { textContent: u.username }),
          el('td', { textContent: u.displayName }),
          el('td', {}, el('span', { className: 'pill info', textContent: u.role })),
          el('td', {}, el('span', {
            className: `pill ${u.active ? 'ok' : 'bad'}`, textContent: u.active ? 'aktif' : 'pasif',
          })),
          el('td', {}, el('div', { className: 'row-actions' }, [
            actionButton('PIN degistir', () => pinForm(u)),
            actionButton(u.active ? 'Pasife al' : 'Aktif et', async () => {
              const done = await guarded(() => api('POST', `/api/admin/users/${u.id}/active`, { active: !u.active }));
              if (done) load();
            }, u.active ? 'danger' : ''),
          ])),
        ])),
      ));
    };
    await load();

    function userForm() {
      openModal('Yeni Kullanici', (panel) => {
        const username = field('Kullanici adi', { autocomplete: 'off' });
        const displayName = field('Ad soyad', {});
        const pin = field('PIN (en az 4 hane)', { type: 'password', inputMode: 'numeric' });
        const role = selectField('Rol', [
          ['CASHIER', 'Kasiyer'], ['MANAGER', 'Mudur'], ['ADMIN', 'Yonetici'],
        ], 'CASHIER');
        panel.append(username.node, displayName.node, pin.node, role.node);
        const save = el('button', { className: 'btn primary big', type: 'button', textContent: 'OLUSTUR' });
        save.addEventListener('click', async () => {
          const done = await guarded(() => api('POST', '/api/admin/users', {
            username: username.input.value.trim(),
            displayName: displayName.input.value.trim(),
            pin: pin.input.value,
            role: role.input.value,
          }));
          if (done) { closeModal(); toast('Kullanici olusturuldu.'); load(); }
        });
        panel.appendChild(save);
      });
    }

    function pinForm(user) {
      openModal(`${user.displayName} — PIN degistir`, (panel) => {
        const pin = field('Yeni PIN', { type: 'password', inputMode: 'numeric' });
        panel.appendChild(pin.node);
        const save = el('button', { className: 'btn primary big', type: 'button', textContent: 'KAYDET' });
        save.addEventListener('click', async () => {
          const done = await guarded(() => api('POST', `/api/admin/users/${user.id}/pin`, { pin: pin.input.value }));
          if (done) { closeModal(); toast('PIN guncellendi.'); }
        });
        panel.appendChild(save);
      });
    }
  },
};

// ============================== DONANIM KURULUM SIHIRBAZI ==============================

/* Magazadaki kisi icin tasarlandi: teknik terim yok, her adim gercek bir testle
   biter. Kesif (liste/tarama) yalnizca isi kolaylastirir; DOGRULAMA testtir. */
VIEWS.hardware = {
  title: 'Donanim Kurulumu',
  async render(body, actions) {
    const status = await api('GET', '/api/admin/hardware/status');
    body.innerHTML = '';

    if (status.setupCompleted) {
      body.appendChild(el('div', { className: 'cards' }, [
        card('Kurulum', 'Tamamlandi', fmtDate(Date.parse(status.completedAt)), 'ok'),
        card('Barkod okuyucu', status.scanner.verifiedAt ? 'Dogrulandi' : 'Test edilmedi',
          status.scanner.adapter, status.scanner.verifiedAt ? 'ok' : 'warn'),
        card('Fis yazicisi', status.printer.verifiedAt ? 'Dogrulandi' : 'Test edilmedi',
          status.printer.deviceName, status.printer.verifiedAt ? 'ok' : 'warn'),
        card('Terazi barkodu',
          status.scale.weightedFormatConfirmed ? 'Tanimli' : 'TANIMSIZ', null,
          status.scale.weightedFormatConfirmed ? 'ok' : 'bad'),
      ]));
      actions.appendChild(actionButton('Sihirbazi Tekrar Calistir', () => {
        renderWizard(body, status);
      }, 'btn'));
      return;
    }
    renderWizard(body, status);
  },
};

function renderWizard(body, status) {
  body.innerHTML = '';
  const done = { scanner: status.scanner.verifiedAt !== null, printer: status.printer.verifiedAt !== null };

  body.appendChild(el('div', { className: 'warn-banner' }, [
    el('b', { textContent: 'Donanim kurulumu' }),
    'Uc adim: barkod okuyucu, fis yazicisi ve terazi barkodu. ' +
    'Her adim gercek bir testle dogrulanir; ayarlar kalici olarak saklanir.',
  ]));

  // ---------------------------------------------------------------- 1) OKUYUCU
  const step1 = el('div', { className: `step${done.scanner ? ' done' : ''}` });
  step1.append(
    el('h3', { textContent: '1. Barkod okuyucu' }),
    el('p', {
      textContent:
        'Okuyucu bilgisayara klavye gibi baglanir, ayri surucu gerekmez. ' +
        'Asagidaki kutuya tiklamadan, elinizdeki herhangi bir barkodu okutun.',
    }),
  );
  const scanBox = el('div', {
    className: 'candidate',
    style: { textAlign: 'center', padding: '26px', fontSize: '17px' },
  }, 'Barkodu simdi okutun...');
  step1.appendChild(scanBox);
  const scanState = el('div', {});
  step1.appendChild(scanState);
  body.appendChild(step1);

  // Okuma yakalama: POS ekranindaki mantigin aynisi (odak gerektirmez)
  const wedge = { buffer: '', timer: null, lastAt: 0, active: true };
  const flush = async () => {
    const raw = wedge.buffer.trim();
    wedge.buffer = '';
    clearTimeout(wedge.timer);
    if (raw.length < 3 || !wedge.active) return;
    const result = await guarded(() => api('POST', '/api/admin/hardware/scanner/test', { raw }));
    if (!result) return;
    scanBox.style.borderColor = '#2ea043';
    scanBox.textContent = `Okundu: ${result.normalized}  (${result.length} hane)`;
    scanState.innerHTML = '';
    const detail = result.kind === 'WEIGHTED'
      ? `Tartili etiket · urun kodu ${result.itemCode}`
      : result.product
        ? `Urun: ${result.product.name}`
        : result.kind === 'PLAIN'
          ? 'Normal barkod (bu urun henuz tanimli degil, sorun degil)'
          : `Cozumlenemedi (${result.reason ?? result.kind})`;
    scanState.appendChild(el('p', { className: 'hint', textContent: detail }));
    const ok = el('button', {
      className: 'btn primary big', type: 'button',
      textContent: 'OKUYUCU CALISIYOR, DEVAM ET',
    });
    ok.addEventListener('click', async () => {
      const saved = await guarded(() =>
        api('POST', '/api/admin/hardware/scanner/confirm', { adapter: 'HID_WEDGE' }));
      if (saved) {
        wedge.active = false;
        step1.classList.add('done');
        toast('Barkod okuyucu dogrulandi.');
        scanState.innerHTML = '';
        scanState.appendChild(el('p', { className: 'hint', textContent: 'Dogrulandi.' }));
      }
    });
    scanState.appendChild(ok);
  };
  const onKey = (event) => {
    if (!wedge.active) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.key === 'Enter') {
      if (wedge.buffer.length > 0) { event.preventDefault(); void flush(); }
      return;
    }
    if (event.key.length !== 1) return;
    const now = Date.now();
    if (now - wedge.lastAt > 500) wedge.buffer = '';
    wedge.lastAt = now;
    wedge.buffer += event.key;
    clearTimeout(wedge.timer);
    wedge.timer = setTimeout(flush, 140);
  };
  document.addEventListener('keydown', onKey, true);
  view.cleanup = () => {
    wedge.active = false;
    clearTimeout(wedge.timer);
    document.removeEventListener('keydown', onKey, true);
  };

  // Okuyucu gelmezse: cihaz listesi ve seri port secenegi
  const troubleshoot = actionButton('Barkod okutamiyorum', async () => {
    const info = await guarded(() => api('GET', '/api/admin/hardware/scanners'));
    if (!info) return;
    openModal('Barkod okuyucu bulunamadi', (panel) => {
      panel.appendChild(el('p', { className: 'hint' },
        'Once sunlari kontrol edin: okuyucu USB ile takili mi, ' +
        'okuyucu barkod sonuna Enter gonderiyor mu (cihaz kilavuzunda "suffix CR").'));
      if (info.hid.supported && info.hid.devices.length > 0) {
        panel.appendChild(el('h3', { textContent: 'Bilgisayarda gorunen cihazlar' }));
        panel.appendChild(table(['Cihaz', 'Uretici', ''],
          info.hid.devices.slice(0, 12).map((d) => el('tr', {}, [
            el('td', { textContent: d.name }),
            el('td', { className: 'muted', textContent: d.manufacturer || '-' }),
            el('td', {}, d.likelyScanner
              ? el('span', { className: 'pill ok', textContent: 'okuyucu olabilir' })
              : el('span', { className: 'muted', textContent: '' })),
          ]))));
      } else if (!info.hid.supported) {
        panel.appendChild(el('p', { className: 'hint', textContent: info.hid.note ?? '' }));
      }
      if (info.serialPorts.length > 0) {
        panel.appendChild(el('h3', { textContent: 'Seri port (COM) modunda kullaniliyorsa' }));
        const select = selectField('Port', info.serialPorts.map((p) => [p, p]), info.serialPorts[0]);
        panel.appendChild(select.node);
        const useSerial = el('button', {
          className: 'btn primary', type: 'button', textContent: 'SERI PORTU KULLAN',
        });
        useSerial.addEventListener('click', async () => {
          const saved = await guarded(() => api('POST', '/api/admin/hardware/scanner/confirm', {
            adapter: 'SERIAL', serialPort: select.input.value,
          }));
          if (saved) { closeModal(); restartNotice('Okuyucu seri port moduna alindi.'); }
        });
        panel.appendChild(useSerial);
      }
    }, { wide: true });
  }, 'btn ghost');
  step1.appendChild(troubleshoot);

  // ---------------------------------------------------------------- 2) YAZICI
  const step2 = el('div', { className: `step${done.printer ? ' done' : ''}` });
  step2.append(
    el('h3', { textContent: '2. Fis yazicisi' }),
    el('p', {
      textContent:
        'Bilgisayara kurulu yazicilari listeleyip ag uzerindeki fis yazicilarini ariyoruz. ' +
        'Sectikten sonra test fisi basilir.',
    }),
  );
  const printerList = el('div', {});
  step2.appendChild(printerList);
  body.appendChild(step2);

  const selectPrinter = async (payload, label) => {
    const result = await guarded(() => api('POST', '/api/admin/hardware/printer/select', payload));
    if (!result) return;
    toast(`${label} secildi. Test fisi gonderiliyor...`, 'ok', 4000);
    const printed = await guarded(() => api('POST', '/api/admin/printer/test'));
    if (!printed) return;
    openModal('Test fisi', (panel) => {
      panel.appendChild(el('p', {
        textContent: 'Yazicidan bir test fisi cikmali. Cikti aldiniz mi?',
      }));
      const yes = el('button', {
        className: 'btn primary big', type: 'button', textContent: 'EVET, FIS CIKTI',
      });
      yes.addEventListener('click', async () => {
        const saved = await guarded(() => api('POST', '/api/admin/hardware/printer/confirm', {}));
        if (saved) {
          closeModal();
          step2.classList.add('done');
          toast('Fis yazicisi dogrulandi.');
        }
      });
      const no = el('button', { className: 'btn ghost', type: 'button', textContent: 'Hayir, cikmadi' });
      no.addEventListener('click', () => {
        closeModal();
        toast('Yaziciyi kontrol edip baska bir secenek deneyin.', 'warn', 5000);
      });
      panel.append(yes, no);
    });
  };

  const loadPrinters = async () => {
    printerList.innerHTML = '<div class="empty-state">Yazicilar araniyor...</div>';
    const local = await guarded(() => api('GET', '/api/admin/hardware/printers'));
    printerList.innerHTML = '';

    if (local && local.printers.length > 0) {
      printerList.appendChild(el('h3', { textContent: 'Bu bilgisayara kurulu yazicilar' }));
      const list = el('div', { className: 'list' });
      for (const printer of local.printers) {
        const item = el('button', { className: 'list-item', type: 'button' }, [
          el('div', {}, [
            el('div', { className: 'li-name', textContent: printer.name }),
            el('div', {
              className: 'li-meta',
              textContent: `${printer.portName}${printer.shared ? ' · paylasimda' : ''}` +
                `${printer.isDefault ? ' · varsayilan' : ''}`,
            }),
          ]),
          printer.likelyReceiptPrinter
            ? el('span', { className: 'pill ok', textContent: 'fis yazicisi' })
            : el('span', { className: 'pill info', textContent: 'yazici' }),
        ]);
        item.addEventListener('click', () => selectPrinter({
          mode: 'WINDOWS_SHARE',
          printerName: printer.name,
          ...(printer.sharePath ? { sharePath: printer.sharePath } : {}),
        }, printer.name));
        list.appendChild(item);
      }
      printerList.appendChild(list);
    } else if (local && !local.supported) {
      printerList.appendChild(el('p', { className: 'hint', textContent: local.note ?? '' }));
    } else {
      printerList.appendChild(el('p', { className: 'hint' },
        'Bu bilgisayarda kurulu yazici bulunamadi. Yazici USB ile bagliysa once ' +
        'Windows uzerinden kurun, sonra bu sayfayi yenileyin.'));
    }

    const scanButton = el('button', {
      className: 'btn', type: 'button', textContent: 'AGDAKI YAZICILARI ARA',
      style: { marginTop: '12px' },
    });
    scanButton.addEventListener('click', async () => {
      scanButton.disabled = true;
      scanButton.textContent = 'Ag taraniyor...';
      const found = await guarded(() =>
        api('POST', '/api/admin/hardware/printers/scan-network', {}));
      scanButton.disabled = false;
      scanButton.textContent = 'AGDAKI YAZICILARI ARA';
      if (!found) return;
      const section = el('div', { className: 'section' },
        el('h3', { textContent: `Ag taramasi (${found.scanned} adres tarandi)` }));
      if (found.printers.length === 0) {
        section.appendChild(el('p', { className: 'hint' },
          'Agda 9100 portundan yanit veren cihaz bulunamadi. ' +
          'Yazici Ethernet ile bagliysa ayni aga bagli oldugundan emin olun.'));
      } else {
        const list = el('div', { className: 'list' });
        for (const printer of found.printers) {
          const item = el('button', { className: 'list-item', type: 'button' }, [
            el('div', {}, [
              el('div', { className: 'li-name', textContent: `${printer.host}:${printer.port}` }),
              el('div', {
                className: 'li-meta',
                textContent: printer.respondsToEscPos
                  ? 'ESC/POS durum sorgusuna yanit verdi'
                  : 'port acik, tur dogrulanamadi',
              }),
            ]),
            printer.respondsToEscPos
              ? el('span', { className: 'pill ok', textContent: 'fis yazicisi' })
              : el('span', { className: 'pill warn', textContent: 'belirsiz' }),
          ]);
          item.addEventListener('click', () => selectPrinter({
            mode: 'TCP', host: printer.host, port: printer.port,
          }, `${printer.host}:${printer.port}`));
          list.appendChild(item);
        }
        section.appendChild(list);
      }
      printerList.appendChild(section);
    });
    printerList.appendChild(scanButton);
  };
  void loadPrinters();

  // ---------------------------------------------------------------- 3) TERAZI
  const step3 = el('div', {
    className: `step${status.scale.weightedFormatConfirmed ? ' done' : ''}`,
  });
  step3.append(
    el('h3', { textContent: '3. Terazi barkodu' }),
    el('p', {
      textContent:
        'Terazi kasaya BAGLANMAZ. Terazi etiketi basar, kasa o etiketi okur. ' +
        'Bu yuzden cihaz baglantisi gerekmez; yalnizca etiketin nasil okunacagini ' +
        'bir kez tanimlamamiz yeterli.',
    }),
  );
  if (status.scale.weightedFormatConfirmed) {
    step3.appendChild(el('p', { className: 'hint', textContent: 'Terazi barkod formati tanimli.' }));
  } else {
    step3.appendChild(el('p', { className: 'hint' },
      'Teraziden bilinen bir urunu tartip etiket basin; sonraki ekranda etiketi ' +
      'okutup uzerindeki degerleri gireceksiniz.'));
    step3.appendChild(actionButton('TERAZI BARKODUNU TANIMLA', () => {
      wedge.active = false;
      show('scale');
    }, 'btn primary big'));
  }
  body.appendChild(step3);

  // ---------------------------------------------------------------- BITIR
  const finish = el('button', {
    className: 'btn ok big', type: 'button', textContent: 'KURULUMU TAMAMLA',
    style: { marginTop: '10px' },
  });
  finish.addEventListener('click', async () => {
    // Eksik adim varsa uyar ama ENGELLEME: yazici henuz gelmemis olabilir,
    // magazanin satisa baslamasi bunun icin geciktirilmemeli.
    const fresh = await guarded(() => api('GET', '/api/admin/hardware/status'));
    const missing = [];
    if (fresh && fresh.scanner.verifiedAt === null) missing.push('barkod okuyucu testi');
    if (fresh && fresh.printer.verifiedAt === null) missing.push('fis yazicisi testi');
    if (fresh && !fresh.scale.weightedFormatConfirmed) missing.push('terazi barkod tanimi');

    if (missing.length > 0) {
      const proceed = confirm(
        `Su adimlar tamamlanmadi:\n\n- ${missing.join('\n- ')}\n\n` +
        'Kasa yine de satis yapabilir, ancak bu adimlar tamamlanana kadar ilgili ' +
        'donanim calismayabilir. Yine de kurulumu tamamlamak istiyor musunuz?',
      );
      if (!proceed) return;
    }

    const result = await guarded(() => api('POST', '/api/admin/hardware/complete'));
    if (result) {
      if (typeof view.cleanup === 'function') { view.cleanup(); view.cleanup = null; }
      restartNotice('Donanim kurulumu tamamlandi. Ayarlar kalici olarak saklandi.');
    }
  });
  body.appendChild(finish);
}

// ============================== YAZICI ==============================

VIEWS.printer = {
  title: 'Yazici',
  async render(body, actions) {
    const [settings, jobs] = await Promise.all([
      api('GET', '/api/admin/printer/settings'),
      api('GET', '/api/print/jobs').catch(() => []),
    ]);
    body.innerHTML = '';

    actions.appendChild(actionButton('Test Fisi Bas', async () => {
      const done = await guarded(() => api('POST', '/api/admin/printer/test'));
      if (done) toast('Test fisi kuyruga alindi.');
    }, 'btn primary'));
    actions.appendChild(actionButton('Turkce Karakter Testi', async () => {
      const done = await guarded(() => api('POST', '/api/admin/printer/codepage-test'));
      if (done) {
        openModal('Kod sayfasi testi', (panel) => {
          panel.appendChild(el('p', { className: 'hint' },
            'Yazicidan cikan sayfada Turkce harflerin DOGRU goründügü satiri bulun ve ' +
            'asagidan secip kaydedin.'));
          panel.appendChild(table(['Etiket', 'Ayar degeri'],
            done.candidates.map((c) => el('tr', {}, [
              el('td', { textContent: c.label }),
              el('td', { textContent: `${c.codePage}:${c.index}` }),
            ]))));
        });
      }
    }, 'btn'));

    const adapter = selectField('Baglanti tipi', [
      ['WINDOWS_SHARE', 'USB — Windows yazici paylasimi'],
      ['TCP', 'Ethernet / WiFi (RAW 9100)'],
      ['SERIAL', 'Seri port'],
      ['FILE', 'Dosyaya yaz (yalnizca test)'],
      ['NULL', 'Yazici yok (test)'],
    ], settings.adapter);
    const share = field('Paylasim adi', { value: settings.share }, 'Ornek: \\\\localhost\\XPQ805K');
    const host = field('IP adresi', { value: settings.tcp.host });
    const port = field('Port', { value: String(settings.tcp.port || 9100), inputMode: 'numeric' });
    const codePage = field('Kod sayfasi', { value: settings.codePage },
      'Turkce karakter testinden cikan deger, ornek CP857:15 veya CP1254:25');
    const width = field('Satir genisligi', { value: String(settings.charactersPerLine), inputMode: 'numeric' },
      '80mm yazicida genellikle 48');
    const drawer = selectField('Nakit odemede cekmece', [['true', 'Acilsin'], ['false', 'Acilmasin']],
      String(settings.openDrawerOnCash));

    body.appendChild(el('div', { className: 'section' }, [
      el('h2', { textContent: `Ayarlar — su an: ${settings.deviceName}` }),
      el('div', { className: 'form-grid' }, [
        adapter.node, codePage.node, share.node, width.node, host.node, port.node, drawer.node,
      ]),
    ]));

    const save = el('button', { className: 'btn primary big', type: 'button', textContent: 'AYARLARI KAYDET' });
    save.addEventListener('click', async () => {
      const done = await guarded(() => api('PUT', '/api/admin/printer/settings', {
        adapter: adapter.input.value,
        share: share.input.value,
        codePage: codePage.input.value,
        charactersPerLine: Number(width.input.value) || 48,
        openDrawerOnCash: drawer.input.value === 'true',
        tcp: { host: host.input.value, port: Number(port.input.value) || 9100 },
      }));
      if (done) restartNotice('Yazici ayarlari kaydedildi.');
    });
    body.appendChild(save);

    const queue = el('div', { className: 'section' }, el('h2', { textContent: 'Fis kuyrugu' }));
    if (jobs.length === 0) {
      queue.appendChild(el('div', { className: 'empty-state', textContent: 'Kuyruk bos, tum fisler basildi.' }));
    } else {
      queue.appendChild(table(['Is', 'Tur', 'Durum', { text: 'Deneme', num: true }, 'Hata'],
        jobs.map((j) => el('tr', {}, [
          el('td', { textContent: `#${j.id}` }),
          el('td', { textContent: j.kind }),
          el('td', {}, el('span', {
            className: `pill ${j.status === 'FAILED' ? 'bad' : 'warn'}`, textContent: j.status,
          })),
          el('td', { className: 'num', textContent: String(j.attempts) }),
          el('td', { className: 'muted', textContent: j.lastError || '-' }),
        ]))));
      queue.appendChild(actionButton('Basarisizlari Yeniden Dene', async () => {
        const done = await guarded(() => api('POST', '/api/admin/maintenance/print-retry'));
        if (done) { toast(`${done.retried} is yeniden kuyruga alindi.`); show('printer'); }
      }, 'btn primary'));
    }
    body.appendChild(queue);
  },
};

// ============================== TERAZI BARKOD KALIBRASYONU ==============================

VIEWS.scale = {
  title: 'Terazi Barkodu',
  async render(body, actions) {
    const rules = await api('GET', '/api/admin/barcode/rules');
    body.innerHTML = '';
    const samples = [];

    if (!rules.weightedFormatConfirmed) {
      body.appendChild(el('div', { className: 'warn-banner' }, [
        el('b', { textContent: 'Format henuz dogrulanmadi' }),
        'Tartili urunler kasada okutulamiyor. Guvenlik gerekcesiyle sistem barkod ' +
        'formatini TAHMIN ETMEZ; asagidaki adimlarla gercek etiketten ogrenir.',
      ]));
    } else {
      body.appendChild(el('div', { className: 'cards' }, [
        card('Durum', 'Tanimli', 'Tartili satis acik', 'ok'),
        card('Etkin kural', rules.rules.find((r) => r.enabled)?.id ?? '-'),
      ]));
      actions.appendChild(actionButton('Formati Devre Disi Birak', async () => {
        const done = await guarded(() => api('POST', '/api/admin/barcode/disable'));
        if (done) restartNotice('Tartili barkod formati devre disi birakildi.');
      }, 'btn danger'));
    }

    // --- 1. adim: etiket okut
    const step1 = el('div', { className: 'step' });
    step1.append(
      el('h3', { textContent: '1. Teraziden bir etiket basin ve buraya okutun' }),
      el('p', { textContent: 'Bilinen bir urunu tartin (ornegin 0,750 kg ic findik). Etiketi asagidaki kutuya okutun; okuyucu Enter gonderir.' }),
    );
    const codeInput = field('Barkod', { placeholder: 'Etiketi okutun veya elle yazin', autocomplete: 'off' });
    const tryResult = el('div', {});
    step1.append(codeInput.node, tryResult);
    body.appendChild(step1);

    // --- 2. adim: etiketteki gercek degerler
    const step2 = el('div', { className: 'step' });
    step2.append(
      el('h3', { textContent: '2. Etiketin uzerinde YAZAN degerleri girin' }),
      el('p', { textContent: 'Bu bilgi formatin kesin olarak dogrulanmasini saglar. En az bir alan doldurun.' }),
    );
    const plu = field('PLU', { inputMode: 'numeric', placeholder: 'orn. 231' });
    const kg = field('Agirlik (kg)', { inputMode: 'decimal', placeholder: 'orn. 0,750' });
    const tl = field('Tutar (TL)', { inputMode: 'decimal', placeholder: 'orn. 225,00' });
    step2.appendChild(el('div', { className: 'form-grid' }, [plu.node, kg.node, tl.node]));
    const addButton = actionButton('Bu etiketi listeye ekle', () => {
      const raw = codeInput.input.value.trim();
      if (raw === '') { toast('Once barkodu okutun.', 'err'); return; }
      const entry = { raw };
      if (plu.input.value) entry.knownPlu = Number(plu.input.value);
      if (kg.input.value) entry.knownWeightMilli = parseQty(kg.input.value);
      if (tl.input.value) entry.knownPriceKurus = parseMoney(tl.input.value);
      samples.push(entry);
      renderSamples();
      codeInput.input.value = ''; plu.input.value = ''; kg.input.value = ''; tl.input.value = '';
      tryResult.innerHTML = '';
      codeInput.input.focus();
    }, 'btn primary');
    const sampleList = el('div', { className: 'section' });
    step2.append(addButton, sampleList);
    body.appendChild(step2);

    function renderSamples() {
      sampleList.innerHTML = '';
      if (samples.length === 0) return;
      sampleList.appendChild(el('h2', { textContent: `Eklenen etiketler (${samples.length})` }));
      sampleList.appendChild(table(['Barkod', 'PLU', 'kg', 'TL', ''],
        samples.map((s, index) => el('tr', {}, [
          el('td', { textContent: s.raw }),
          el('td', { textContent: s.knownPlu ?? '-' }),
          el('td', { textContent: s.knownWeightMilli ? fmtQty(s.knownWeightMilli, 'KG') : '-' }),
          el('td', { textContent: s.knownPriceKurus ? fmtMoney(s.knownPriceKurus) : '-' }),
          el('td', {}, actionButton('Sil', () => { samples.splice(index, 1); renderSamples(); }, 'danger')),
        ]))));
    }

    codeInput.input.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const code = codeInput.input.value.trim();
      if (code === '') return;
      const result = await guarded(() => api('POST', '/api/admin/barcode/try', { code }));
      tryResult.innerHTML = '';
      if (!result) return;
      const parsed = result.parsed;
      tryResult.appendChild(el('p', { className: 'hint' },
        `Cozumleme: ${parsed.kind}${parsed.kind === 'WEIGHTED' ? ` · kod ${parsed.itemCode} · deger ${parsed.value}` : ''}`));
      if (result.resolved) {
        tryResult.appendChild(el('div', { className: 'cards' }, [
          card('Urun', result.resolved.productName),
          card('Miktar', String(result.resolved.quantity / 1000)),
          card('Tutar', fmtMoney(result.resolved.amount)),
        ]));
      } else if (result.error) {
        tryResult.appendChild(el('p', { className: 'error', textContent: result.error.userMessage || result.error.message }));
      }
    });

    // --- 3. adim: analiz
    const step3 = el('div', { className: 'step' });
    step3.append(
      el('h3', { textContent: '3. Formati cozumle' }),
      el('p', { textContent: 'Sistem, eklediginiz etiketleri ve daha once kasada okutulup cozulemeyen barkodlari birlikte inceler.' }),
    );
    const analyzeOut = el('div', {});
    step3.appendChild(actionButton('COZUMLE', async () => {
      analyzeOut.innerHTML = '<div class="empty-state">Inceleniyor...</div>';
      const result = await guarded(() => api('POST', '/api/admin/barcode/analyze', { samples }));
      analyzeOut.innerHTML = '';
      if (!result) return;
      if (result.candidates.length === 0) {
        analyzeOut.appendChild(el('div', { className: 'empty-state' },
          'Aday format bulunamadi. En az bir etiket okutun ve uzerindeki degerleri girin.'));
        return;
      }
      analyzeOut.appendChild(el('p', { className: 'hint', textContent: `${result.sampleCount} ornek incelendi.` }));
      result.candidates.forEach((candidate, index) => {
        const box = el('div', { className: `candidate${index === 0 ? ' best' : ''}` });
        box.appendChild(el('div', { className: 'cand-head' }, [
          el('div', {}, [
            el('b', { textContent: candidate.rule.description || candidate.rule.id }),
            el('code', { textContent: `PLU eslesme ${candidate.evidence.pluMatches}/${candidate.evidence.samplesTotal} · deger araligi ${candidate.evidence.valueInRange}/${candidate.evidence.samplesTotal} · puan ${candidate.score}` }),
          ]),
          el('span', {
            className: `pill ${candidate.confidence === 'KESIN' ? 'ok' : candidate.confidence === 'YUKSEK' ? 'info' : 'warn'}`,
            textContent: candidate.confidence,
          }),
        ]));
        for (const preview of candidate.preview) {
          box.appendChild(el('code', {
            textContent: `${preview.raw} → kod ${preview.itemCode} · ${preview.valueKind === 'PRICE' ? fmtMoney(preview.value) + ' TL' : (preview.value / 1000) + ' kg'}`,
          }));
        }
        for (const note of candidate.evidence.notes) {
          box.appendChild(el('p', { className: 'hint', textContent: `! ${note}` }));
        }
        box.appendChild(actionButton('BU FORMATI UYGULA', async () => {
          if (candidate.confidence !== 'KESIN' &&
              !confirm('Bu adayin guveni KESIN degil. Yanlis format yanlis fiyat demektir. Yine de uygulansin mi?')) {
            return;
          }
          const done = await guarded(() => api('POST', '/api/admin/barcode/apply', { rule: candidate.rule }));
          if (done) restartNotice('Terazi barkod formati tanimlandi.');
        }, 'btn primary'));
        analyzeOut.appendChild(box);
      });
    }, 'btn primary'));
    step3.appendChild(analyzeOut);
    body.appendChild(step3);

    // --- Kaydedilmis cozumlenemeyen okumalar
    const stored = await api('GET', '/api/admin/barcode/samples').catch(() => []);
    if (stored.length > 0) {
      const section = el('div', { className: 'section' },
        el('h2', { textContent: 'Kasada cozulemeyen okumalar' }));
      section.appendChild(table(['Barkod', 'Sonuc', { text: 'Adet', num: true }, 'Son okuma'],
        stored.slice(0, 30).map((s) => el('tr', {}, [
          el('td', { textContent: s.raw }),
          el('td', { textContent: s.result }),
          el('td', { className: 'num', textContent: String(s.n) }),
          el('td', { textContent: fmtDate(s.last) }),
        ]))));
      body.appendChild(section);
    }

    // --- Terazi PLU disa aktarim
    const exportSection = el('div', { className: 'step' });
    exportSection.append(
      el('h3', { textContent: 'Teraziye urun/fiyat gonderme' }),
      el('p', { textContent: 'Fiyat degisikliginden sonra PLU dosyasi uretin ve CL-Works ile teraziye yukleyin. Dogrudan ag uzerinden yukleme, protokol cihazda dogrulanmadigi icin bilincli olarak kapalidir.' }),
      actionButton('PLU DOSYASI URET', async () => {
        const result = await guarded(() => api('POST', '/api/admin/scale/export'));
        if (result) {
          openModal('PLU dosyasi', (panel) => {
            panel.appendChild(el('p', { textContent: `${result.sent} PLU yazildi.` }));
            panel.appendChild(el('code', { textContent: result.detail }));
          });
        }
      }, 'btn'),
    );
    body.appendChild(exportSection);
  },
};

// ============================== MERKEZI SUNUCU ==============================

VIEWS.sync = {
  title: 'Merkezi Sunucu',
  async render(body, actions) {
    const status = await api('GET', '/api/admin/sync/status');
    body.innerHTML = '';

    if (!status.enabled) {
      body.appendChild(el('div', { className: 'warn-banner' }, [
        el('b', { textContent: 'Bu kasa merkezi sunucuya kayitli degil' }),
        'Kasa tek basina sorunsuz calisir. Merkezi sunucuya baglamak icin ' +
        'yoneticiden aktivasyon kodu alin.',
      ]));

      // Tek merkezi sunucu var ve adresi ayar dosyasindan gelir; kasa kodu da
      // ilk kurulumda belirlenmistir. Kullanicidan YALNIZCA aktivasyon kodu istenir.
      const step = el('div', { className: 'step' });
      step.append(
        el('h3', { textContent: 'Kasayi merkezi sunucuya baglayin' }),
        el('p', {
          textContent:
            'Yoneticiden aldiginiz aktivasyon kodunu girin. Kod tek kullanimliktir ' +
            've 24 saat gecerlidir.',
        }),
      );
      const code = field('Aktivasyon kodu', {
        placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: false,
      });
      step.appendChild(code.node);

      const enroll = el('button', {
        className: 'btn primary big', type: 'button', textContent: 'BAGLAN',
      });
      const submit = async () => {
        const entered = code.input.value.trim().toUpperCase();
        if (entered === '') { toast('Aktivasyon kodunu girin.', 'err'); return; }
        const result = await guarded(() => api('POST', '/api/admin/sync/enroll', {
          enrollmentCode: entered,
        }));
        if (result) {
          toast(`Baglandi: ${result.storeName}`, 'ok', 5000);
          show('sync');
        }
      };
      enroll.addEventListener('click', submit);
      code.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void submit(); }
      });
      step.appendChild(enroll);
      body.appendChild(step);
      return;
    }

    actions.appendChild(actionButton('Simdi Senkronize Et', async () => {
      const result = await guarded(() => api('POST', '/api/admin/sync/now'));
      if (result) { toast(`Durum: ${result.state} · bekleyen ${result.pending}`); show('sync'); }
    }, 'btn primary'));

    const stateKind = status.state === 'ONLINE' ? 'ok'
      : status.state === 'ERROR' ? 'bad' : 'warn';
    body.appendChild(el('div', { className: 'cards' }, [
      card('Baglanti', status.state === 'ONLINE' ? 'Cevrimici'
        : status.state === 'OFFLINE' ? 'Cevrimdisi' : status.state, null, stateKind),
      card('Magaza', status.storeName ?? '-', status.terminalCode ?? ''),
      card('Gonderilmeyi bekleyen', String(status.pending),
        status.dead > 0 ? `${status.dead} olay basarisiz` : 'kayit',
        status.dead > 0 ? 'bad' : status.pending > 0 ? 'warn' : 'ok'),
      card('Son basarili', status.lastSuccessAt ? fmtDate(status.lastSuccessAt) : 'henuz yok'),
      card('Cekme imleci', String(status.pullCursor),
        status.bootstrapDone ? 'ilk yukleme tamam' : 'ilk yukleme bekliyor'),
      card('Gonderilen', String(status.counts.sent), 'toplam olay'),
    ]));

    if (status.lastError) {
      body.appendChild(el('div', { className: 'warn-banner' }, [
        el('b', { textContent: 'Son hata' }), status.lastError,
      ]));
    }

    body.appendChild(el('p', { className: 'hint' },
      'Merkezi sunucuya ulasilamasa bile kasa normal calisir: satislar yerel olarak ' +
      'kaydedilir ve baglanti gelince otomatik gonderilir.'));

    if (status.deadEvents.length > 0) {
      const section = el('div', { className: 'section' },
        el('h2', { textContent: 'Gonderilemeyen kayitlar' }));
      section.appendChild(table(['Tur', { text: 'Deneme', num: true }, 'Hata', 'Zaman'],
        status.deadEvents.map((e) => el('tr', {}, [
          el('td', { textContent: e.type }),
          el('td', { className: 'num', textContent: String(e.attempts) }),
          el('td', { className: 'muted', textContent: (e.last_error || '-').slice(0, 80) }),
          el('td', { textContent: fmtDate(e.occurred_at) }),
        ]))));
      section.appendChild(actionButton('Yeniden Dene', async () => {
        const result = await guarded(() => api('POST', '/api/admin/sync/retry-dead'));
        if (result) { toast(`${result.retried} kayit yeniden kuyruga alindi.`); show('sync'); }
      }, 'btn primary'));
      body.appendChild(section);
    }

    if (status.recentPulls.length > 0) {
      const section = el('div', { className: 'section' },
        el('h2', { textContent: 'Merkezden gelen son degisiklikler' }));
      section.appendChild(table(['Tur', 'Kayit', 'Islem', 'Detay', 'Zaman'],
        status.recentPulls.map((p) => el('tr', {}, [
          el('td', { textContent: p.entity_type }),
          el('td', { className: 'muted', textContent: p.entity_id }),
          el('td', { textContent: p.applied ? 'uygulandi' : 'atlandi' }),
          el('td', { className: 'muted', textContent: p.detail || '-' }),
          el('td', { textContent: fmtDate(p.at) }),
        ]))));
      body.appendChild(section);
    }

    const danger = el('div', { className: 'section' });
    danger.appendChild(actionButton('Kasa Kaydini Kaldir', async () => {
      if (!confirm('Bu kasanin merkezi sunucu kaydi kaldirilacak. Bekleyen kayitlar gonderilemez. Devam?')) return;
      const result = await guarded(() => api('POST', '/api/admin/sync/unenroll'));
      if (result) { toast('Kayit kaldirildi.', 'warn'); show('sync'); }
    }, 'btn danger'));
    body.appendChild(danger);
  },
};

// ============================== SISTEM ==============================

VIEWS.system = {
  title: 'Sistem',
  async render(body, actions) {
    const [settings, diag] = await Promise.all([
      api('GET', '/api/admin/settings/store'),
      api('GET', '/api/admin/diagnostics').catch(() => null),
    ]);
    const desktop = window.pos ? await window.pos.info() : null;
    const desktopSettings = window.pos ? await window.pos.settings.get() : null;
    body.innerHTML = '';

    // Magaza bilgileri (fise basilir)
    const storeName = field('Magaza adi', { value: settings.store.name });
    const address1 = field('Adres satiri 1', { value: settings.store.addressLines[0] ?? '' });
    const address2 = field('Adres satiri 2', { value: settings.store.addressLines[1] ?? '' });
    const phone = field('Telefon', { value: settings.store.phone });
    const taxOffice = field('Vergi dairesi', { value: settings.store.taxOffice });
    const taxNumber = field('Vergi no', { value: settings.store.taxNumber });
    const footer = field('Fis alt yazisi', { value: settings.store.receiptFooter.join(' | ') });
    const terminalName = field('Kasa adi', { value: settings.terminal.name });
    const series = field('Fis serisi', { value: settings.sales.receiptSeries },
      'Her kasada FARKLI olmali');
    const discountLimit = field('Onaysiz indirim limiti (%)', {
      value: String(settings.permissions.maxDiscountPercentWithoutApproval), inputMode: 'decimal',
    });

    body.appendChild(el('div', { className: 'section' }, [
      el('h2', { textContent: 'Magaza ve fis bilgileri' }),
      el('div', { className: 'form-grid' }, [
        storeName.node, terminalName.node, address1.node, address2.node,
        phone.node, series.node, taxOffice.node, taxNumber.node,
        footer.node, discountLimit.node,
      ]),
    ]));
    const saveStore = el('button', { className: 'btn primary big', type: 'button', textContent: 'KAYDET' });
    saveStore.addEventListener('click', async () => {
      const done = await guarded(() => api('PUT', '/api/admin/settings/store', {
        store: {
          name: storeName.input.value,
          addressLines: [address1.input.value, address2.input.value].filter((v) => v.trim() !== ''),
          phone: phone.input.value,
          taxOffice: taxOffice.input.value,
          taxNumber: taxNumber.input.value,
          receiptFooter: footer.input.value.split('|').map((v) => v.trim()).filter((v) => v !== ''),
        },
        terminal: { name: terminalName.input.value },
        sales: { receiptSeries: series.input.value },
        permissions: { maxDiscountPercentWithoutApproval: Number(discountLimit.input.value) || 10 },
      }));
      if (done) restartNotice('Magaza ayarlari kaydedildi.');
    });
    body.appendChild(saveStore);

    // --- Kasa bilgisayari ayarlari
    // Yalnizca magaza sahibinin gercekten kullandigi iki ayar birakildi.
    // (Kiosk modu tam ekranla ayni isi yaptigi icin kaldirildi; deger yine de
    //  saklaniyor, gerekirse teknik destek acabilir.)
    if (desktopSettings) {
      const section = el('div', { className: 'section' },
        el('h2', { textContent: 'Kasa bilgisayari' }));
      const toggles = [
        ['fullscreen', 'Tam ekran calis'],
        ['autoStart', 'Bilgisayar acilinca otomatik baslat'],
        ['preventDisplaySleep', 'Ekran uykuya gecmesin'],
      ];
      const grid = el('div', { className: 'form-grid' });
      for (const [key, label] of toggles) {
        const select = selectField(label, [['true', 'Acik'], ['false', 'Kapali']],
          String(desktopSettings[key]));
        select.input.addEventListener('change', async () => {
          await window.pos.settings.set(key, select.input.value === 'true');
          toast('Ayar uygulandi.');
        });
        grid.appendChild(select.node);
      }
      section.appendChild(grid);

      const buttons = el('div', { className: 'row-actions', style: { marginTop: '14px' } });
      buttons.append(
        actionButton('Yedek Al', async () => {
          const result = await window.pos.backupNow();
          toast(
            result.ok ? `Yedek alindi (${Math.round(result.bytes / 1024)} KB)` : 'Yedek alinamadi',
            result.ok ? 'ok' : 'err',
          );
        }),
        actionButton('Yedek Klasoru', () => window.pos.openDataFolder()),
        actionButton('Kayitlar (destek icin)', () => window.pos.openLogFolder()),
        actionButton('Uygulamayi Yeniden Baslat', () => {
          if (confirm('Uygulama yeniden baslatilacak. Devam edilsin mi?')) window.pos.relaunch();
        }, 'danger'),
      );
      section.appendChild(buttons);
      body.appendChild(section);
    }

    // --- Durum ozeti: teknik yol/dosya adi yok, yalnizca "iyi mi degil mi"
    const health = [];
    if (diag) {
      health.push(card('Veritabani', diag.database.ok ? 'Saglam' : 'SORUNLU', null,
        diag.database.ok ? 'ok' : 'bad'));
      health.push(card('Kayit butunlugu', diag.audit.ok ? 'Saglam' : 'SORUNLU', null,
        diag.audit.ok ? 'ok' : 'bad'));
      health.push(card('Stok', diag.stock.ok ? 'Tutarli' : `${diag.stock.mismatches.length} fark`,
        null, diag.stock.ok ? 'ok' : 'warn'));
    }
    if (desktop) {
      health.push(card('Surum', desktop.version, desktop.packaged ? null : 'gelistirme surumu'));
    }
    if (health.length > 0) {
      body.appendChild(el('div', { className: 'section' }, [
        el('h2', { textContent: 'Durum' }),
        el('div', { className: 'cards' }, health),
      ]));
    }
    void actions;
  },
};

function restartNotice(message) {
  openModal('Yeniden baslatma gerekiyor', (panel) => {
    panel.appendChild(el('p', { textContent: message }));
    panel.appendChild(el('p', { className: 'hint' },
      'Degisikligin gecerli olmasi icin uygulamanin yeniden baslatilmasi gerekiyor.'));
    if (window.pos) {
      const now = el('button', { className: 'btn primary big', type: 'button', textContent: 'SIMDI YENIDEN BASLAT' });
      now.addEventListener('click', () => window.pos.relaunch());
      panel.appendChild(now);
    }
    const later = el('button', { className: 'btn ghost', type: 'button', textContent: 'Daha sonra' });
    later.addEventListener('click', closeModal);
    panel.appendChild(later);
  });
}

boot();
