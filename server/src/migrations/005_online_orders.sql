-- 005 - Online siparislerin KASADAN takibi
--
-- E-ticaret siparisi odendiginde merkezi sisteme yazilir; kasa bunu kendi
-- senkron kanalindan ceker ve ekranda gosterir. Kasiyer durumu (hazirlaniyor,
-- hazir, teslim edildi) kasadan degistirebilir.
--
-- Terminal yalnizca KENDI magazasinin siparislerini gorur; kapsam kontrolu
-- API katmanindadir.
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('terminal', 'orders.read'),
  ('terminal', 'orders.write')
ON CONFLICT DO NOTHING;

-- Dis sistemden (odeme gecidi) gelen siparis IKI KEZ yazilmamali.
-- Gecit ayni bildirimi tekrar gonderse bile tek siparis olusur.
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_external_ref
  ON orders(organization_id, external_ref)
  WHERE external_ref IS NOT NULL;

-- Kasa ekrani "bekleyen siparisler"i sik sorgular.
CREATE INDEX IF NOT EXISTS ix_orders_store_status
  ON orders(store_id, status, created_at DESC);

-- Kasanin en son gordugu siparis zamani: yalnizca yeni olanlar cekilir.
CREATE INDEX IF NOT EXISTS ix_orders_updated
  ON orders(organization_id, updated_at);
