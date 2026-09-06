-- =====================================================================
-- 001 - Baslangic semasi
-- Kurallar:
--  * Tum para alanlari INTEGER kurus (floating point yok)
--  * Tum miktar alanlari INTEGER milli-birim (olcek 1000)
--  * Tum zaman alanlari INTEGER epoch milisaniye (UTC)
--  * Denetim tablolari append-only'dir; UPDATE/DELETE trigger ile engellenir
-- =====================================================================

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE sequences (
  name        TEXT PRIMARY KEY,
  value       INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ------------------------------ Kullanicilar ------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  pin_salt      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('CASHIER','MANAGER','ADMIN')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE terminals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  INTEGER NOT NULL
) STRICT;

-- ------------------------------ Urunler ------------------------------
CREATE TABLE products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,          -- dahili urun kodu
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL CHECK (unit IN ('EACH','KG')),
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),   -- kurus (KG ise TL/kg)
  tax_rate_bp   INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 10000),
  track_stock   INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0,1)),
  stock_qty     INTEGER NOT NULL DEFAULT 0,    -- milli-birim
  min_price     INTEGER,                       -- tartili barkod akil kontrolu (kurus)
  max_price     INTEGER,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
) STRICT;

CREATE INDEX ix_products_name ON products(name);
CREATE INDEX ix_products_active ON products(active) WHERE deleted_at IS NULL;

-- Terazi PLU eslesmeleri (bir urunun birden fazla PLU'su olabilir)
CREATE TABLE product_plus (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  plu         INTEGER NOT NULL UNIQUE CHECK (plu >= 0),
  scale_dept  INTEGER NOT NULL DEFAULT 1,      -- CL3000 departman/bolum no
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_product_plus_product ON product_plus(product_id);

-- Duz barkodlar (EAN13/EAN8/UPC/Code128/dahili)
CREATE TABLE product_barcodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode     TEXT NOT NULL UNIQUE,
  symbology   TEXT NOT NULL DEFAULT 'UNKNOWN',
  pack_size   INTEGER NOT NULL DEFAULT 1000,   -- bu barkod kac milli-birim (koli barkodu icin)
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_product_barcodes_product ON product_barcodes(product_id);

CREATE TABLE product_price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_price   INTEGER NOT NULL,
  new_price   INTEGER NOT NULL,
  changed_by  INTEGER REFERENCES users(id),
  reason      TEXT,
  at          INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_price_history_product ON product_price_history(product_id, at);

-- ------------------------------ Kasa oturumu ------------------------------
CREATE TABLE cash_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id    INTEGER NOT NULL REFERENCES terminals(id),
  status         TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  business_date  TEXT NOT NULL,                 -- YYYY-MM-DD (yerel is gunu)
  opened_by      INTEGER NOT NULL REFERENCES users(id),
  opened_at      INTEGER NOT NULL,
  opening_float  INTEGER NOT NULL DEFAULT 0,
  closed_by      INTEGER REFERENCES users(id),
  closed_at      INTEGER,
  counted_cash   INTEGER,
  expected_cash  INTEGER,
  variance       INTEGER,
  note           TEXT
) STRICT;

CREATE UNIQUE INDEX ux_cash_sessions_open ON cash_sessions(terminal_id) WHERE status = 'OPEN';
CREATE INDEX ix_cash_sessions_date ON cash_sessions(business_date);

-- ------------------------------ Satislar ------------------------------
CREATE TABLE sales (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  uid                 TEXT NOT NULL UNIQUE,     -- surecler arasi kararli kimlik
  doc_type            TEXT NOT NULL CHECK (doc_type IN ('SALE','REFUND')),
  status              TEXT NOT NULL CHECK (status IN ('OPEN','PARKED','COMPLETED','VOIDED')),
  terminal_id         INTEGER NOT NULL REFERENCES terminals(id),
  user_id             INTEGER NOT NULL REFERENCES users(id),
  cash_session_id     INTEGER REFERENCES cash_sessions(id),
  original_sale_id    INTEGER REFERENCES sales(id),
  receipt_series      TEXT,
  receipt_no          INTEGER,
  business_date       TEXT,
  opened_at           INTEGER NOT NULL,
  completed_at        INTEGER,
  voided_at           INTEGER,
  voided_by           INTEGER REFERENCES users(id),
  void_reason         TEXT,
  -- hesaplanan tutarlar (tamamlanmada dondurulur)
  subtotal            INTEGER NOT NULL DEFAULT 0,
  discount_type       TEXT CHECK (discount_type IN ('PERCENT','AMOUNT')),
  discount_value      INTEGER,
  discount_total      INTEGER NOT NULL DEFAULT 0,
  rounding_adjustment INTEGER NOT NULL DEFAULT 0,
  total               INTEGER NOT NULL DEFAULT 0,
  tax_total           INTEGER NOT NULL DEFAULT 0,
  paid_total          INTEGER NOT NULL DEFAULT 0,
  change_due          INTEGER NOT NULL DEFAULT 0,
  item_count          INTEGER NOT NULL DEFAULT 0,
  discount_reason     TEXT,
  discount_approved_by INTEGER REFERENCES users(id),
  note                TEXT
) STRICT;

-- Bir terminalde ayni anda en fazla bir acik satis
CREATE UNIQUE INDEX ux_sales_open_per_terminal ON sales(terminal_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX ux_sales_receipt ON sales(receipt_series, receipt_no)
  WHERE receipt_no IS NOT NULL;
CREATE INDEX ix_sales_status ON sales(status);
CREATE INDEX ix_sales_business_date ON sales(business_date, doc_type);
CREATE INDEX ix_sales_session ON sales(cash_session_id);
CREATE INDEX ix_sales_original ON sales(original_sale_id) WHERE original_sale_id IS NOT NULL;
CREATE INDEX ix_sales_completed_at ON sales(completed_at);

CREATE TABLE sale_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id          INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  line_no          INTEGER NOT NULL,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  -- satis anindaki kopya (snapshot) - urun sonradan degisse de fis degismez
  name_snapshot    TEXT NOT NULL,
  unit             TEXT NOT NULL CHECK (unit IN ('EACH','KG')),
  quantity         INTEGER NOT NULL,            -- milli-birim
  unit_price       INTEGER NOT NULL,            -- kurus
  gross_amount     INTEGER NOT NULL,
  discount_type    TEXT CHECK (discount_type IN ('PERCENT','AMOUNT')),
  discount_value   INTEGER,
  discount_amount  INTEGER NOT NULL DEFAULT 0,
  sale_discount_share INTEGER NOT NULL DEFAULT 0, -- fis indiriminden bu satira dusen pay
  net_amount       INTEGER NOT NULL,
  tax_rate_bp      INTEGER NOT NULL DEFAULT 0,
  tax_amount       INTEGER NOT NULL DEFAULT 0,
  price_source     TEXT NOT NULL CHECK (price_source IN
                     ('PRODUCT','BARCODE_WEIGHT','BARCODE_PRICE','MANUAL_OVERRIDE','REFUND_ORIGINAL')),
  scan_source      TEXT NOT NULL DEFAULT 'MANUAL' CHECK (scan_source IN
                     ('SCAN_PLAIN','SCAN_WEIGHTED','MANUAL','PLU','SEARCH','REFUND')),
  raw_barcode      TEXT,
  barcode_rule_id  TEXT,
  original_item_id INTEGER REFERENCES sale_items(id),
  voided_at        INTEGER,
  voided_by        INTEGER REFERENCES users(id),
  void_reason      TEXT,
  created_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_sale_items_sale ON sale_items(sale_id);
CREATE INDEX ix_sale_items_product ON sale_items(product_id);
CREATE UNIQUE INDEX ux_sale_items_line ON sale_items(sale_id, line_no);
CREATE INDEX ix_sale_items_original ON sale_items(original_item_id)
  WHERE original_item_id IS NOT NULL;

CREATE TABLE payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('CASH','CARD')),
  amount        INTEGER NOT NULL,               -- satisa sayilan tutar
  tendered      INTEGER NOT NULL,               -- musterinin verdigi
  change_given  INTEGER NOT NULL DEFAULT 0,
  reference     TEXT,                           -- kart onay kodu vb.
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_payments_sale ON payments(sale_id);

-- ------------------------------ Stok ------------------------------
CREATE TABLE stock_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  type           TEXT NOT NULL CHECK (type IN
                   ('SALE','RETURN','PURCHASE','ADJUSTMENT','WASTE','COUNT','OPENING')),
  quantity_delta INTEGER NOT NULL,              -- milli-birim (satista negatif)
  balance_after  INTEGER NOT NULL,
  sale_id        INTEGER REFERENCES sales(id),
  sale_item_id   INTEGER REFERENCES sale_items(id),
  user_id        INTEGER REFERENCES users(id),
  note           TEXT,
  at             INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_stock_movements_product ON stock_movements(product_id, at);
CREATE INDEX ix_stock_movements_sale ON stock_movements(sale_id);

-- ------------------------------ Kasa hareketleri ------------------------------
CREATE TABLE cash_movements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  cash_session_id  INTEGER NOT NULL REFERENCES cash_sessions(id),
  type             TEXT NOT NULL CHECK (type IN
                     ('OPENING','SALE','REFUND','PAID_IN','PAID_OUT','CLOSING')),
  amount           INTEGER NOT NULL,            -- kasaya giris +, cikis -
  sale_id          INTEGER REFERENCES sales(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  note             TEXT,
  at               INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_cash_movements_session ON cash_movements(cash_session_id, at);

-- ------------------------------ Yazdirma kuyrugu ------------------------------
CREATE TABLE print_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (kind IN
                     ('RECEIPT','REPRINT','X_REPORT','Z_REPORT','TEST','CASH_DRAWER')),
  sale_id          INTEGER REFERENCES sales(id),
  document_json    TEXT NOT NULL,               -- yeniden uretilebilir belge
  payload          BLOB,                        -- onceden kodlanmis ESC/POS (opsiyonel)
  status           TEXT NOT NULL CHECK (status IN ('PENDING','PRINTING','DONE','FAILED')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  requested_by     INTEGER REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  printed_at       INTEGER
) STRICT;

CREATE INDEX ix_print_jobs_pending ON print_jobs(status, next_attempt_at);
CREATE INDEX ix_print_jobs_sale ON print_jobs(sale_id);

-- ------------------------------ Idempotency ------------------------------
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','DONE')),
  response_json TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
) STRICT;

CREATE INDEX ix_idempotency_created ON idempotency_keys(created_at);

-- ------------------------------ Denetim (append-only) ------------------------------
CREATE TABLE sale_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data_json  TEXT NOT NULL DEFAULT '{}',
  user_id    INTEGER REFERENCES users(id),
  at         INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_sale_events_seq ON sale_events(sale_id, seq);

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  terminal_id  INTEGER REFERENCES terminals(id),
  type         TEXT NOT NULL,
  entity       TEXT,
  entity_id    TEXT,
  data_json    TEXT NOT NULL DEFAULT '{}',
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
) STRICT;

CREATE INDEX ix_audit_at ON audit_events(at);
CREATE INDEX ix_audit_type ON audit_events(type, at);

-- Denetim kayitlari degistirilemez / silinemez
CREATE TRIGGER trg_audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events append-only'); END;
CREATE TRIGGER trg_audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events append-only'); END;
CREATE TRIGGER trg_sale_events_no_update BEFORE UPDATE ON sale_events
BEGIN SELECT RAISE(ABORT, 'sale_events append-only'); END;

-- Tamamlanmis/iptal edilmis satis degistirilemez
CREATE TRIGGER trg_sales_immutable BEFORE UPDATE ON sales
WHEN OLD.status IN ('COMPLETED','VOIDED') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'Tamamlanmis veya iptal edilmis satis degistirilemez'); END;

CREATE TRIGGER trg_sale_items_immutable BEFORE UPDATE ON sale_items
WHEN (SELECT status FROM sales WHERE id = OLD.sale_id) IN ('COMPLETED','VOIDED')
BEGIN SELECT RAISE(ABORT, 'Kapali satisin satiri degistirilemez'); END;

CREATE TRIGGER trg_sale_items_no_delete_closed BEFORE DELETE ON sale_items
WHEN (SELECT status FROM sales WHERE id = OLD.sale_id) IN ('COMPLETED','VOIDED')
BEGIN SELECT RAISE(ABORT, 'Kapali satisin satiri silinemez'); END;

-- ------------------------------ Barkod teshis ------------------------------
CREATE TABLE scan_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw          TEXT NOT NULL,
  raw_length   INTEGER NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('PLAIN','WEIGHTED','UNKNOWN','INVALID')),
  rule_id      TEXT,
  product_id   INTEGER REFERENCES products(id),
  sale_id      INTEGER REFERENCES sales(id),
  terminal_id  INTEGER REFERENCES terminals(id),
  user_id      INTEGER REFERENCES users(id),
  detail_json  TEXT,
  at           INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_scan_log_at ON scan_log(at);
CREATE INDEX ix_scan_log_result ON scan_log(result, at);
CREATE INDEX ix_scan_log_raw ON scan_log(raw);
