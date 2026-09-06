-- 004 - Platform yoneticisi (bayi/saticinin kendisi)
--
-- Gerekce: Sistemi birden fazla MUSTERIYE satiyoruz. Her musteri KENDI
-- organizasyonudur; urun katalogu, fiyatlari, satislari ve stogu digerlerinden
-- tamamen yalitilmistir (products.organization_id, sync bootstrap org bazlidir).
-- Bu yuzden musterileri kuran kisinin organizasyonlar ARASI yetkisi olmalidir.
--
-- Bu bayrak normal RBAC'in YERINE GECMEZ, yanina eklenir: yalnizca
-- /api/v1/platform/* uc noktalarini acar. Musteri kullanicilari bu bayragi
-- almaz ve birbirlerinin verisini goremez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.is_platform_admin IS
  'true ise /api/v1/platform/* uc noktalarini kullanabilir (musteri kurulumu). Varsayilan false.';
