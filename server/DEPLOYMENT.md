# Merkezi POS Platformu — Kurulum ve İşletim

Bu belge VPS üzerindeki merkezi backend'in (control-plane) kurulumunu,
işletimini ve bakımını anlatır. Mağazadaki Windows POS'un kurulumu için
[../docs/05-windows-uygulamasi.md](../docs/05-windows-uygulamasi.md), senkronizasyon
davranışı için [SYNC.md](SYNC.md).

## 1. Sunucudaki yerleşim

| Ne | Nerede |
|---|---|
| Uygulama | `/opt/dagci-pos-platform` (sahibi `dagcipos`) |
| Ayarlar (secret) | `/etc/dagci-pos-platform/.env` (`root:dagcipos`, `0640`) |
| Yedekler | `/opt/dagci-pos-platform/backups` (`0700`, sahibi `dagcipos`) |
| systemd servisi | `dagci-pos-platform.service` |
| Yedek zamanlayıcı | `dagci-pos-backup.timer` (her gün 03:30) |
| nginx | `/etc/nginx/sites-available/pos-api.witlydesign.com` |
| Loglar | `journalctl -u dagci-pos-platform` |

**Sunucuda başka projeler çalışıyor** (elyan-backend Docker Compose, pocketbase,
irix-api, witly-payment-gateway, ollama). Bu kurulum onların hiçbirine dokunmaz:
ayrı sistem kullanıcısı, ayrı klasör, ayrı veritabanı, ayrı port, ayrı nginx bloğu.

## 2. Mimari kararlar (ve gerekçeleri)

- **Mevcut PostgreSQL 16 örneği kullanılır** (port 5433, yalnızca localhost).
  İkinci bir PostgreSQL kurulmadı; veritabanı `dagci_pos`, rolü `dagci_pos`.
- **systemd + `/opt`** deseni seçildi çünkü sunucudaki diğer Node servisleri
  (`witly-payment-gateway`) aynı desende. Docker Compose projesi (`elyan-backend`)
  bozulmasın diye ona hiç dokunulmadı.
- **Backend root ile çalışmaz.** `dagcipos` sistem kullanıcısı, `nologin` kabuk,
  systemd sertleştirmesi (`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`,
  `SystemCallFilter=@system-service`, yazma izni yalnızca `backups/`).
- **Port 8110 dışarıya kapalıdır.** ufw yalnızca 80/443'e izin verir; API'ye tek
  giriş nginx'tir.
- **Migration servisten ayrı çalışır** (`ExecStartPre`). Başarısız migration'da
  servis hiç başlamaz; yarım şema üzerinde çalışan süreç oluşmaz.

## 3. Sıfırdan kurulum

```bash
# 1) Sistem kullanıcısı ve klasörler
useradd --system --home /opt/dagci-pos-platform --shell /usr/sbin/nologin dagcipos
install -d -o dagcipos -g dagcipos -m 0750 /opt/dagci-pos-platform
install -d -o root -g dagcipos -m 0750 /etc/dagci-pos-platform
install -d -o dagcipos -g dagcipos -m 0700 /opt/dagci-pos-platform/backups

# 2) Veritabanı (mevcut PostgreSQL örneğinde)
PASS=$(openssl rand -base64 33 | tr -d '/+=' | head -c 40)
sudo -u postgres psql -p 5433 -c "CREATE ROLE dagci_pos LOGIN PASSWORD '$PASS';"
sudo -u postgres createdb -p 5433 -O dagci_pos dagci_pos

# 3) Kod (yerelde derlenip gönderilir; sunucuda derleyici gerekmez)
#    yerelde:  cd server && npm run build
rsync -az dist/ root@SUNUCU:/opt/dagci-pos-platform/dist/
rsync -az package.json package-lock.json root@SUNUCU:/opt/dagci-pos-platform/
cd /opt/dagci-pos-platform && npm ci --omit=dev
chown -R dagcipos:dagcipos /opt/dagci-pos-platform

# 4) Ayarlar
cp .env.example /etc/dagci-pos-platform/.env   # DATABASE_URL'i $PASS ile doldur
chown root:dagcipos /etc/dagci-pos-platform/.env && chmod 0640 /etc/dagci-pos-platform/.env

# 5) systemd
systemctl daemon-reload
systemctl enable --now dagci-pos-platform.service
curl -s http://127.0.0.1:8110/ready
```

## 4. İlk veri kurulumu

```bash
cd /opt/dagci-pos-platform
run() { sudo -u dagcipos env DATABASE_URL="$DATABASE_URL" node dist/cli.js "$@"; }

run org:create   DAGCIHAN "Dagcihan Kuruyemis"
run store:create DAGCIHAN MERKEZ "Merkez Magaza"
run user:create  DAGCIHAN yonetici@ornek.com "Ad Soyad" 'EN-AZ-12-KARAKTER-PAROLA' owner
run device:create MERKEZ KASA-1 "1 Nolu Kasa"     # tek kullanımlık aktivasyon kodu basar
run status
```

## 5. Yayınlama (nginx + TLS)

Backend `127.0.0.1:8110`'da çalışır ve **doğrudan erişilemez**.

**Durum: yayında.**

- **Public API:** `https://pos-api.witlydesign.com`
- DNS: `pos-api.witlydesign.com` → `A` → `84.247.172.213`
- Sertifika: Let's Encrypt, **2026-12-05**'e kadar geçerli, mevcut `certbot.timer`
  ile otomatik yenilenir
- HTTP (80) → HTTPS (443) kalıcı yönlendirme aktif

Yeniden kurmak gerekirse:
```bash
certbot --nginx -d pos-api.witlydesign.com --agree-tos -m yonetici@ornek.com --redirect
```

Doğrulama:
```bash
curl https://pos-api.witlydesign.com/health   # {"status":"ok",...}
curl https://pos-api.witlydesign.com/ready    # şema sürümü + veritabanı durumu
```

## 6. Güncelleme

```bash
# yerelde
cd server && npm run typecheck && npm test && npm run build
rsync -az --delete dist/ root@SUNUCU:/opt/dagci-pos-platform/dist/
rsync -az package.json package-lock.json root@SUNUCU:/opt/dagci-pos-platform/

# sunucuda
cd /opt/dagci-pos-platform
npm ci --omit=dev            # bağımlılık değiştiyse
chown -R dagcipos:dagcipos dist node_modules
sudo -u dagcipos ./backup.sh # güncelleme öncesi yedek
systemctl restart dagci-pos-platform   # ExecStartPre migration'ları uygular
curl -s http://127.0.0.1:8110/ready
```

Migration başarısız olursa servis başlamaz ve **eski şema bozulmaz**; `journalctl`
hatayı gösterir, düzeltip tekrar `restart` yeterlidir.

## 7. Migration kuralları

- Dosyalar `src/migrations/NNN_ad.sql`, sıralı uygulanır, her biri **tek transaction**.
- Uygulanan migration'ın **checksum'ı** saklanır. Dosya sonradan değiştirilirse
  uygulama açılmaz — bu bilinçlidir: uygulanmış migration düzenlenmez, yenisi eklenir.
- Durum: `node dist/cli.js migrate:status`

### Geri alma / kurtarma
1. `systemctl stop dagci-pos-platform`
2. `./restore.sh backups/<yedek>.dump --confirm` (önce güvenlik yedeği alır)
3. Eski sürüm kodunu `dist/`'e geri koy
4. `systemctl start dagci-pos-platform`

## 8. Yedekleme

| Konu | Değer |
|---|---|
| Betik | `/opt/dagci-pos-platform/backup.sh` |
| Zamanlama | `dagci-pos-backup.timer` — her gün 03:30 (±10 dk), `Persistent=true` |
| Konum | `/opt/dagci-pos-platform/backups/dagci_pos-<UTC>.dump` |
| Biçim | `pg_dump --format=custom` (seçici geri yükleme mümkün) |
| Doğrulama | Her yedekten sonra `pg_restore --list` ile okunabilirlik testi |
| Saklama | 30 gün; `arsiv-` ile başlayanlar **hiç silinmez** |
| İzinler | `0600`, sahibi `dagcipos` |

> Sunucuda tüm projeleri kapsayan **merkezi bir yedekleme sistemi yok**
> (her proje kendi yedeğini alıyor). Bu yüzden yalnızca bu veritabanını
> kapsayan, izole bir yedekleme kuruldu; başka hiçbir yedeğe dokunulmadı.

**Geri yükleme testi yapıldı:** yedek ayrı bir test veritabanına açıldı ve
`sales`, `sale_lines`, `payments`, `inventory_ledger`, `sync_events`,
`cash_sessions`, `products` satır sayıları üretimle birebir eşleşti.

## 9. İzleme

```bash
systemctl status dagci-pos-platform
journalctl -u dagci-pos-platform -f            # yapısal JSON log
journalctl -u dagci-pos-platform -p err -n 50  # yalnızca hatalar
curl -s http://127.0.0.1:8110/ready            # sağlık + şema sürümü
node dist/cli.js status                        # kayıt sayıları, hatalı olaylar
node dist/cli.js device:list                   # terminaller ve son senkron
```

Log alanları: `ts, level, msg, requestId, method, path, status, durationMs,
terminalId/userId`. **Token, parola ve kart bilgisi loglanmaz** (logger
bu alanları maskeler).

## 10. Güvenlik özeti

- Backend `dagcipos` kullanıcısıyla çalışır, root değil
- PostgreSQL yalnızca `127.0.0.1:5433`, internete kapalı
- API portu ufw ile kapalı; tek giriş nginx (80/443)
- Cihaz token'ları ve kullanıcı oturumları veritabanında **yalnızca SHA-256
  özeti** ile saklanır; düz metin bir kez üretilir
- Parolalar scrypt + tuz
- Aktivasyon kodları tek kullanımlık, 24 saat geçerli, özetlenmiş saklanır
- Terminal token'ı yönetim uçlarına **erişemez** (ayrı rol kümesi)
- Her istekte organizasyon/mağaza kapsam kontrolü
- Rate limit, gövde boyutu sınırı, güvenlik başlıkları, parametreli SQL
- `audit_log` append-only (trigger korumalı)

## Bayi konsolu (musteri ve aktivasyon kodu yonetimi)

`console/bayi-konsolu.html` tek dosyalik bir yonetim sayfasidir; masaustunden
cift tiklayarak acilir, sunucuya HTTPS uzerinden baglanir. Kurulum gerektirmez.

**Yetki.** Konsol yalnizca `users.is_platform_admin = true` olan kullanicilara
acilir. Bu bayrak rol/permission sisteminin disindadir; cunku organizasyon
kapsami DISINA cikan tek yetkidir ve bir musteri yoneticisine yanlislikla
verilmemelidir. Vermek icin:

```
node dist/cli.js platform:admin <eposta> true
```

**Veri modeli.** Her musteri KENDI organizasyonudur. Urun katalogu, fiyatlar,
stok ve satislar organizasyon bazinda yalitilmistir, bu yuzden musteriler
birbirinin verisini goremez; kasa token'i da yalnizca kendi magazasini gorur.

**Silme yoktur, arsivleme vardir.** Denetim kaydi append-only oldugu icin
organizasyon silinemez (gecmis satislarin izi kaybolur). Arsivlenen musterinin
kasalari merkeze SENKRONIZE OLAMAZ (`CUSTOMER_INACTIVE`), ancak POS cevrimdisi
calismaya devam eder: magaza satis yapamaz hale GELMEZ, veriler kasada birikir
ve musteri geri acildiginda kayipsiz gonderilir.

**CORS.** Yerel dosyadan acilan sayfa tarayiciya `Origin: null` olarak gorunur,
bu yuzden `CORS_ORIGINS` varsayilani `null`'dir. Baska bir kaynaktan acacaksaniz
(orn. bir ic ag adresi) o kaynagi listeye ekleyin. `Allow-Credentials` hicbir
zaman acilmaz.
