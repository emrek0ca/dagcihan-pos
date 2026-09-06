# Senkronizasyon Tasarımı

> **En önemli kural:** Mağazadaki POS'un çalışması VPS'in ayakta olmasına
> **bağlı değildir.** Sunucuya giden hiçbir çağrı satışın kritik yolunda yer almaz.

## 1. Genel akış

```
  Windows POS (SQLite)                          VPS (PostgreSQL)
  ─────────────────────                         ────────────────────
  satış tamamlandı
    └─ TEK transaction ────────┐
         sales/sale_items      │
         payments              │
         stock_movements       │  aynı commit
         outbox_events   ◄─────┘
                                    push (arka plan, 20 sn)
    outbox ──────────────────────►  POST /api/v1/sync/push
                                       └─ sync_events (PK = eventId)
                                       └─ sales / sale_lines / payments
                                       └─ inventory_ledger + balances
                                       └─ cash_movements / audit_log

    apply  ◄─────────────────────  GET /api/v1/sync/pull?cursor=N
      ürün / fiyat / barkod / PLU        change_log
```

Sunucuya ulaşılamazsa: satış **normal tamamlanır**, olay outbox'ta bekler,
bağlantı gelince otomatik gönderilir. Kasiyerin hiçbir şey yapması gerekmez.

## 2. Transactional outbox

Olay, işi yapan transaction'ın **içinde** yazılır (`src/modules/sync/outbox.ts`):

- Satış commit olduysa olay **kesinlikle** kuyruktadır.
- Satış geri alındıysa olay da yoktur.
- "Satış kaydedildi ama olay kayboldu" durumu **oluşamaz**.

Test: `sync.test.ts → satis geri alinirsa olay da olusmaz`

### Olay zarfı

| Alan | Açıklama |
|---|---|
| `eventId` | UUID. **Yeniden denemelerde değişmez** — idempotency anahtarı |
| `type` | `sale.completed`, `sale.refunded`, `sale.voided`, `inventory.adjusted`, `cash_session.opened/closed`, `cash.movement`, `product.price_changed`, `cashier.upserted` |
| `sequence` | Terminal içi monotonik sıra |
| `occurredAt` | Olayın gerçekleştiği yerel zaman (ISO) |
| `payload` | Olayın tam içeriği (satırlar, ödemeler, tutarlar) |

`terminalId` ve `storeId` **gövdeden alınmaz**, cihaz token'ından türetilir:
bir terminal başka terminalin adına veri yazamaz.

## 3. Idempotency

Sunucu tarafında `sync_events.event_id` birincil anahtardır.

| Durum | Sonuç |
|---|---|
| İlk gönderim | `PROCESSED` |
| Aynı olay tekrar (işlenmişti) | `DUPLICATE` — hiçbir şey yapılmaz |
| Aynı olay tekrar (**önceki denemede hata almıştı**) | **Yeniden işlenir** |

Son satır kritiktir: hatalı bir olay "duplicate" sayılsaydı istemci onu
gönderilmiş kabul eder ve **olay kalıcı olarak kaybolurdu**. Bu hata geliştirme
sırasında yakalandı ve düzeltildi.

İkinci savunma hattı: `sales(terminal_id, local_uid)` benzersizdir. Farklı
`eventId` ile aynı fiş gelse bile mükerrer satış oluşmaz.

Üçüncü hat: `inventory_ledger(event_id, product_id, movement_type)` benzersizdir;
stok aynı olayla iki kez düşmez.

## 4. Yeniden deneme

- **Ağ hatası** (bağlanamama, zaman aşımı): deneme hakkı **harcanmaz**, olay
  bekler. İnternet yokluğu bir hata değil, normal bir durumdur.
- **Sunucu hatası** (5xx) veya olay reddi: `attempts++`, üstel geri çekilme
  `2s → 4s → 8s … max 5 dk` + **jitter** (tüm kasalar aynı anda yüklenmesin).
- `maxAttempts` (varsayılan 25) aşılırsa olay `DEAD` olur — **silinmez**.
  Yönetim → Merkezi Sunucu → *Yeniden Dene* ile kuyruğa geri alınır.
- **Terminal iptal edilmişse** (`TERMINAL_REVOKED`): yeniden deneme durur,
  arayüzde net mesaj çıkar. Anlamsız tekrarla sunucu yorulmaz.

## 5. Çift yönlü akış

**POS → Sunucu:** tamamlanan satışlar, satış satırları, ödemeler, iadeler,
stok hareketleri, kasa oturumları/hareketleri, POS'ta yapılan fiyat değişikliği,
kasiyer tanımları.

**Sunucu → POS:** ürünler, barkodlar, PLU'lar, fiyatlar, KDV oranları, aktiflik.

### Artımlı çekme
- `change_log` tablosu her merkezi değişiklikte satır üretir; `id` cursor'dır.
- POS `GET /sync/pull?cursor=N` ile **yalnızca yeni** değişiklikleri alır.
- Her seferinde tüm katalog indirilmez.

### İlk yükleme (bootstrap)
- Yeni kasa aktive edilince `GET /sync/bootstrap` ile katalog **sayfalanarak**
  indirilir (200'lük sayfalar, `after` cursor'ı ile).
- Bootstrap'in **başındaki** `change_log` head'i imleç olarak alınır; bootstrap
  sırasında oluşan değişiklikler atlanmaz.

## 6. Çakışma politikası (açık, sessiz last-write-wins değil)

| Varlık | Otorite | Gerekçe |
|---|---|---|
| Ürün ana bilgisi, kategori, KDV | **Sunucu** | Tek merkezden yönetilir, tüm kanallar aynı veriyi görür |
| Fiyat | **Sunucu** | Kanallar arası tutarlılık; POS'ta yapılan değişiklik merkeze işlenir ve oradan yayılır |
| Barkod, PLU | **Sunucu** | Terazi ve kasa aynı tanımı kullanmalı |
| Kullanıcı/yetki | **Sunucu** | Güvenlik kararı merkezde |
| **Bu terminalde gerçekleşen satış/ödeme/kasa oturumu** | **Terminal** | Fiziksel gerçek kasadadır; sunucu bunu değiştiremez |
| Stok | **Merkezi ledger** | Tüm kanalların hareketleri tek deftere yazılır, bakiye ondan türetilir |

Merkezden gelen değer yereldekinden farklıysa **sessizce ezilmez**:
`sync_pull_log`'a ve fiyat değişikliğiyse `product_price_history` +
`audit_events`'e yazılır. Mağaza "fiyat neden değişti" sorusunu cevaplayabilir.

## 7. Stok ve e-ticaret hazırlığı

Merkezi tarafta stok **ledger** ile tutulur; `inventory_balances` türetilmiş
bir görünümdür ve doğruluğu test edilir.

```
available = on_hand - reserved
```

- `POS sale`   → ledger `SALE`, `on_hand` azalır
- `refund`     → ledger `REFUND`, `on_hand` artar
- `online order` (gelecek) → `stock_reservations` + `reserved` artar
- rezervasyon serbest bırakılırsa → `reserved` azalır

**Dürüst tutarlılık modeli:** Çevrimdışı POS satışları merkeze gecikmeli ulaşır.
Bu süre boyunca merkezi `available` gerçekten satılabilir olandan **fazla**
görünebilir. Sistem bunu "güçlü tutarlı" gibi göstermez; e-ticaret tarafı
rezervasyon + son onay modeliyle çalışmalıdır.

### Stok mutabakatı
POS `sync reconcile-stock` komutu merkezi bakiyeyi okur ve **farkı** `COUNT`
hareketi olarak gönderir. Mutlak değer gönderilseydi, daha önce senkronize
olmuş satışlar ikinci kez düşülürdü. İşlem tekrarlanabilir: ikinci çalıştırmada
fark sıfırdır ve hareket üretilmez.

## 8. Cihaz kimliği ve güvenlik

```
organization → store → terminal
```

- Aktivasyon: yönetici `device:create` ile **tek kullanımlık**, 24 saat geçerli
  bir kod üretir. POS bu kodu girer, karşılığında kalıcı cihaz token'ı alır.
- Token veritabanında **yalnızca SHA-256 özeti** ile saklanır.
- POS'ta token ayrı bir dosyadadır (`sync-credentials.json`, `0600`),
  **veritabanında değildir** — veritabanı yedeği kopyalansa bile token gitmez.
- POS config'ine e-posta/parola yazılmaz. Kullanıcı parolası yalnızca ilk
  katalog aktarımında (`sync push-catalog`) elle girilir, saklanmaz.
- İptal: yönetici terminali `REVOKED` yapar → tüm token'ları anında geçersiz.

### Yetki ayrımı
`terminal` rolü yalnızca `sync.push`, `sync.pull`, `catalog.read`,
`inventory.read`, `sales.write`, `refund.write`, `cash.write` yetkilerine sahiptir.
Bir kasa cihazı kullanıcı yönetemez, terminal iptal edemez, başka mağazanın
verisini göremez.

## 9. Doğrulanan senaryolar

| Senaryo | Test |
|---|---|
| Aynı satış olayı 10 kez → sunucuda tek satış | POS + sunucu |
| İnternet satış sırasında kesildi → yerel satış başarılı | POS |
| İnternet geldi → otomatik senkron | POS |
| 10 çevrimdışı satış → hepsi sonradan gitti | POS |
| POS senkron sırasında kapandı → yeniden açılışta devam | POS |
| Sunucu yeniden başlatıldı → olay kaybı yok | POS + canlı |
| Olaylar sıra dışı geldi (satış → kasa oturumu) → tutarlı sonuç | Sunucu |
| İptal edilmiş terminal → senkron reddedildi, satış devam etti | POS |
| İki terminal aynı anda senkron → veriler karışmadı | Sunucu |
| Fiyat güncellemesi → artımlı çekme ile uygulandı | POS |
| Stok defteri ↔ bakiye tutarlılığı | Sunucu |
| İade tekrar gönderildi → mükerrer iade yok | POS + sunucu |
| Hatalı olay → kısmi kayıt kalmadı (rollback) | Sunucu |
| Migration tekrar çalıştırılabilir | Sunucu |
| Yedek + geri yükleme | Canlı doğrulama |

## 10. POS tarafı komutlar

```bash
node src/app/cli.ts sync enroll <https://sunucu> <AKTIVASYON-KODU>
node src/app/cli.ts sync push-catalog <eposta> --password=<parola>   # ilk kurulum
node src/app/cli.ts sync reconcile-stock                            # stok mutabakatı
node src/app/cli.ts sync now
node src/app/cli.ts sync status
node src/app/cli.ts sync retry
```

Aynı işlemler POS arayüzünde **Yönetim → Merkezi Sunucu** ekranından da yapılır.
Kasiyer ekranında yalnızca küçük bir durum rozeti görünür:
`Merkez: güncel` / `Merkez: N bekliyor` / `Merkez: çevrimdışı` / `Merkez: hata`.
