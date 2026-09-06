-- 002 - Rol ve yetki tohumlamasi
--
-- INSAN kullanicilar ile POS TERMINALLERI ayri rol kumelerindedir:
-- bir kasa cihazi, insan yoneticinin yapabildigi her seyi yapamaz.

INSERT INTO permissions (code, description) VALUES
  ('catalog.read',      'Urun, fiyat, kategori okuma'),
  ('catalog.write',     'Urun/kategori olusturma ve guncelleme'),
  ('price.write',       'Fiyat degistirme'),
  ('inventory.read',    'Stok okuma'),
  ('inventory.write',   'Stok duzeltme, sayim, mal kabul'),
  ('inventory.reserve', 'Stok rezervasyonu (online siparis)'),
  ('sales.read',        'Satis okuma'),
  ('sales.write',       'Satis kaydi olusturma (senkronizasyon)'),
  ('refund.write',      'Iade kaydi olusturma'),
  ('cash.read',         'Kasa oturumu okuma'),
  ('cash.write',        'Kasa oturumu kaydi'),
  ('reports.read',      'Rapor goruntuleme'),
  ('orders.read',       'Siparis okuma'),
  ('orders.write',      'Siparis olusturma/guncelleme'),
  ('users.manage',      'Kullanici ve yetki yonetimi'),
  ('devices.manage',    'Terminal kaydi, aktivasyon, iptal'),
  ('org.manage',        'Organizasyon ve magaza yonetimi'),
  ('audit.read',        'Denetim kaydi okuma'),
  ('sync.push',         'Cihazdan olay gonderme'),
  ('sync.pull',         'Cihaza merkezi veri cekme')
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (code, name, actor_kind, description) VALUES
  ('owner',    'Isletme Sahibi', 'USER',     'Tum yetkiler'),
  ('admin',    'Yonetici',       'USER',     'Isletme yonetimi'),
  ('manager',  'Magaza Muduru',  'USER',     'Magaza operasyonu'),
  ('cashier',  'Kasiyer',        'USER',     'Satis ve sinirli okuma'),
  ('terminal', 'POS Terminali',  'TERMINAL', 'Yalnizca senkronizasyon yetkileri'),
  ('service',  'Servis Istemcisi','SERVICE', 'Gelecekteki e-ticaret/entegrasyon istemcisi')
ON CONFLICT (code) DO NOTHING;

-- owner: her sey
INSERT INTO role_permissions (role_code, permission_code)
  SELECT 'owner', code FROM permissions ON CONFLICT DO NOTHING;

-- admin: organizasyon yonetimi haric her sey
INSERT INTO role_permissions (role_code, permission_code)
  SELECT 'admin', code FROM permissions WHERE code <> 'org.manage' ON CONFLICT DO NOTHING;

-- manager: magaza operasyonu
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager','catalog.read'), ('manager','catalog.write'), ('manager','price.write'),
  ('manager','inventory.read'), ('manager','inventory.write'),
  ('manager','sales.read'), ('manager','refund.write'),
  ('manager','cash.read'), ('manager','cash.write'),
  ('manager','reports.read'), ('manager','orders.read'), ('manager','audit.read')
ON CONFLICT DO NOTHING;

-- cashier: yalnizca okuma agirlikli
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('cashier','catalog.read'), ('cashier','inventory.read'),
  ('cashier','sales.read'), ('cashier','cash.read'), ('cashier','reports.read')
ON CONFLICT DO NOTHING;

-- terminal: YALNIZCA senkronizasyon. Yonetim uc noktalarina erisemez.
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('terminal','sync.push'), ('terminal','sync.pull'),
  ('terminal','catalog.read'), ('terminal','sales.write'),
  ('terminal','refund.write'), ('terminal','cash.write')
ON CONFLICT DO NOTHING;

-- service: gelecekteki e-ticaret istemcisi (stok gorme + siparis + rezervasyon)
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('service','catalog.read'), ('service','inventory.read'), ('service','inventory.reserve'),
  ('service','orders.read'), ('service','orders.write')
ON CONFLICT DO NOTHING;
