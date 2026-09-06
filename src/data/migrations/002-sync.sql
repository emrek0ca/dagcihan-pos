-- =====================================================================
--  002 - Merkezi sunucu ile senkronizasyon
--
--  ILKE: POS'un calismasi sunucuya BAGLI DEGILDIR. Bu tablolar yalnizca
--  "ne gonderilecek" ve "nereye kadar cekildi" bilgisini tutar. Sunucu
--  erisilemezse satis normal sekilde devam eder, olaylar kuyrukta bekler.
-- =====================================================================

-- Transactional outbox: olay, ISI YAPAN TRANSACTION ICINDE yazilir.
-- Satis commit olduysa olay da kesin olarak kuyruktadir; ikisi ayrilamaz.
CREATE TABLE outbox_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,   -- UUID; yeniden denemelerde DEGISMEZ
  type            TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  sequence        INTEGER NOT NULL,       -- terminal ici monotonik sira
  payload_json    TEXT NOT NULL,
  occurred_at     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','SENT','FAILED','DEAD')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  sent_at         INTEGER,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_outbox_pending ON outbox_events(status, next_attempt_at);
CREATE INDEX ix_outbox_sequence ON outbox_events(sequence);

-- Senkronizasyon durumu (anahtar/deger)
CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Sunucudan cekilen merkezi verinin yerel izi (catisma teshisi ve denetim icin)
CREATE TABLE sync_pull_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor       INTEGER NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  operation    TEXT NOT NULL,
  applied      INTEGER NOT NULL DEFAULT 1 CHECK (applied IN (0,1)),
  detail       TEXT,
  at           INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_pull_log_at ON sync_pull_log(at);

-- Merkezi kimlikler: yerel urun <-> merkezi urun eslesmesi
ALTER TABLE products ADD COLUMN remote_id TEXT;
ALTER TABLE products ADD COLUMN remote_version INTEGER;
ALTER TABLE products ADD COLUMN synced_at INTEGER;
CREATE INDEX ix_products_remote ON products(remote_id);
