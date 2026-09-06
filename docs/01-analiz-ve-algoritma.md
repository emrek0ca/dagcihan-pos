# Aşama 1 — Sistem Analizi ve Algoritma Tasarımı

> Bu belge mağazadaki mevcut fiziksel operasyonun yazılım modelidir. Kod bu belgeye uyar;
> uyuşmazlık çıkarsa önce bu belge güncellenir, sonra kod.

## 1. Kapsam

**Kapsam içi:** Mağaza içi POS — barkod okutma, tartılı barkod çözümleme, sepet, indirim,
ödeme, stok düşme, satış kaydı, fiş basma, iptal/iade, kasa oturumu, kasiyer, temel raporlar.

**Kapsam dışı (şimdilik):** e-ticaret, online ödeme/PayTR, online sipariş, mobil uygulama,
ayrı masaüstü yönetim uygulaması. Bunlar için kod yazılmaz; ancak çekirdek (core + modüller)
POS arayüzünden bağımsız olduğu için ileride aynı çekirdeğe ikinci bir istemci bağlanabilir.

## 2. Fiziksel akış → yazılım akışı

| # | Fiziksel olay | Yazılım karşılığı | Sorumlu modül |
|---|---|---|---|
| 1 | Personel üründen terazide PLU seçer, tartar | (POS dışı) CL3000 kendi PLU tablosundan hesaplar | `scale` (PLU senkronu) |
| 2 | Terazi etiket basar | Etikette ağırlık **veya** tutar gömülü barkod | — |
| 3 | Müşteri kasaya gelir, etiket okutulur | `ScanEvent{raw}` → parser → `ResolvedScan` | `scanner`, `barcode` |
| 4 | Normal barkodlu ürün okutulur | Aynı hat, weighted kural eşleşmez → düz barkod | `scanner`, `barcode` |
| 5 | Ürün sepete düşer | `SaleItem` + `sale_events` kaydı | `sales` |
| 6 | Kasiyer indirim/silme yapar | Yetki kontrolü + olay kaydı | `sales`, `users` |
| 7 | Ödeme alınır | `Payment[]`, para üstü hesabı | `payments` |
| 8 | Satış kesinleşir | **Tek transaction:** numara + stok + kasa hareketi + fiş kuyruğu | `sales`, `inventory`, `cash-register` |
| 9 | Fiş basılır | ESC/POS işi kuyruğa alınır, worker basar | `printing` |

**Kritik ayrım:** 8. adım atomiktir. 9. adım atomik değildir ve satışı bloklayamaz.
Yazıcı arızası satışı iptal etmez; fiş kuyrukta kalır ve sonra basılır.

## 3. Temel kavramlar

- **Product (ürün):** ana kayıt. `unit ∈ {EACH, KG}`, `unitPrice` (KG ise TL/kg, EACH ise TL/adet),
  `taxRate` (KDV %), `trackStock`, `active`.
- **PLU:** teraziye programlanan sayısal ürün kodu. Ürün ile 1-1 veya 1-n eşleşir
  (aynı ürünün farklı terazi PLU'su olabilir). Ayrı tablo: `product_plus`.
- **Barcode:** ürüne bağlı düz barkod (EAN13/EAN8/UPC/Code128/dahili). Bir ürünün birden çok
  barkodu olabilir (aynı ürün farklı tedarikçi ambalajı). Ayrı tablo: `product_barcodes`.
- **Weighted barcode:** teraziden basılan, içinde **ağırlık** veya **tutar** taşıyan barkod.
  Ürüne PLU/ürün kodu alanı üzerinden bağlanır. Veritabanında tutulmaz, **çözümlenir**.
- **Sale (satış):** fiş. Durumları: `OPEN → COMPLETED | VOIDED`, ayrıca `PARKED` (askıda).
- **SaleItem:** satır. Ürün adı, fiyat, KDV oranı **satış anında kopyalanır (snapshot)**;
  sonradan ürün fiyatı değişse bile geçmiş fiş değişmez.

## 4. Para ve miktar aritmetiği — kesin kurallar

Floating point **kullanılmaz**. İki tam sayı ölçeği vardır:

- **Para:** `Money = tam sayı kuruş` (TRY minor unit, ölçek 10^2). 12,45 TL → `1245`.
- **Miktar:** `Quantity = tam sayı milli-birim` (ölçek 10^3). 0,750 kg → `750`. 3 adet → `3000`.
  Ağırlık için 1 g çözünürlük yeterlidir (terazi 1 g veya 5 g adımlıdır).

**Satır tutarı:**
```
lineGross = roundHalfUp( quantityMilli * unitPriceKurus / 1000 )
```
`roundHalfUp` = yarımı sıfırdan uzağa yuvarlama (ticari yuvarlama), negatif tutarlarda da simetrik.
Tek bir fonksiyonda tanımlıdır (`core/money`), başka hiçbir yerde yuvarlama yapılmaz.

**Tutar gömülü barkodda** hesap yoktur: `lineGross = barkoddan gelen tutar`. Miktar bilgi amaçlı
türetilir: `quantityMilli = round(lineGross * 1000 / unitPrice)` — bu değer stok düşmede kullanılır,
fiyatta kullanılmaz.

**KDV (fiyatlar KDV dahil):**
```
taxAmount = roundHalfUp( lineNet * rate / (100 + rate) )
netExclTax = lineNet - taxAmount
```
KDV, satır bazında değil **KDV oranı grubu bazında** (fiş toplamı üzerinden) hesaplanır; böylece
fişteki KDV özeti ile satır toplamları arasında kuruş farkı oluşmaz.

**Fiş toplamı:** `total = Σ lineNet - saleDiscount`. Nakit ödemede istenirse
`roundingMode = NEAREST_5_KURUS` uygulanabilir (config, varsayılan kapalı) ve fark
`rounding_adjustment` olarak ayrı kaydedilir — asla satır tutarına gizlenmez.

## 5. Barkod çözümleme algoritması

Girdi: `raw` (okuyucudan gelen ham dizi). Çıktı: `ResolvedScan`.

```
normalize(raw)                # CR/LF, boşluk, yazdırılamayan karakter temizliği
  ↓
if len == 0 → IGNORED
  ↓
weightedRules (priority sırasında, enabled olanlar)
  ├ eşleşme testi: uzunluk + symbology + match(prefix | prefix-range | regex)
  ├ genel check digit doğrulaması (EAN13 mod10 vb.)
  ├ alan çıkarma: itemCode, value (+ opsiyonel gömülü check digit doğrulaması)
  ├ value yorumu: WEIGHT_KG | PRICE | COUNT, scale ile ölçekleme
  └ eşleşen ilk kural kazanır → WEIGHTED
  ↓ (hiç kural eşleşmedi)
düz barkod araması: product_barcodes tablosu (tam eşleşme, sonra normalize varyantları:
   UPC-A→EAN13 sol sıfır, EAN8, baştaki sıfır kırpma)
  ↓ bulundu → PLAIN
  ↓ bulunamadı → UNKNOWN  (unknown_barcode_scans tablosuna ham kayıt + zaman + terminal)
```

### 5.1 Neden `UNKNOWN` kaydı kritik
CAS CL3000'in gerçek barkod formatı **henüz bilinmiyor**. Mağazada ilk etiket okutulduğunda
çözümlenemezse ham dizi veritabanına yazılır. `pos barcode analyze` komutu bu kayıtları
inceleyip aday formatları (prefix, alan uzunlukları, check digit) raporlar. Format tespit
edilince **yalnızca config dosyasındaki kural** güncellenir; kod değişmez.

### 5.2 Kural şeması (config)
```jsonc
{
  "id": "cas-weight-2x",
  "enabled": true,
  "priority": 10,
  "length": 13,
  "match": { "type": "prefixRange", "from": "21", "to": "29" },
  "checkDigit": { "algorithm": "EAN13" },
  "fields": {
    "itemCode": { "offset": 2, "length": 5, "lookup": "PLU" },
    "value": { "offset": 7, "length": 5, "scale": 3, "kind": "WEIGHT_KG",
               "embeddedCheck": { "algorithm": "NONE" } }
  }
}
```
Desteklenen `checkDigit.algorithm`: `NONE | EAN13 | EAN8 | UPCA`.
Desteklenen `embeddedCheck.algorithm`: `NONE | PRICE_CHECK_4` (klasik 2-3-5-8 ağırlıklı
tartı/fiyat check digit'i), `MOD10`.
Desteklenen `value.kind`: `WEIGHT_KG | PRICE | COUNT`.
`lookup`: `PLU | PRODUCT_CODE | BARCODE_PREFIX`.

Aday kurallar mağazada test edilmek üzere `config/barcode-rules.json` içinde hazır gelir;
gerçek format belirlenene kadar hepsi **devre dışı** değil, **öncelik sırasıyla denenir** ve
her çözümleme `scan_diagnostics` tablosuna hangi kuralın eşleştiğini yazar.

## 6. Ürün bulma ve fiyat doğrulama

```
WEIGHTED:
  product = findByPlu(itemCode) ?? findByCode(itemCode)
  if !product              → HATA: PLU_NOT_FOUND (satır eklenmez)
  if !product.active       → HATA: PRODUCT_INACTIVE
  if product.unit != KG    → UYARI: tartılı barkod ama ürün adet birimli → yapılandırmaya göre
                              reddet (varsayılan) veya adet olarak ekle
  value.kind == WEIGHT_KG:
      quantity = value
      unitPrice = product.unitPrice           (güncel fiyat otoritedir)
      lineGross = round(quantity * unitPrice / 1000)
      DOĞRULAMA: quantity ∈ (0, maxWeightKg]  (varsayılan 50 kg)
  value.kind == PRICE:
      lineGross = value                        (etiketteki tutar otoritedir — müşteri onu görüyor)
      unitPrice = product.unitPrice
      quantity  = round(lineGross * 1000 / unitPrice)
      DOĞRULAMA: 0 < lineGross <= maxLineAmount (varsayılan 5.000 TL)
      UYARI: türetilen ağırlık maxWeightKg üstündeyse → fiyat değişmiş olabilir, denetim kaydı

PLAIN:
  product = barcode kaydından
  quantity = 1000 (1 adet)
  unitPrice = product.unitPrice
  lineGross = unitPrice
```

**Fiyat doğrulama ilkesi:** Fiyat asla barkodun "güvendiği" bir kaynaktan hesaplanmaz;
ağırlık gömülü barkodda fiyat **ürün kartından**, tutar gömülü barkodda **etiketten** gelir.
İki durumda da sonuç `price_source` alanına yazılır ve fişte denetlenebilir olur.

## 7. Satış durum makinesi

```
                 addItem / voidItem / changeQty / discount / addPayment
                ┌───────────────────────────────────────────────┐
                ↓                                               │
  (yok) ──► OPEN ──park──► PARKED ──resume──► OPEN ─────────────┘
             │  │
             │  └──complete(idempotencyKey)──► COMPLETED   (terminal)
             └─────void(reason, yetki)───────► VOIDED      (terminal)
```
- `COMPLETED` ve `VOIDED` **terminaldir**; bu satışlar bir daha değişmez.
- Bir terminalde aynı anda **en fazla bir** `OPEN` satış olur (DB'de partial unique index).
- `PARKED` satış sayısı sınırsızdır (müşteri beklerken araya başka müşteri alınabilir).

**Satış olayları (append-only `sale_events`):**
`SALE_OPENED, ITEM_ADDED, ITEM_QTY_CHANGED, ITEM_VOIDED, ITEM_DISCOUNTED,
SALE_DISCOUNTED, PAYMENT_ADDED, PAYMENT_REMOVED, SALE_PARKED, SALE_RESUMED,
SALE_COMPLETED, SALE_VOIDED, PRICE_OVERRIDE, UNKNOWN_SCAN`

Satırın silinmesi fiziksel `DELETE` değildir: `void_at`/`void_by`/`void_reason` işaretlenir,
satır fişte görünmez ama denetimde durur.

## 8. İndirim algoritması

Sıra kesindir ve tek yerde uygulanır (`core/sale/calculate.ts`):
1. Satır indirimleri (`PERCENT` veya `AMOUNT`) → `lineNet = lineGross - lineDiscount`
2. `subtotal = Σ lineNet`
3. Fiş indirimi (`PERCENT` veya `AMOUNT`) → satırlara **`lineNet` oranında dağıtılır**
   (KDV grup dökümü doğru çıksın diye). Dağıtım artığı (kuruş) en büyük satıra eklenir;
   `Σ dağıtılan == fiş indirimi` daima sağlanır.
4. KDV oran gruplarına göre KDV özeti hesaplanır.

Kurallar: indirim satır tutarını negatife düşüremez; yüzde ∈ [0,100]; belirlenen eşiğin
(`maxDiscountPercentWithoutApproval`, varsayılan %10) üzeri **yönetici onayı** ister.

## 9. Ödeme algoritması

- Bir satışta birden çok ödeme olabilir (`CASH`, `CARD`, ileride `VOUCHER`).
- `paidTotal = Σ payment.amount`, `remaining = total - paidTotal`.
- `CASH` ödemesinde `tendered ≥ amount`; `changeDue = tendered - amount`.
  Nakit para üstü yalnızca `CASH` satırlarından verilir.
- `CARD` ödemesinde `tendered = amount` (POS cihazı harici; onay kodu opsiyonel alan).
- `remaining == 0` olmadan satış tamamlanamaz. `remaining < 0` durumu ancak nakit ile
  oluşur ve `changeDue` olarak ele alınır, kaydedilen `amount` asla toplamı aşmaz.

## 10. Satış tamamlama transaction'ı

`completeSale(saleId, payments, idempotencyKey)` — **tek SQLite transaction**, IMMEDIATE:

```
BEGIN IMMEDIATE
  1. idempotency_keys tablosuna key INSERT → çakışma varsa: eski sonucu döndür, çık
  2. satış OPEN mi? değilse hata
  3. sunucu tarafında toplamı YENİDEN hesapla (istemciden gelen toplama güvenilmez)
     istemci toplamı ile uyuşmuyorsa → TOTAL_MISMATCH, iptal
  4. ödeme toplamı == hesaplanan toplam mı? değilse hata
  5. fiş numarası ata (sequences tablosundan atomik artır)
  6. sale_items dondur, payments yaz
  7. stok hareketlerini yaz (stock_movements) ve products.stock_qty güncelle
  8. kasa oturumuna nakit hareketi yaz
  9. sale.status = COMPLETED, completed_at
 10. print_jobs'a fiş işi ekle (PENDING)
 11. audit_events + sale_events(SALE_COMPLETED) yaz (hash zinciri ile)
 12. idempotency_keys satırını sonuçla güncelle
COMMIT
```
Commit döndüğü an satış **kalıcıdır** (`synchronous=FULL`, WAL). Fiş basımı bu noktadan
sonra ayrı bir worker'ın işidir; başarısız olması satışı etkilemez.

## 11. Idempotency

- Tamamlama, iade ve nakit hareketi çağrıları `idempotencyKey` (UUID) taşır.
- `idempotency_keys(key PRIMARY KEY, scope, request_hash, response_json, created_at)`.
- Aynı key ile ikinci çağrı: kayıtlı yanıt döner, **yeni satış oluşmaz**.
- `request_hash` farklıysa `IDEMPOTENCY_KEY_REUSE` hatası (aynı key farklı istek = hata).
- Anahtarı UI değil, işlem başlatan servis üretir; UI yeniden dener ama key değişmez.

## 12. Stok kuralları

- Stok **yalnızca** satış tamamlandığında düşer (adım 10.7). `OPEN`/`PARKED` satış stoğu tutmaz.
- Her stok değişimi `stock_movements`'a yazılır: `SALE, RETURN, VOID_RESTORE, PURCHASE,
  ADJUSTMENT, WASTE, COUNT`. `products.stock_qty` bu hareketlerin türevi olduğu için
  `pos inventory verify` komutu ikisini karşılaştırıp tutarsızlığı raporlar.
- Negatif stok engellenmez (mağazada sayım hatası satışı durdurmamalı) ama uyarı ve denetim
  kaydı üretir. `blockNegativeStock` config ile açılabilir.
- KG ürünlerde stok milli-birim (gram) olarak tutulur.

## 13. İptal (void) ve iade (refund)

**Void (satış iptali):** yalnızca `OPEN` satış için. Stok/kasa etkisi yoktur (henüz düşmedi).
Satış `VOIDED` işaretlenir, silinmez.

**Void line (satır iptali):** `OPEN` satışta satır işaretlenir. Yetki eşiği config ile.

**Refund (iade):** tamamlanmış satış üzerine **yeni bir belge** (`type=REFUND`) açılır.
- `original_sale_id` zorunlu (referanslı iade) veya `blindRefundAllowed=true` ise yönetici onayı.
- İade satırları orijinal satırdan fazla olamaz (`iade edilen ≤ satılan - önceki iadeler`).
- Fiyat orijinal satırdan kopyalanır, güncel fiyattan değil.
- Stok geri eklenir (`RETURN`), kasadan nakit çıkışı yazılır, iade fişi basılır.
- İade de tamamlama ile aynı atomik transaction ve idempotency kurallarına tabidir.

## 14. Fiş basımı

- `print_jobs(id, sale_id, kind, payload BLOB, status, attempts, last_error, created_at)`.
- Worker: `PENDING` → transport'a yaz → `DONE`; hata → `attempts++`, geri çekilmeli tekrar
  (1s, 5s, 15s, 60s...), `attempts > N` → `FAILED` (elle tekrar basılabilir).
- Yazıcı durumu ESC/POS `DLE EOT` ile yoklanır (kağıt yok / kapak açık / offline).
  Durum UI'da göstergedir; **satışı bloklamaz**.
- Tekrar basma: `kind=REPRINT`, fiş başlığına `*** KOPYA ***` eklenir, denetime yazılır.
- Fiş içeriği: mağaza başlığı, tarih/saat, fiş no, kasa no, kasiyer, satırlar
  (ad, miktar/kg × birim fiyat, tutar), ara toplam, indirim, KDV özeti, genel toplam,
  ödeme tipleri, para üstü, barkod/QR (fiş no).

## 15. Kasa oturumu

`OPEN → CLOSED`. Açılışta sayılan devir (`opening_float`). Oturum boyunca: satış nakit
girişleri, iade nakit çıkışları, elle `PAID_IN`/`PAID_OUT` hareketleri. Kapanışta sayılan
nakit girilir; `expected = opening + Σ hareketler`, `variance = counted - expected`.
Z raporu bastırılır ve `cash_sessions` kilitlenir.

## 16. Arıza senaryoları matrisi

| Senaryo | Davranış |
|---|---|
| İnternet kesildi | Sistem tamamen yereldir; etkilenmez. |
| Yazıcı kapalı/kağıt yok | Satış tamamlanır, fiş kuyrukta bekler, UI'da uyarı; sonradan basılır. |
| Barkod okuyucu kablosu çıktı | `ScannerPort` yeniden bağlanmayı dener; UI'da bağlantı göstergesi; elle ürün arama çalışır. |
| Terazi ağa erişilemiyor | Yalnızca PLU senkronu etkilenir; satış etkilenmez. |
| Aynı barkod art arda hızlı okundu | Girdi kuyruğu seri işlenir; `dedupeWindowMs` (varsayılan 120 ms) içindeki **birebir aynı** ham dizi yok sayılır; sonrası normal artırımdır. |
| Aynı ürün kasten iki kez okutuldu | Düz barkodda miktar artar; tartılı barkodda **ayrı satır** açılır (iki farklı etiket olabilir). |
| Program satış ortasında kapandı | `OPEN` satış diskte; açılışta otomatik geri yüklenir. |
| Windows yeniden başladı | Aynı; ayrıca `PENDING` fiş işleri kuyruktan devam eder. |
| Tartılı barkod geçersiz/checksum hatalı | Satır eklenmez, sesli/görsel hata, ham dizi `unknown_barcode_scans`'e yazılır. |
| PLU bulunamadı | Satır eklenmez, kasiyere "ürün bulunamadı + ham barkod" gösterilir. |
| Disk doldu / DB yazamıyor | Satış tamamlama hata döner, UI net uyarı verir; **sessiz kayıp yok**. |
| İki kez "tamamla" basıldı | Idempotency key aynı → tek satış. |

## 17. Çökme sonrası kurtarma (startup)

```
1. DB bütünlük kontrolü (PRAGMA quick_check) — bozuksa yedeğe düş ve uyar
2. Bekleyen migration'ları uygula
3. Bu terminalin OPEN satışını yükle → sepet ekrana geri gelir
4. Yarım kalmış tamamlama var mı? (idempotency_keys'te response'suz kayıt) → durumu belirle:
   satış COMPLETED ise sonucu tamamla, değilse anahtarı serbest bırak
5. PENDING/RETRY print_jobs kuyruğunu başlat
6. Açık kasa oturumunu yükle
7. Donanım adapter'larını başlat (hata olsa da uygulama açılır, göstergeler kırmızı yanar)
```

## 18. Denetlenebilirlik

- `audit_events`: `id, at, actor_user_id, terminal_id, type, entity, entity_id, data_json,
  prev_hash, hash`. `hash = sha256(prev_hash || canonical_json(row))` → sonradan satır
  değiştirilirse zincir kırılır, `pos audit verify` bunu raporlar.
- Fiyat değişikliği, indirim, iptal, iade, kasa açma/kapama, elle fiyat girişi, tekrar basma
  ve bilinmeyen barkod okuma denetime yazılır.

## 19. Performans hedefleri

| İşlem | Hedef |
|---|---|
| Barkod okuma → satır ekranda | < 80 ms (p95) |
| Satış tamamlama (commit dahil) | < 150 ms (p95) |
| Fiş baskısı kuyruğa alma | < 5 ms (senkron, baskı asenkron) |
| Uygulama açılışı → satışa hazır | < 5 sn |

## 20. Mağazada doğrulanacak açık konular

1. **CAS CL3000 barkod formatı** — ilk etiket okutulduğunda `unknown_barcode_scans` üzerinden çözülecek.
2. Terazi barkodu **ağırlık mı tutar mı** taşıyor (mağazadaki en kritik ayrım).
3. Terazi PLU numaraları ile mevcut ürün kodları arasındaki eşleşme.
4. Perkon PS5700 bağlantı tipi: USB HID klavye (beklenen) mi, seri (COM) mi.
5. Xprinter bağlantısı: USB (Windows paylaşımı) mı, Ethernet (9100) mi.
6. Mevcut ürün/stok verisinin eski POS'tan dışa aktarım formatı.
7. KDV oranları ve fiş başlık/altlık metinleri (vergi dairesi, ÖKC durumu).
