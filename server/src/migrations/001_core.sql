-- =====================================================================
--  001 - Merkezi POS control-plane cekirdek semasi
--
--  Kurallar (yerel POS ile AYNI):
--    * Para       : BIGINT kurus (TRY minor unit). ASLA float/double.
--    * Miktar     : BIGINT milli-birim (1 g cozunurluk). ASLA float/double.
--    * Zaman      : timestamptz (UTC saklanir).
--    * Stok       : inventory_ledger ANA KAYITTIR; bakiye ondan turetilir.
--    * Denetim    : audit_log append-only (trigger ile korunur).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------------ tenancy
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  currency    text NOT NULL DEFAULT 'TRY',
  timezone    text NOT NULL DEFAULT 'Europe/Istanbul',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code             text NOT NULL,
  name             text NOT NULL,
  address          text,
  phone            text,
  tax_office       text,
  tax_number       text,
  timezone         text NOT NULL DEFAULT 'Europe/Istanbul',
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE terminals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  code              text NOT NULL,
  name              text NOT NULL,
  activation_state  text NOT NULL DEFAULT 'PENDING'
                      CHECK (activation_state IN ('PENDING','ACTIVE','REVOKED')),
  activated_at      timestamptz,
  revoked_at        timestamptz,
  revoked_reason    text,
  last_seen_at      timestamptz,
  app_version       text,
  os_info           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);
CREATE INDEX ix_terminals_store ON terminals(store_id);

-- Cihaz tokenlari ASLA duz metin saklanmaz; yalnizca SHA-256 ozeti tutulur.
CREATE TABLE terminal_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id   uuid NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  token_prefix  text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
CREATE INDEX ix_terminal_tokens_terminal ON terminal_tokens(terminal_id);

-- Tek kullanimlik cihaz kayit kodu (magazada POS kurulurken girilir)
CREATE TABLE enrollment_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code_hash    text NOT NULL UNIQUE,
  code_prefix  text NOT NULL,
  terminal_code text,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by      uuid REFERENCES terminals(id),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ kimlik / yetki
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email            text NOT NULL,
  display_name     text NOT NULL,
  password_hash    text NOT NULL,
  password_salt    text NOT NULL,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE roles (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  actor_kind  text NOT NULL DEFAULT 'USER' CHECK (actor_kind IN ('USER','TERMINAL','SERVICE')),
  description text
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

-- store_id NULL => organizasyon genelinde yetkili
CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code  text NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  store_id   uuid REFERENCES stores(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_code, store_id)
);
CREATE INDEX ix_user_roles_user ON user_roles(user_id);

CREATE TABLE user_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip          inet,
  user_agent  text
);
CREATE INDEX ix_user_sessions_user ON user_sessions(user_id);

-- Kasada calisan kasiyerler (POS'taki yerel kullanicilarin merkezi karsiligi)
CREATE TABLE cashiers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_user_id  integer,
  username       text NOT NULL,
  display_name   text NOT NULL,
  role_code      text NOT NULL DEFAULT 'cashier' REFERENCES roles(code),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, username)
);

-- ------------------------------------------------------------------ katalog
CREATE TABLE categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES categories(id) ON DELETE SET NULL,
  code             text NOT NULL,
  name             text NOT NULL,
  sort_order       integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE tax_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code             text NOT NULL,
  name             text NOT NULL,
  rate_bp          integer NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
  active           boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, code)
);

CREATE TABLE products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code             text NOT NULL,
  name             text NOT NULL,
  unit             text NOT NULL CHECK (unit IN ('EACH','KG')),
  category_id      uuid REFERENCES categories(id) ON DELETE SET NULL,
  tax_rate_id      uuid REFERENCES tax_rates(id) ON DELETE SET NULL,
  tax_rate_bp      integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  track_stock      boolean NOT NULL DEFAULT true,
  min_price        bigint,
  max_price        bigint,
  active           boolean NOT NULL DEFAULT true,
  version          bigint NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, code),
  -- Alt tablolarin organizasyonu FK ile dogrulayabilmesi icin bilesik benzersizlik
  UNIQUE (id, organization_id)
);
CREATE INDEX ix_products_org_active ON products(organization_id, active) WHERE deleted_at IS NULL;
CREATE INDEX ix_products_updated ON products(updated_at);

CREATE TABLE product_barcodes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL,
  -- Organizasyon, urunle BIRLIKTE dogrulanir: barkodun sahibi urunle ayni
  -- organizasyonda olmak ZORUNDADIR (bilesik FK). Boylece asagidaki benzersizlik
  -- kurali alt sorgu gerektirmeden veritabani seviyesinde uygulanabilir.
  organization_id uuid NOT NULL,
  barcode        text NOT NULL,
  symbology      text NOT NULL DEFAULT 'UNKNOWN',
  pack_size_milli bigint NOT NULL DEFAULT 1000 CHECK (pack_size_milli > 0),
  is_primary     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, barcode),
  -- Ayni organizasyonda bir barkod yalnizca TEK urune ait olabilir
  UNIQUE (organization_id, barcode),
  FOREIGN KEY (product_id, organization_id)
    REFERENCES products(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE product_plus (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id       uuid REFERENCES stores(id) ON DELETE CASCADE,
  plu            integer NOT NULL CHECK (plu >= 0),
  scale_department integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_plu_scope ON product_plus(COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid), plu);
CREATE INDEX ix_product_plus_product ON product_plus(product_id);

-- Fiyat listesi: store_id NULL => organizasyon varsayilani
CREATE TABLE prices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id     uuid REFERENCES stores(id) ON DELETE CASCADE,
  unit_price   bigint NOT NULL CHECK (unit_price >= 0),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid
);
CREATE UNIQUE INDEX ux_price_current ON prices(product_id, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE valid_to IS NULL;
CREATE INDEX ix_prices_product ON prices(product_id);

CREATE TABLE price_history (
  id          bigserial PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id    uuid REFERENCES stores(id) ON DELETE CASCADE,
  old_price   bigint,
  new_price   bigint NOT NULL,
  reason      text,
  source      text NOT NULL DEFAULT 'CENTRAL' CHECK (source IN ('CENTRAL','POS','IMPORT')),
  changed_by  uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_price_history_product ON price_history(product_id, changed_at DESC);

-- ------------------------------------------------------------------ stok
CREATE TABLE inventory_locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'STORE' CHECK (kind IN ('STORE','WAREHOUSE','ONLINE')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);

-- ANA KAYIT. Append-only. Bakiye buradan turetilir.
CREATE TABLE inventory_ledger (
  id             bigserial PRIMARY KEY,
  location_id    uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  movement_type  text NOT NULL CHECK (movement_type IN
                   ('PURCHASE','SALE','REFUND','ADJUSTMENT','WASTE','COUNT','OPENING',
                    'RESERVATION','RELEASE','TRANSFER_IN','TRANSFER_OUT')),
  quantity_delta bigint NOT NULL,
  reference_type text,
  reference_id   text,
  terminal_id    uuid REFERENCES terminals(id),
  event_id       uuid,
  note           text,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ledger_product ON inventory_ledger(location_id, product_id, occurred_at);
CREATE INDEX ix_ledger_reference ON inventory_ledger(reference_type, reference_id);
-- Ayni sync event'i iki kez ledger'a yazilamaz
CREATE UNIQUE INDEX ux_ledger_event_line ON inventory_ledger(event_id, product_id, movement_type)
  WHERE event_id IS NOT NULL;

CREATE TABLE inventory_balances (
  location_id  uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  on_hand      bigint NOT NULL DEFAULT 0,
  reserved     bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, product_id)
);

CREATE TABLE stock_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity     bigint NOT NULL CHECK (quantity > 0),
  order_id     uuid,
  status       text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','RELEASED','CONSUMED','EXPIRED')),
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX ix_reservations_active ON stock_reservations(location_id, product_id)
  WHERE status = 'ACTIVE';

-- ------------------------------------------------------------------ satis
CREATE TABLE sales (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  store_id            uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  terminal_id         uuid REFERENCES terminals(id),
  source              text NOT NULL DEFAULT 'POS' CHECK (source IN ('POS','ONLINE','MANUAL')),
  -- Terminaldeki yerel fis kimligi: ayni satis iki kez yazilamaz
  local_uid           text,
  doc_type            text NOT NULL CHECK (doc_type IN ('SALE','REFUND')),
  status              text NOT NULL CHECK (status IN ('COMPLETED','VOIDED')),
  receipt_series      text,
  receipt_no          integer,
  business_date       date,
  cashier_id          uuid REFERENCES cashiers(id),
  cashier_name        text,
  -- Kasa oturumu olayi satistan SONRA gelebilir; bag sonradan kurulur
  cash_session_id     uuid,
  local_cash_session_id integer,
  original_sale_id    uuid REFERENCES sales(id),
  currency            text NOT NULL DEFAULT 'TRY',
  subtotal            bigint NOT NULL DEFAULT 0,
  discount_total      bigint NOT NULL DEFAULT 0,
  rounding_adjustment bigint NOT NULL DEFAULT 0,
  total               bigint NOT NULL DEFAULT 0,
  tax_total           bigint NOT NULL DEFAULT 0,
  paid_total          bigint NOT NULL DEFAULT 0,
  change_due          bigint NOT NULL DEFAULT 0,
  item_count          integer NOT NULL DEFAULT 0,
  opened_at           timestamptz,
  completed_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_sales_terminal_local ON sales(terminal_id, local_uid)
  WHERE terminal_id IS NOT NULL AND local_uid IS NOT NULL;
CREATE UNIQUE INDEX ux_sales_receipt ON sales(store_id, receipt_series, receipt_no)
  WHERE receipt_no IS NOT NULL;
CREATE INDEX ix_sales_store_date ON sales(store_id, business_date, doc_type);
CREATE INDEX ix_sales_completed ON sales(completed_at DESC);

CREATE TABLE sale_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id             uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  line_no             integer NOT NULL,
  product_id          uuid REFERENCES products(id),
  product_code        text,
  name_snapshot       text NOT NULL,
  unit                text NOT NULL CHECK (unit IN ('EACH','KG')),
  quantity            bigint NOT NULL,
  unit_price          bigint NOT NULL,
  gross_amount        bigint NOT NULL,
  discount_amount     bigint NOT NULL DEFAULT 0,
  sale_discount_share bigint NOT NULL DEFAULT 0,
  net_amount          bigint NOT NULL,
  tax_rate_bp         integer NOT NULL DEFAULT 0,
  tax_amount          bigint NOT NULL DEFAULT 0,
  price_source        text,
  scan_source         text,
  raw_barcode         text,
  original_line_id    uuid REFERENCES sale_lines(id),
  UNIQUE (sale_id, line_no)
);
CREATE INDEX ix_sale_lines_product ON sale_lines(product_id);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method       text NOT NULL CHECK (method IN ('CASH','CARD','VOUCHER','ONLINE')),
  amount       bigint NOT NULL,
  tendered     bigint NOT NULL,
  change_given bigint NOT NULL DEFAULT 0,
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_payments_sale ON payments(sale_id);

CREATE TABLE sale_discounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_line_id uuid REFERENCES sale_lines(id) ON DELETE CASCADE,
  scope        text NOT NULL CHECK (scope IN ('LINE','SALE')),
  type         text NOT NULL CHECK (type IN ('PERCENT','AMOUNT')),
  value        bigint NOT NULL,
  amount       bigint NOT NULL,
  reason       text,
  approved_by  text
);

CREATE TABLE refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_sale_id    uuid NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  original_sale_id  uuid REFERENCES sales(id),
  reason            text,
  approved_by       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('RECEIPT','REPRINT','X_REPORT','Z_REPORT')),
  copy_no     integer NOT NULL DEFAULT 1,
  printed_at  timestamptz,
  payload_hash text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ kasa
CREATE TABLE cash_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  terminal_id    uuid REFERENCES terminals(id),
  local_id       integer,
  business_date  date NOT NULL,
  status         text NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_by      text,
  opened_at      timestamptz NOT NULL,
  opening_float  bigint NOT NULL DEFAULT 0,
  closed_by      text,
  closed_at      timestamptz,
  counted_cash   bigint,
  expected_cash  bigint,
  variance       bigint,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_cash_sessions_terminal_local ON cash_sessions(terminal_id, local_id)
  WHERE terminal_id IS NOT NULL AND local_id IS NOT NULL;
CREATE INDEX ix_cash_sessions_store_date ON cash_sessions(store_id, business_date);

CREATE TABLE cash_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_session_id  uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('OPENING','SALE','REFUND','PAID_IN','PAID_OUT','CLOSING')),
  amount           bigint NOT NULL,
  sale_id          uuid REFERENCES sales(id),
  note             text,
  occurred_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_cash_movements_session ON cash_movements(cash_session_id);

-- ------------------------------------------------------------------ musteri (gelecege hazir)
-- Satis <-> kasa oturumu bagi (cash_sessions bu noktadan sonra tanimlandigi icin ALTER)
ALTER TABLE sales
  ADD CONSTRAINT fk_sales_cash_session
  FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE SET NULL;
CREATE INDEX ix_sales_cash_session ON sales(cash_session_id);
CREATE INDEX ix_sales_local_session ON sales(terminal_id, local_cash_session_id)
  WHERE local_cash_session_id IS NOT NULL;

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code             text,
  full_name        text NOT NULL,
  phone            text,
  email            text,
  tax_office       text,
  tax_number       text,
  address          jsonb NOT NULL DEFAULT '{}'::jsonb,
  loyalty_points   bigint NOT NULL DEFAULT 0,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX ix_customers_phone ON customers(organization_id, phone);

-- ------------------------------------------------------------------ siparis (gelecek online kanal)
CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  store_id         uuid REFERENCES stores(id),
  customer_id      uuid REFERENCES customers(id),
  channel          text NOT NULL DEFAULT 'ONLINE' CHECK (channel IN ('ONLINE','PHONE','MARKETPLACE')),
  order_no         text,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                     ('DRAFT','PENDING_PAYMENT','PAID','PREPARING','READY','FULFILLED','CANCELLED','REFUNDED')),
  currency         text NOT NULL DEFAULT 'TRY',
  subtotal         bigint NOT NULL DEFAULT 0,
  discount_total   bigint NOT NULL DEFAULT 0,
  tax_total        bigint NOT NULL DEFAULT 0,
  shipping_total   bigint NOT NULL DEFAULT 0,
  total            bigint NOT NULL DEFAULT 0,
  external_ref     text,
  notes            text,
  placed_at        timestamptz,
  fulfilled_at     timestamptz,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, order_no)
);
CREATE INDEX ix_orders_status ON orders(organization_id, status);

CREATE TABLE order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no        integer NOT NULL,
  product_id     uuid REFERENCES products(id),
  name_snapshot  text NOT NULL,
  unit           text NOT NULL CHECK (unit IN ('EACH','KG')),
  quantity       bigint NOT NULL CHECK (quantity > 0),
  unit_price     bigint NOT NULL,
  net_amount     bigint NOT NULL,
  tax_rate_bp    integer NOT NULL DEFAULT 0,
  tax_amount     bigint NOT NULL DEFAULT 0,
  reservation_id uuid REFERENCES stock_reservations(id),
  UNIQUE (order_id, line_no)
);

CREATE TABLE order_status_history (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  actor_type  text,
  actor_id    text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_order_status_order ON order_status_history(order_id, changed_at);

-- ------------------------------------------------------------------ senkronizasyon
-- Cihazdan gelen her olay. PK = istemcinin urettigi event_id => IDEMPOTENCY.
CREATE TABLE sync_events (
  event_id       uuid PRIMARY KEY,
  terminal_id    uuid NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  store_id       uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_type     text NOT NULL,
  entity_type    text,
  entity_id      text,
  local_sequence bigint NOT NULL,
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  status         text NOT NULL DEFAULT 'RECEIVED'
                   CHECK (status IN ('RECEIVED','PROCESSED','FAILED','DEAD','IGNORED')),
  attempts       integer NOT NULL DEFAULT 0,
  error          text,
  payload        jsonb NOT NULL,
  result         jsonb
);
CREATE INDEX ix_sync_events_terminal ON sync_events(terminal_id, local_sequence);
CREATE INDEX ix_sync_events_status ON sync_events(status) WHERE status IN ('FAILED','DEAD');

CREATE TABLE device_sync_state (
  terminal_id            uuid PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
  last_local_sequence    bigint NOT NULL DEFAULT 0,
  last_pull_cursor       bigint NOT NULL DEFAULT 0,
  last_push_at           timestamptz,
  last_pull_at           timestamptz,
  pending_reported       integer NOT NULL DEFAULT 0,
  app_version            text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Sunucu -> cihaz artimli cekme icin degisim kaydi (cursor = id)
CREATE TABLE change_log (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id         uuid REFERENCES stores(id) ON DELETE CASCADE,
  entity_type      text NOT NULL,
  entity_id        text NOT NULL,
  operation        text NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
  payload          jsonb NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_change_log_scope ON change_log(organization_id, id);
CREATE INDEX ix_change_log_entity ON change_log(entity_type, entity_id);

CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  scope        text NOT NULL,
  request_hash text NOT NULL,
  response     jsonb,
  status       text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','DONE')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX ix_idempotency_created ON idempotency_keys(created_at);

-- ------------------------------------------------------------------ denetim
CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  store_id         uuid REFERENCES stores(id) ON DELETE SET NULL,
  terminal_id      uuid REFERENCES terminals(id) ON DELETE SET NULL,
  actor_type       text NOT NULL CHECK (actor_type IN ('USER','TERMINAL','SERVICE','SYSTEM')),
  actor_id         text,
  actor_name       text,
  action           text NOT NULL,
  entity_type      text,
  entity_id        text,
  before_state     jsonb,
  after_state      jsonb,
  request_id       text,
  ip               inet,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_org_at ON audit_log(organization_id, at DESC);
CREATE INDEX ix_audit_action ON audit_log(action, at DESC);

-- Denetim kaydi degistirilemez / silinemez
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
