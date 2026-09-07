/**
 * Web siparislerinin kasadaki aynasi.
 *
 * Odak: siparis kaybolmasin, mukerrer uyari calmasin ve kasiyer izinsiz
 * durum gecisi yapamasin.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHarness } from '../helpers/harness.ts';
import { OnlineOrders, CASHIER_TRANSITIONS, type RemoteOrder } from '../../src/modules/orders/online-orders.ts';

const remote = (overrides: Partial<RemoteOrder> = {}): RemoteOrder => ({
  id: 'ord-1',
  order_no: 'WEB-0001',
  channel: 'ONLINE',
  status: 'PAID',
  currency: 'TRY',
  subtotal: 40000,
  shipping_total: 4999,
  total: 44999,
  external_ref: 'oid1',
  notes: 'Kapiya birakmayin',
  placed_at: '2026-09-07T20:00:00.000Z',
  updated_at: '2026-09-07T20:00:05.000Z',
  customer_name: 'Ayse Yilmaz',
  customer_phone: '5551112233',
  customer_email: 'ayse@example.com',
  customer_address: { city: 'Istanbul' },
  lines: [
    { name_snapshot: 'Antep Fistigi', unit: 'KG', quantity: 1000, unit_price: 40000, net_amount: 40000 },
  ],
  ...overrides,
});

test('siparis yerele yazilir ve tutarlar KURUS tam sayi kalir', () => {
  const h = createHarness();
  const orders = new OnlineOrders(h.app.db);

  const result = orders.upsertMany([remote()]);
  assert.equal(result.created, 1);

  const order = orders.get('ord-1');
  assert.ok(order);
  assert.equal(order.total, 44999);
  assert.equal(order.shippingTotal, 4999);
  assert.equal(order.customerName, 'Ayse Yilmaz');
  assert.equal(order.lines.length, 1);
  assert.equal(order.lines[0]?.unit, 'KG');
  // KG satirinda miktar GRAM tutulur; kayan noktali sayiya cevrilmez.
  assert.equal(order.lines[0]?.quantity, 1000);
  h.dispose();
});

test('ayni siparis tekrar gelirse MUKERRER kayit olusmaz, guncellenir', () => {
  const h = createHarness();
  const orders = new OnlineOrders(h.app.db);

  orders.upsertMany([remote()]);
  const second = orders.upsertMany([remote({ status: 'PREPARING', total: 44999 })]);

  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(orders.list(['PREPARING']).length, 1);
  assert.equal(orders.list(['PAID']).length, 0);
  h.dispose();
});

test('goruldu isareti guncellemede KORUNUR: uyari ikinci kez calmaz', () => {
  const h = createHarness();
  const orders = new OnlineOrders(h.app.db);

  orders.upsertMany([remote()]);
  assert.equal(orders.unseenCount(), 1);

  orders.markSeen(['ord-1']);
  assert.equal(orders.unseenCount(), 0);

  // Merkez siparisi guncelledi (orn. durum degisti) - yeniden "yeni" sayilmamali.
  orders.upsertMany([remote({ status: 'PREPARING', updated_at: '2026-09-07T20:10:00.000Z' })]);
  assert.equal(orders.unseenCount(), 0, 'guncelleme siparisi yeniden okunmamis yapmamali');
  h.dispose();
});

test('yalnizca acik siparisler uyari sayisina girer', () => {
  const h = createHarness();
  const orders = new OnlineOrders(h.app.db);

  orders.upsertMany([
    remote({ id: 'a', status: 'PAID' }),
    remote({ id: 'b', status: 'FULFILLED' }),
    remote({ id: 'c', status: 'CANCELLED' }),
  ]);

  assert.equal(orders.unseenCount(), 1, 'teslim edilen ve iptal edilen siparis uyari uretmez');
  h.dispose();
});

test('artimli cekme icin en son degisiklik zamani dogru bulunur', () => {
  const h = createHarness();
  const orders = new OnlineOrders(h.app.db);

  assert.equal(orders.lastRemoteUpdatedAt(), null);
  orders.upsertMany([
    remote({ id: 'a', updated_at: '2026-09-07T20:00:00.000Z' }),
    remote({ id: 'b', updated_at: '2026-09-07T21:00:00.000Z' }),
  ]);
  assert.equal(orders.lastRemoteUpdatedAt(), '2026-09-07T21:00:00.000Z');
  h.dispose();
});

test('kasiyerin izinli gecisleri para durumlarina dokunmaz', () => {
  // Kasiyer iade/odeme durumu ATAYAMAZ; yalnizca operasyonel akis.
  assert.deepEqual(CASHIER_TRANSITIONS.PAID, ['PREPARING', 'CANCELLED']);
  assert.deepEqual(CASHIER_TRANSITIONS.PREPARING, ['READY', 'CANCELLED']);
  assert.deepEqual(CASHIER_TRANSITIONS.READY, ['FULFILLED', 'CANCELLED']);
  assert.equal(CASHIER_TRANSITIONS.PENDING_PAYMENT, undefined);
  assert.equal(CASHIER_TRANSITIONS.REFUNDED, undefined);
});

test('bos liste islem yapmaz', () => {
  const h = createHarness();
  const orders = new OnlineOrders(h.app.db);
  assert.deepEqual(orders.upsertMany([]), { created: 0, updated: 0 });
  assert.equal(orders.markSeen([]), 0);
  assert.deepEqual(orders.list([]), []);
  h.dispose();
});
