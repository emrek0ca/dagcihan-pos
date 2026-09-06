# Kurulum ve İşletim Kılavuzu (Windows Kasa)

## 1. Gereksinimler

- Windows 10/11 kasa bilgisayarı
- **Node.js 24 veya üzeri** (`node --version` ile doğrulayın)
- Perkon PS5700 (USB, klavye emülasyonu — fabrika varsayılanı)
- Xprinter XP-Q805K (USB veya Ethernet)
- CAS CL3000 (ağ veya seri; PLU yüklemesi CL-Works ile)

Ek bir veritabanı sunucusu, çalışma zamanı kütüphanesi veya derleyici **gerekmez**.

## 2. İlk kurulum

```bat
cd C:\POS
npm install
```

### 2.1 Mağaza bilgilerini gir
`config/pos.config.json` içinde:
- `store.name`, `store.addressLines`, `store.phone`, `store.taxOffice`, `store.taxNumber`
- `terminal.code` / `terminal.name` (birden çok kasa varsa her kasada FARKLI olmalı)
- `sales.receiptSeries` (fiş serisi harfi; her kasa için ayrı seri önerilir)
- `sales.defaultTaxRateBp` (baz puan: %1 → 100, %10 → 1000, %20 → 2000)

### 2.2 Kullanıcıları oluştur
```bat
node src/app/cli.ts user add mudur "Ad Soyad" 4821 MANAGER
node src/app/cli.ts user add kasiyer1 "Ad Soyad" 1234 CASHIER
```
Roller: `CASHIER` (satış, satır silme, limit altı indirim), `MANAGER` (+iptal, iade, gün sonu, fiyat), `ADMIN` (+kullanıcı ve ayar yönetimi).

### 2.3 Ürünleri yükle
CSV sütunları: `kod,ad,birim(EACH|KG),fiyat,kdv,plu,barkod,stok`
```bat
node src/app/cli.ts product import urunler.csv
node src/app/cli.ts product list
```
Tartılı ürünlerde `plu` alanı **terazideki PLU ile aynı** olmalıdır.

### 2.4 Canlıya geçmeden önce test verisini temizle
```bat
node src/app/cli.ts db reset --confirm
```
Bu komut mevcut veriyi `data/backups/` altına arşivler ve sıfırdan başlar.
Sonra 2.2 ve 2.3 adımlarını gerçek verilerle tekrarlayın.

## 3. Yazıcı kurulumu

### 3.1 USB bağlantı (Windows paylaşımı)
1. Yazıcıyı Windows'a kurun.
2. Yazıcı özellikleri → **Paylaşım** → "Bu yazıcıyı paylaş", paylaşım adı: `XPQ805K`
3. Config: `devices.printer.adapter = "WINDOWS_SHARE"`, `share = "\\\\localhost\\XPQ805K"`

### 3.2 Ethernet bağlantı (önerilir — durum sorgusu çalışır)
```json
"printer": { "adapter": "TCP", "tcp": { "host": "192.168.1.100", "port": 9100 } }
```
Bu modda kağıt bitti / kapak açık / çevrimdışı durumları POS ekranında görünür.

### 3.3 Türkçe karakter ayarı (bir kez yapılır)
```bat
node src/app/cli.ts printer codepage
```
Beş aday tek sayfada basılır. Türkçe harflerin **doğru çıktığı** satırın etiketine bakıp
config'e yazın:
```json
"codePage": "CP857:15"     // veya "CP1254:25" — hangisi doğru çıktıysa
```
Sonra doğrulayın: `node src/app/cli.ts printer test`

## 4. Barkod okuyucu

Perkon PS5700 varsayılan olarak klavye gibi çalışır — ek ayar gerekmez
(`devices.scanner.adapter = "HID_WEDGE"`). Okuyucunun barkod sonuna **Enter (CR)**
eklediğinden emin olun (cihaz kılavuzundaki "suffix CR" ayarı).

Seri modda kullanılacaksa:
```json
"scanner": { "adapter": "SERIAL", "serial": { "port": "COM3", "baudRate": 9600 } }
```

## 5. Terazi barkod formatı — **zorunlu ilk adım**

Sistem, CAS CL3000'in barkod formatını tahmin etmez. Tanımlanana kadar tartılı
etiketler **satışa eklenmez** (yanlış fiyat riskine karşı bilinçli tercih).

1. Teraziden bilinen bir ürünü tartıp etiket bastırın (örn. PLU 231, 0,750 kg).
2. Etiketi kasada okutun (veya `node src/app/cli.ts barcode try <barkod>`).
3. Formatı çıkarın — etiketin üstünde yazan gerçek değerleri verin:
   ```bat
   node src/app/cli.ts barcode analyze --code=2100231007507 --kg=0,750 --plu=231
   ```
   Tutar gömülü formatta `--kg` yerine `--tl=89,90` kullanın.
4. Güveni `KESIN` olan adayı etkinleştirin:
   ```bat
   node src/app/cli.ts barcode apply 0
   ```
5. POS'u yeniden başlatın ve doğrulayın:
   ```bat
   node src/app/cli.ts barcode try 2100231007507
   ```

> Birkaç farklı ağırlıkta 5-6 etiket okutmak doğruluğu artırır.
> `node src/app/cli.ts barcode samples` çözümlenemeyen tüm okumaları listeler.

## 6. Terazi PLU senkronizasyonu

Fiyat değişikliğinden sonra teraziyi güncelleyin:
```bat
node src/app/cli.ts scale export
```
`data/scale-export/plu-latest.csv` dosyası üretilir; CL-Works ile teraziye yüklenir.

> Doğrudan ağ üzerinden yükleme (`CAS_TCP`) bilinçli olarak uygulanmamıştır —
> protokol cihaz üzerinde doğrulanmadan teraziye yanlış fiyat yazma riski vardır.

## 7. Günlük çalıştırma

```bat
npm start
```
Tarayıcı tam ekran açılır (kiosk):
```bat
start msedge --kiosk http://127.0.0.1:7311 --edge-kiosk-type=fullscreen
```

### Açılışta otomatik başlatma
Görev Zamanlayıcı → Yeni Görev:
- Tetikleyici: **Oturum açıldığında**
- Eylem: `C:\Program Files\nodejs\node.exe`, argüman `src\app\main.ts`, başlangıç `C:\POS`
- "Görev başarısız olursa yeniden başlat": 1 dakika, 999 kez

## 8. Kasiyer kullanımı

| Tuş | İşlem |
|---|---|
| — | **Barkod okut** (odak gerekmez, doğrudan sepete düşer) |
| F1 | Ödeme |
| F2 | Ürün ara |
| F3 | Miktar değiştir |
| F4 | İndirim |
| Del | Seçili satırı sil |
| F6 / F7 | Askıya al / askıdakiler |
| F8 | Fiş tekrar bas |
| F9 | Fiş iptal (yönetici onayı) |
| F10 | Kasa (açılış, giriş/çıkış, gün sonu) |

Gün başında **F10 → Kasa Aç** (devir tutarı girilir).
Gün sonunda **F10 → Gün Sonu (Z)** — sayılan nakit girilir, Z raporu basılır.

## 9. Sorun giderme

| Belirti | Yapılacak |
|---|---|
| Fiş basılmıyor, üstte "Yazıcı: N bekliyor" | Yazıcıyı kontrol edin; düzelince kuyruk otomatik basar. Elle: `printer retry` |
| "Terazi barkod formatı tanımlı değil" | Bölüm 5'i uygulayın |
| Türkçe harfler bozuk çıkıyor | Bölüm 3.3'ü uygulayın |
| Barkod okutulunca hiçbir şey olmuyor | Okuyucunun sonuna Enter eklediğini doğrulayın; ekranda bir metin kutusu açık olmamalı |
| Program çöktü / elektrik kesildi | Yeniden başlatın; **açık fiş kaldığı yerden gelir**, kasiyer tekrar PIN girer |
| Stok tutmuyor | `inventory verify` → tutarsızlık varsa `inventory rebuild` |
| Kayıt bütünlüğü şüphesi | `audit verify` (denetim zinciri) ve `db check` |

## 10. Yedekleme

```bat
node src/app/cli.ts db backup
```
`data/backups/` altına tutarlı bir kopya alır. Günde en az bir kez (tercihen gün sonundan
sonra) çalıştırılacak şekilde Görev Zamanlayıcı'ya ekleyin ve klasörü harici bir diske
kopyalayın.

**Yedeklenmesi gerekenler:** `data/pos.db` ve `config/` klasörünün tamamı.
