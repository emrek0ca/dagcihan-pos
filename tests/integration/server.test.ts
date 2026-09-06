import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seed, testPosConfig, type Harness } from '../helpers/harness.ts';
import { PosServer } from '../../src/app/server.ts';
import { makeLabel, type LabelLayout } from '../fixtures/weighted-labels.ts';

const WEIGHT: LabelLayout = { prefix: '27', pluLength: 5, valueLength: 5, valueScale: 3 };

let current: { harness: Harness; server: PosServer; base: string } | null = null;

afterEach(async () => {
  if (current !== null) {
    await current.server.close();
    current.harness.dispose();
    current = null;
  }
});

async function startServer() {
  const config = testPosConfig({ server: { host: '127.0.0.1', port: 0 } });
  const harness = createHarness({ config });
  const server = new PosServer(harness.app, { uiRoot: 'ui' });
  const port = await server.listen();
  current = { harness, server, base: `http://127.0.0.1:${port}` };
  return current;
}

async function call(
  base: string, method: string, path: string,
  body?: unknown, token?: string,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { 'x-pos-token': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json() };
}

describe('yerel API', () => {
  test('giris yapilmadan satis islemi reddedilir', async () => {
    const { base } = await startServer();
    const result = await call(base, 'POST', '/api/scan', { raw: '8690504060017' });
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, 'UNAUTHORIZED');
  });

  test('hatali PIN ile giris reddedilir', async () => {
    const { base, harness } = await startServer();
    seed(harness);
    const result = await call(base, 'POST', '/api/login', { username: 'kasiyer', pin: '0000' });
    assert.equal(result.status, 401);
  });

  test('uctan uca: giris -> okutma -> odeme -> fis', async () => {
    const { base, harness } = await startServer();
    seed(harness);

    const login = await call(base, 'POST', '/api/login', { username: 'kasiyer', pin: '1234' });
    assert.equal(login.status, 200);
    const token = login.json.token as string;

    const scan1 = await call(base, 'POST', '/api/scan',
      { raw: makeLabel(WEIGHT, 231, 750, false) }, token);
    assert.equal(scan1.status, 200);
    assert.equal(scan1.json.productName, 'Ic Findik');
    assert.equal(scan1.json.sale.totals.total, 22500);

    const scan2 = await call(base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    assert.equal(scan2.json.sale.totals.total, 22500 + 750);

    const saleId = scan2.json.sale.id as number;
    const complete = await call(base, 'POST', '/api/sale/complete', {
      saleId,
      payments: [{ method: 'CASH', tendered: 25000 }],
      expectedTotal: 23250,
      idempotencyKey: 'test-key-1',
    }, token);
    assert.equal(complete.status, 200);
    assert.equal(complete.json.total, 23250);
    assert.equal(complete.json.changeDue, 1750);

    // Ayni anahtarla tekrar: yeni satis olusmaz
    const repeat = await call(base, 'POST', '/api/sale/complete', {
      saleId,
      payments: [{ method: 'CASH', tendered: 25000 }],
      expectedTotal: 23250,
      idempotencyKey: 'test-key-1',
    }, token);
    assert.equal(repeat.json.receiptNo, complete.json.receiptNo);

    const state = await call(base, 'GET', '/api/state', undefined, token);
    assert.equal(state.json.sale, null, 'tamamlanan fis sonrasi acik fis olmamali');
    assert.equal(state.json.user.name, 'Ayse K.');
  });

  test('bilinmeyen barkod anlasilir hata dondurur', async () => {
    const { base, harness } = await startServer();
    seed(harness);
    const login = await call(base, 'POST', '/api/login', { username: 'kasiyer', pin: '1234' });
    const result = await call(base, 'POST', '/api/scan', { raw: '1234567890128' }, login.json.token);
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, 'BARCODE_UNKNOWN');
    assert.ok(typeof result.json.error.userMessage === 'string');
  });

  test('urun aramasi calisir', async () => {
    const { base, harness } = await startServer();
    seed(harness);
    const login = await call(base, 'POST', '/api/login', { username: 'kasiyer', pin: '1234' });
    const result = await call(base, 'GET', '/api/products/search?q=findik', undefined, login.json.token);
    assert.equal(result.status, 200);
    assert.equal(result.json.length, 1);
    assert.equal(result.json[0].name, 'Ic Findik');
  });

  test('yetkisiz kullanici fis iptali yapamaz', async () => {
    const { base, harness } = await startServer();
    seed(harness);
    const login = await call(base, 'POST', '/api/login', { username: 'kasiyer', pin: '1234' });
    const token = login.json.token as string;
    const scan = await call(base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    const result = await call(base, 'POST', '/api/sale/void',
      { saleId: scan.json.sale.id, reason: 'test' }, token);
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, 'UNAUTHORIZED');
  });

  test('yonetici onayi ile fis iptali yapilir', async () => {
    const { base, harness } = await startServer();
    seed(harness);
    const login = await call(base, 'POST', '/api/login', { username: 'kasiyer', pin: '1234' });
    const token = login.json.token as string;
    const scan = await call(base, 'POST', '/api/scan', { raw: '8690504060017' }, token);
    const result = await call(base, 'POST', '/api/sale/void', {
      saleId: scan.json.sale.id,
      reason: 'musteri vazgecti',
      approval: { username: 'mudur', pin: '9999' },
    }, token);
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'VOIDED');
  });

  test('SSE akisi durum olaylarini iletir', async () => {
    const { base, harness } = await startServer();
    seed(harness);
    const login = await call(base, 'POST', '/api/login', { username: 'kasiyer', pin: '1234' });
    const token = login.json.token as string;

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = stream.body!.getReader();

    await call(base, 'POST', '/api/scan', { raw: '8690504060017' }, token);

    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('event: state') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    assert.ok(text.includes('event: '), 'SSE olayi alinmali');
  });
});
