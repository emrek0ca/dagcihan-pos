-- 003 - Terminalin KENDI magazasinin stok bakiyesini okuyabilmesi
--
-- Gerekce: POS, merkezi bakiye ile yerel bakiyeyi karsilastirip FARKI
-- gonderebilsin (mutlak deger gondermek mukerrer dusum yaratir).
-- Terminal yalnizca kendi magazasini gorur; kapsam kontrolu API katmanindadir.
INSERT INTO role_permissions (role_code, permission_code)
VALUES ('terminal', 'inventory.read')
ON CONFLICT DO NOTHING;
