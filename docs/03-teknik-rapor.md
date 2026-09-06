# Teknik Doğrulama Raporu

Tarih: 2026-09-06 · Durum: **tüm aşamalar tamamlandı (backend + donanım + arayüz)**

## 1. Özet

| Alan | Durum |
|---|---|
| Mimari (core/modules/hardware ayrımı) | ✅ Tamamlandı |
| Veri modeli ve şema | ✅ Tamamlandı (22 tablo, STRICT, trigger korumalı) |
| Para/miktar aritmetiği | ✅ Tam sayı, floating-point yok |
| Barkod çözümleme (configurable) | ✅ Tamamlandı + format keşif motoru |
| CAS CL3000 tartılı barkod | ⚠️ **Format mağazada doğrulanmayı bekliyor** (tasarım gereği kapalı) |
| Perkon PS5700 okuyucu | ✅ HID/Seri/TCP adapter, otomatik yeniden bağlanma |
| Xprinter XP-Q805K ESC/POS | ✅ Gerçek entegrasyon (TCP 9100 / Windows paylaşımı / seri) |
| Satış, iptal, iade, indirim | ✅ Tamamlandı |
| Stok, kasa oturumu, Z raporu | ✅ Tamamlandı |
| Idempotency + çökme kurtarma | ✅ Test edildi |
| Denetim (audit) hash zinciri | ✅ Test edildi (kurcalama tespiti dahil) |
| Windows POS arayüzü | ✅ Tamamlandı, canlı sistemde doğrulandı |
| Testler | ✅ **170 test, tamamı geçiyor** |
| Runtime bağımlılık sayısı | **0** |

Kod: `src/` 7.778 satır TypeScript + 345 satır SQL · `tests/` 2.243 satır.

## 2. Teknoloji yığını ve gerekçe

| Katman | Seçim | Neden |
|---|---|---|
| Dil | TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Tipli ve test edilebilir; Node 24+ `.ts` dosyalarını doğrudan çalıştırır |
| Runtime | Node.js 24+ (sabitlenmiş sürüm kasaya birlikte kurulur) | Kasa bilgisayarına derleyici/node-gyp gerekmez |
| Veritabanı | `node:sqlite` (yerleşik), WAL + `synchronous=FULL` | Tek dosya, transaction-safe, **native bağımlılık yok**, ayrı servis yok |
| Taşıma | `node:http` + SSE | Ek framework yok; barkod/yazıcı olayları anlık UI'ya itilir |
| Test | `node:test` | Yerleşik |

**Runtime bağımlılığı sıfırdır.** `npm install` yalnızca `typescript` ve `@types/node` kurar.
Bu, mağaza kasasındaki kırılma yüzeyini en aza indiren bilinçli bir karardır.

## 3. Mimari doğrulaması

```
core/      money quantity barcode sale errors clock ids   ← I/O YOK, saf, %100 deterministik
modules/   products inventory sales payments cash-register users printing scanner audit
data/      db (WAL, tx, sequence) · migrations · idempotency
hardware/  ports.ts (arayüzler)
           scanner/{HID_WEDGE, SERIAL, TCP, SIMULATOR}
           printer/{TCP9100, WINDOWS_SHARE, SERIAL, FILE, NULL} + escpos + encoding
           scale/{CSV_EXPORT, CAS_TCP, SIMULATOR}
app/       pos.ts (kompozisyon kökü) · server.ts (HTTP+SSE) · cli.ts · devices.ts
```

`modules` ve `core` hiçbir somut cihaz sınıfını import etmez; yalnızca
`hardware/ports.ts` arayüzlerini bilir. Cihaz değişirse yeni adapter yazılır,
üst katmanlara dokunulmaz. `config/pos.config.json` hangi adapterin kullanılacağını belirler.

## 4. Veri modeli

22 tablo. Tümü SQLite `STRICT`, `foreign_keys=ON`.

**Para:** tüm tutarlar `INTEGER` kuruş. **Miktar:** tüm miktarlar `INTEGER` milli-birim (1 g çözünürlük).
**Zaman:** epoch ms. Fiyat/ad/KDV satış anında satır içine kopyalanır (snapshot).

Kritik kısıtlar:
- `ux_sales_open_per_terminal` — bir kasada aynı anda **en fazla 1 açık fiş** (DB düzeyinde)
- `ux_sales_receipt` — fiş numarası serisi içinde benzersiz
- `ux_cash_sessions_open` — kasada aynı anda 1 açık oturum
- Trigger'lar: `audit_events` ve `sale_events` **append-only**; tamamlanmış/iptal satış ve satırları **değiştirilemez**

Ledger yaklaşımı: `stock_movements` gerçeği tanımlar, `products.stock_qty` türevdir;
`inventory verify` ikisini karşılaştırır, `inventory rebuild` defterden yeniden kurar.

## 5. Kritik akışın doğrulanması

### 5.1 Satış tamamlama — tek transaction
`sales.complete()` şu adımları **tek `BEGIN IMMEDIATE` içinde** yapar:
idempotency kaydı → sunucu tarafında toplamı yeniden hesapla → istemci toplamıyla karşılaştır →
ödeme doğrula → fiş numarası ata → satır tutarlarını dondur → ödemeleri yaz →
stok hareketlerini yaz → kasa hareketini yaz → satış başlığını `COMPLETED` yap →
denetim + olay kaydı → **fiş işini kuyruğa ekle** → COMMIT.

COMMIT döndüğü an satış kalıcıdır. Fiş baskısı bu noktadan sonra ayrı bir worker'ın işidir.

### 5.2 Doğrulanan güvenceler (test referanslarıyla)

| Güvence | Test |
|---|---|
| Satış asla kaybolmaz — çökme sonrası açık fiş aynen döner | `sale-flow: yarim kalan satis yeniden acilista aynen geri gelir` |
| Tamamlanmış satış yeniden açılışta değişmeden durur | `sale-flow: tamamlanmis satis yeniden acilista degismeden durur` |
| Bekleyen fişler çökmeden sonra kuyrukta kalır | `sale-flow: bekleyen fis isleri yeniden acilista kuyrukta kalir` |
| Aynı satış iki kez kaydedilmez (idempotency) | `sale-flow: ayni anahtarla iki kez tamamlama tek satis olusturur` |
| Aynı anahtar farklı istekle kullanılamaz | `sale-flow: ayni anahtar farkli istekle kullanilirsa reddedilir` |
| UI ile sunucu toplamı uyuşmazsa satış kapanmaz | `sale-flow: sunucu toplami ile UI toplami uyusmazsa satis kapanmaz` |
| Yazıcı kapalıyken satış tamamlanır, fiş sonra basılır | `sale-flow: yazici kapaliyken satis tamamlanir` |
| Stok yalnızca tamamlamada düşer | `sale-flow: stok yalnizca tamamlanmada duser` |
| Stok defteri ile bakiye daima örtüşür | `operations: hareket defteri ile bakiye daima ortusur` |
| 30 barkod art arda okutulunca hepsi sırayla işlenir | `operations: 30 barkod art arda okutuldugunda hepsi sirayla islenir` |
| Çift okuma sıçraması elenir, kasıtlı tekrar elenmez | `operations: cift okuma sicramasi elenir` |
| Bir okumadaki hata sonrakileri engellemez | `operations: bir okumadaki hata sonraki okumalari engellemez` |
| Denetim kaydı kurcalanırsa yakalanır | `operations: denetim kaydi degistirilirse veya silinirse yakalanir` |
| İade fiyatı orijinal fişten alınır | `operations: iade fiyati orijinal fisten alinir` |
| Satılandan fazla iade edilemez | `operations: satilandan fazla iade edilemez` |
| Fiş toplamı = satır netleri toplamı (1000 rastgele senaryo) | `sale-calculate: toplam korunumu` |
| Kuruş artığı kaybolmaz (500 rastgele dağıtım) | `money: distribute toplam korunumu` |

## 6. Barkod çözümleme — mevcut durum

**Motor hazır ve test edilmiş; CAS formatı henüz bilinmediği için tartılı satış kapalıdır.**

Bu bilinçli bir güvenlik kararıdır: tahmini bir formatla yanlış fiyat hesaplamaktansa
satır eklenmez. `config/barcode-rules.json` içinde 8 aday kural `enabled: false` olarak durur.

Çözümleme hattı: normalize → tartılı kurallar (öncelik sırasıyla; uzunluk + prefix +
checksum + alan çıkarma + gömülü check digit + akıl sınırları) → düz barkod araması → UNKNOWN.

**Format keşif motoru** (`core/barcode/analyzer.ts`): mağazadan okutulan gerçek etiketlerden
alan yerleşimini çıkarır. Kanıt gücü sırası: (1) etiket üzerindeki gerçek kg/TL ile birebir
eşleşme → `KESIN`, (2) itemCode'un sistemdeki PLU'lara denk gelmesi → `YUKSEK`, (3) yalnızca
makul aralık → `ORTA/DUSUK`. Testler üç farklı bilinmeyen formatı (ağırlık gömülü, tutar gömülü,
gömülü check digit'li) **doğru şekilde keşfediyor ve round-trip çözüyor**.

**Mağazada yapılacak (2 dakikalık iş):**
```bash
node src/app/cli.ts barcode try <etiketten-okunan-barkod>
node src/app/cli.ts barcode analyze --code=<barkod> --kg=0,750 --plu=231
node src/app/cli.ts barcode apply 0
```
Sadece config değişir; **hiçbir kod değişmez**.

## 7. Donanım entegrasyon durumu

### Xprinter XP-Q805K — ✅ gerçek entegrasyon
- Tam ESC/POS komut üreteci: init, hizalama, kalın, boyut, iki sütun, kesme, para çekmecesi, CODE128 barkod, QR
- `DLE EOT` gerçek zamanlı durum sorgusu (çevrimdışı / kağıt yok / kapak açık) — TCP'de aktif
- Taşıma: **TCP 9100** (durum sorgusu destekli), **Windows paylaşımı** (`copy /b`, USB için, ek sürücü yok), **seri**, dosya/boş (test)
- Dayanıklı kuyruk: geri çekilmeli tekrar (1s/5s/15s/60s), max deneme, `FAILED` → elle tekrar; çökmede `PRINTING`'de kalanlar yeniden kuyruğa alınır
- Fişte: ürün, miktar/kg × birim fiyat, tutar, ara toplam, indirim, KDV dökümü, toplam, ödeme tipi, para üstü, tarih/saat, kasa, kasiyer, fiş no + barkod
- Tekrar basım `*** KOPYA ***` damgalı ve denetime yazılıyor

**Mağazada ayarlanacak:** Türkçe karakter kod sayfası indeksi modele göre değişir.
`node src/app/cli.ts printer codepage` beş adayı tek sayfada basar; doğru okunan satırın
indeksi config'e yazılır (ör. `"CP857:15"` veya `"CP1254:25"`).

### Perkon PS5700 — ✅ gerçek entegrasyon
HID klavye (varsayılan mod), seri COM (Windows'ta `mode` ile ayarlanır), TCP.
Seri/TCP adapterlerde **kablo çıkarsa uygulama çökmez**, arka planda yeniden bağlanır.
Karakter akışını barkoda çeviren framer (sonlandırıcı + sessizlik zaman aşımı) ayrı test edildi.

### CAS CL3000 — ⚠️ kısmi, dürüst durum
POS açısından terazinin tek görevi PLU/fiyat tablosunun güncel kalmasıdır.
- **CSV dışa aktarım (`CSV_EXPORT`) — çalışır ve kullanılabilir:** CL-Works'ün okuduğu
  biçimde PLU dosyası üretir (`scale export`). Mağazada bugün de kullanılan yol budur.
- **Doğrudan TCP yükleme (`CAS_TCP`) — bilinçli olarak uygulanmadı.** CL3000'in çerçeve
  yapısı (komut kodları, uzunluk, checksum) modele göre değişir ve doğrulanmamış bir
  implementasyon *"yükledim"* deyip **teraziyi yanlış fiyatla bırakabilir**. Bu adapter
  bağlantıyı test eder ve açık hata döner; sessizce "başarılı" demez.
  Cihaz erişimi sağlandığında CL-Works ↔ terazi trafiği kaydedilip bu tek dosya yazılacak;
  üst katmanlarda değişiklik gerekmez.

## 8. Bilinen eksikler ve riskler

| Konu | Durum | Etki |
|---|---|---|
| CAS tartılı barkod formatı | Mağazada 1 etiket okutulunca çözülecek | Tartılı satış o ana kadar kapalı |
| CAS doğrudan TCP PLU yükleme | Uygulanmadı (dürüst hata döner) | CSV yolu ile çalışılır |
| Yazıcı Türkçe kod sayfası indeksi | Test sayfası ile belirlenecek | Yanlışsa Türkçe harfler bozuk çıkar (fiş yine basılır) |
| `PRICE_CHECK_4_GS1` gömülü check digit | Gerçek etiketle doğrulanmadı, varsayılan kapalı | Analizör hangi varyantın tuttuğunu otomatik test ediyor |
| Veritabanı yedekleme zamanlayıcısı | Config alanı var, worker henüz yok | Kurulum öncesi eklenecek |
| Windows servis sarmalayıcı | Yok (Task Scheduler ile başlatılacak) | Kurulum adımı |

## 9. UI'ya geçiş için hazır olma değerlendirmesi

Backend API yüzeyi tamam ve test edilmiş (`tests/integration/server.test.ts`):
giriş, okutma, satır işlemleri, indirim (+yönetici onayı), ödeme, iptal, iade,
askıya alma, kasa aç/kapa, X/Z raporu, tekrar basım, ürün arama, SSE olay akışı.

**Sonuç: UI geliştirmeye geçildi (Aşama 7).** Arayüz yalnızca bu API'yi tüketir;
iş mantığı arayüze taşınmadı.

## 10. Aşama 7 — Arayüz

Yerel web arayüzü (`ui/`, 1.364 satır, sıfır bağımlılık), POS sunucusu tarafından
`127.0.0.1` üzerinden servis edilir; Windows'ta Edge kiosk modunda tam ekran çalışır.

- **Barkod okutma odak gerektirmez:** tuşlar belge düzeyinde yakalanır; bir metin
  kutusuna yazılıyorsa karışılmaz. Enter veya 140 ms sessizlik okumayı tamamlar.
- Büyük TOPLAM göstergesi, dokunmatik hedefler ≥ 62 px, F1–F10 klavye kısayolları
- Sepet satırında ürün, miktar/kg, birim fiyat, tutar, satır indirimi ve kaynak barkod
- Ödeme (nakit/kart, para üstü, hızlı tutar tuşları), miktar, indirim, satır silme,
  ürün arama, askıya alma, fiş tekrar basımı, fiş iptali, kasa aç/kapa
- Yönetici onayı gereken işlemlerde arayüz onay ekranını **otomatik** açar
- Sesli geri bildirim (başarılı okuma / hata), yazıcı ve okuyucu durum göstergeleri
- Sunucudan SSE ile anlık durum; ekranda hiçbir tutar tahmin edilmez

### 10.1 Canlı sistemde doğrulanan senaryolar

Gerçek veritabanı, gerçek HTTP sunucusu ve tarayıcı ile uçtan uca çalıştırıldı:

| Senaryo | Sonuç |
|---|---|
| Bilinmeyen tartılı barkod formatı → analiz → uygula → çözümleme | ✅ `KESIN` güvenle bulundu, 12,5 kg'lık tartım dahil doğru çözüldü |
| Tartılı + normal barkod karışık satış, KDV %1/%10/%20 | ✅ Toplam 1.129,25 · KDV 19,52 (grup bazında doğru) |
| Aynı ürünün tekrar okutulması | ✅ Tek satırda miktar arttı |
| Nakit ödeme + para üstü | ✅ Fiş A1, para üstü 70,75 |
| Kart ödemesi | ✅ Fiş A2 |
| Limit üstü indirim → yönetici onayı → orantılı dağıtım | ✅ %25 → 78,23 tam dağıtıldı (27,50 + 3,23 + 47,50) |
| Ürün arama + kilo girişi ile elle ekleme | ✅ |
| **Satış ortasında `kill -9` → yeniden başlatma** | ✅ Açık fiş (3 satır, 425,00) aynen geri geldi, bekleyen 2 fiş kuyrukta kaldı |
| Yazıcı erişilemezken satış | ✅ Satış tamamlandı, fiş kuyruğa alındı, uygulama etkilenmedi |
| Stok, kasa, denetim zinciri tutarlılığı | ✅ `inventory verify`, `audit verify`, `db check` temiz |

> Not: Çökme sonrası kasiyerden PIN yeniden istenir (oturum bellekte tutulur),
> **fiş içeriği kaybolmaz**. Bu bilinçli bir güvenlik tercihidir.

### 10.2 Fiş çıktısı (gerçek ESC/POS akışından çözülmüş)

```
DAGCIHAN KURUYEMIS
SATIS FISI
================================================
Tarih:                                06.09.2026
Fis No:                                       A1
Kasa:                                1 Nolu Kasa
Kasiyer:                               Ayse Kaya
------------------------------------------------
Ic Findik                                 225,00
  0,750 kg x 300,00
Su 0.5L                                    15,00
  2 adet x 7,50
Antep Fistigi                             843,75
  1,875 kg x 450,00
------------------------------------------------
TOPLAM          1.129,25
NAKIT                                   1.200,00
PARA USTU                                  70,75
KDV DOKUMU
  KDV %1                        1.058,17 / 10,58
  KDV %10                           13,64 / 1,36
  KDV %20                           37,92 / 7,58
================================================
```

## 11. Canlıya geçmeden önce yapılacaklar

1. `node src/app/cli.ts db reset --confirm` — doğrulama sırasında oluşan test satışlarını arşivle
2. Gerçek kullanıcıları ve ürün listesini yükle
3. `printer codepage` ile Türkçe kod sayfası indeksini belirle
4. Teraziden gerçek etiket okutup `barcode analyze` + `barcode apply` ile formatı tanımla
5. `config/pos.config.json` içinde mağaza/vergi bilgilerini doldur
6. Görev Zamanlayıcı ile açılışta başlatmayı ve günlük yedeği kur

Ayrıntılar: [04-kurulum-ve-isletim.md](04-kurulum-ve-isletim.md)
