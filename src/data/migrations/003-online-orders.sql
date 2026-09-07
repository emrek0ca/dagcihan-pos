-- 003 - Web sitesinden gelen siparislerin kasada gorunmesi
--
-- Bu tablo YEREL BIR AYNADIR: kaynak merkezi sistemdir. Kasa siparisi
-- burada saklar ki internet kesilse bile ekranda kalsin ve kasiyer
-- neyi hazirlayacagini gorebilsin.
--
-- Durum degisikligi merkeze YAZILIR (kasa tek basina karar vermez);
-- basarili yanit alinmadan yerel durum degistirilmez.
CREATE TABLE IF NOT EXISTS online_orders (
  id             TEXT PRIMARY KEY,          -- merkezi siparis kimligi (uuid)
  order_no       TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'ONLINE',
  status         TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'TRY',
  subtotal       INTEGER NOT NULL DEFAULT 0,   -- kurus
  shipping_total INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  address_json   TEXT NOT NULL DEFAULT '{}',
  notes          TEXT NOT NULL DEFAULT '',
  lines_json     TEXT NOT NULL DEFAULT '[]',
  external_ref   TEXT NOT NULL DEFAULT '',
  placed_at      TEXT,
  remote_updated_at TEXT NOT NULL,
  -- Kasiyer bu siparisi ekranda gordu mu? Yeni siparis uyarisi bunun uzerinden calisir.
  seen_at        TEXT,
  printed_at     TEXT,
  synced_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_online_orders_status ON online_orders(status, placed_at DESC);
CREATE INDEX IF NOT EXISTS ix_online_orders_unseen ON online_orders(seen_at) WHERE seen_at IS NULL;
