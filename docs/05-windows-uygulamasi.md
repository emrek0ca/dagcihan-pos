# Windows Masaüstü Uygulaması

Bu belge, POS'un Windows kasa bilgisayarında bir masaüstü uygulaması olarak
kurulmasını ve işletilmesini anlatır. İş mantığı [01](01-analiz-ve-algoritma.md) ve
[02](02-mimari.md)'de; donanım kalibrasyonu [04](04-kurulum-ve-isletim.md)'te.

## 1. Mimari kararı: neden ikinci bir backend yok

Electron 44, içinde **Node 24 ve `node:sqlite`** ile gelir. Bu yüzden mevcut backend
(`PosApplication` + `PosServer`) **doğrudan Electron ana sürecinde** çalışır.

```
┌─────────────────────────── Dagcihan POS.exe ───────────────────────────┐
│  Electron ana süreci (Node 24)                                          │
│    ├─ PosApplication  ← mevcut çekirdek, DEĞİŞMEDİ                      │
│    ├─ PosServer       ← 127.0.0.1, yalnızca yerel                       │
│    ├─ PrintQueue / ScanResolver / SQLite (node:sqlite)                  │
│    └─ Kabuk: tek örnek, log, yedek, güç yönetimi, kontrollü kapanış     │
│                                                                          │
│  Electron pencere süreci (Chromium)                                     │
│    └─ Mevcut POS arayüzü, http://127.0.0.1:<port> üzerinden             │
└──────────────────────────────────────────────────────────────────────────┘
```

- **İkinci runtime yok** (ayrı `node.exe` paketlenmiyor)
- **Native bağımlılık yok** (`better-sqlite3` vb. yok, node-gyp yok)
- **Ayrı yönetim backend'i yok** (yönetim ekranları aynı `PosServer`'a bağlı)
- **Windows servisi yok** (uygulama kapanınca POS da kapanır; veri diskte kalır)

## 2. Klasörler — güncelleme neyi siler, neyi silmez

| Ne | Nerede | Güncellemede |
|---|---|---|
| Program dosyaları | `C:\Program Files\Dagcihan POS\` | **Değişir** (yenisiyle gelir) |
| Satış veritabanı | `%APPDATA%\DagcihanPOS\data\pos.db` | **Korunur** |
| Mağaza ayarları | `%APPDATA%\DagcihanPOS\config\pos.config.json` | **Korunur** |
| Terazi barkod kuralı | `%APPDATA%\DagcihanPOS\config\barcode-rules.json` | **Korunur** |
| Yedekler | `%APPDATA%\DagcihanPOS\data\backups\` | **Korunur** |
| Loglar | `%APPDATA%\DagcihanPOS\logs\` | **Korunur** |

Kullanıcı veri yolu kodda **sabitlenmiştir** (`app.setPath('userData', …DagcihanPOS)`).
Ürün adı değişse bile Windows başka bir klasöre kaymaz — veritabanı kaybolmuş gibi
görünmez.

İlk çalıştırmada varsayılan ayar dosyaları program klasöründen kullanıcı klasörüne
kopyalanır; **var olan dosyaların üzerine asla yazılmaz** (test:
`desktop.test.ts → GÜNCELLEME: mevcut mağaza ayarları asla üstüne yazılmaz`).

## 3. Windows kurulum dosyasını üretme

### Seçenek A — Windows makinede
```bat
npm ci
npm test
npm run dist:win
```
Çıktı: `release\Dagcihan-POS-Kurulum-1.0.0.exe`

### Seçenek B — Windows makine olmadan (GitHub Actions)
`.github/workflows/build-windows.yml` hazır. GitHub'da **Actions → Windows kurulum
dosyası → Run workflow** deyin; iş bitince **Artifacts** altından `.exe` indirilir.

> **Not:** Installer yalnızca Windows'ta (veya wine kurulu bir makinede) üretilebilir;
> macOS/Linux'ta `npm run dist:win` NSIS adımında durur. Paketleme yapılandırması
> macOS'ta `--dir` ile doğrulanmıştır (asar içeriği, yollar ve açılış çalışır durumda).

### Installer davranışı
- Kurulum sihirbazı (tek tık değil), klasör seçilebilir
- Tüm kullanıcılar için kurulum (`perMachine`) — yönetici izni ister
- Masaüstü ve Başlat menüsü kısayolu: **POS Kasa**
- Kaldırma sırasında **`%APPDATA%\DagcihanPOS` silinmez** (satış verisi korunur)
- Türkçe kurulum arayüzü

## 4. Güncelleme

1. Yeni sürümün `.exe` dosyasını çalıştırın (kapatmadan önce POS'u kapatın).
2. Kurulum program dosyalarını değiştirir; `%APPDATA%\DagcihanPOS` **dokunulmaz**.
3. Uygulama açılışta veritabanı şemasını gerekiyorsa otomatik yükseltir
   (`PRAGMA user_version` + sıralı migration; her migration tek transaction).
4. Şema yükseltmesi başarısız olursa uygulama açılmaz ve hata gösterir —
   yarım uygulanmış şema oluşmaz.

**Güncelleme öncesi önerilen:** Yönetim → Sistem → **Yedek Al**.

## 5. Windows davranışları

| Gereksinim | Nasıl çalışır |
|---|---|
| Tek örnek | `requestSingleInstanceLock()`. İkinci kopya açılmaz, var olan pencere öne gelir. İki sürecin aynı veritabanına yazması imkânsız. |
| Beklenmeyen kapanmadan sonra kurtarma | Açık fiş diskte; açılışta otomatik yüklenir. `PRINTING`'de kalan fiş işleri kuyruğa geri alınır. Kasiyer PIN'i yeniden girer (oturum bellekte tutulur), **fiş içeriği kaybolmaz**. |
| Kontrollü kapanış | Açık fiş varsa onay sorulur → sunucu kapatılır → kapanış yedeği alınır → WAL checkpoint + DB kapatılır. |
| Windows kapanışı | `powerMonitor.shutdown` aynı kontrollü kapanışı çalıştırır. |
| Uyku / uyanma | Uyanışta veritabanı bütünlüğü kontrol edilir, fiş kuyruğu yeniden denenir, arayüze bilgi düşer. |
| Ekran uykusu | `preventDisplaySleep` varsayılan açık (Yönetim → Sistem'den kapatılabilir). |
| Loglar | `%APPDATA%\DagcihanPOS\logs\pos-YYYY-MM-DD.log`, 30 gün saklanır, **senkron yazılır** (çökmeden hemen önceki satır diske düşer). |
| Yedekleme | Yapılandırılan aralıkta (varsayılan 30 dk) + her kapanışta. Son 30 yedek tutulur; `arsiv-` ile başlayanlar hiç silinmez. |
| Tam ekran / kiosk | Varsayılan tam ekran. **F11** ile değiştirilir; kiosk modu Yönetim → Sistem'den açılır. |
| Otomatik açılış | Varsayılan açık (`setLoginItemSettings`). Yönetim → Sistem'den kapatılabilir. |
| Kasiyer kazaları | Paketlenmiş sürümde sağ tık menüsü ve **Ctrl+R** (sayfa yenileme) kapalıdır. |
| Arayüz çökerse | Otomatik yeniden yüklenir; backend ve açık fiş etkilenmez. |
| Bağlantı kopması | Arayüzde kalıcı kırmızı şerit çıkar, bağlantı gelince kendiliğinden toparlanır. |

## 6. Barkod okuyucu (Perkon PS5700)

Okuyucu klavye gibi davranır. Arayüz tuşları **belge düzeyinde** yakalar:
kasiyerin bir kutuya tıklaması gerekmez. Bir metin kutusuna yazılıyorsa
(ürün arama, kalibrasyon) karışılmaz — orada da barkod okutmak çalışır.

Okumanın bittiği iki şekilde anlaşılır: **Enter** veya **140 ms sessizlik**.
Okuyucunun sonuna Enter (CR) eklediğinden emin olun.

## 7. İlk açılış akışı (temiz bilgisayar)

1. Installer çalıştırılır → **POS Kasa** kısayolu oluşur
2. Uygulama açılır → **İlk Kurulum**: mağaza adı, kasa kodu, yönetici hesabı
3. Uygulama kendini yeniden başlatır, giriş yapılır
4. **Donanım Kurulumu sihirbazı otomatik açılır** (aşağıda)
5. **Yönetim → Ürünler / Kasiyerler** → veriler girilir
6. **F10 → Kasa Aç** → satışa hazır

Hiçbir adımda terminal, Node kurulumu veya komut satırı gerekmez.

### 7.1 Donanım kurulum sihirbazı

Kurulumdan sonra yönetici ilk girişte otomatik olarak buraya yönlendirilir
(**Yönetim → Donanım Kurulumu**'ndan tekrar çalıştırılabilir). Üç adım:

| Adım | Ne yapar | Nasıl doğrulanır |
|---|---|---|
| **1. Barkod okuyucu** | Okuyucu klavye gibi bağlanır, sürücü gerekmez. Ekran açıkken herhangi bir barkod okutulur. | Okunan barkod ekranda görünür ve çözümlenir — **gerçek okuma testi**. Barkod gelmezse "Barkod okutamıyorum" ile Windows'taki HID cihazları listelenir ve seri (COM) port seçeneği sunulur. |
| **2. Fiş yazıcısı** | Windows'a kurulu yazıcılar listelenir (fiş yazıcısı olma ihtimali yüksek olanlar işaretlenir) + **ağda RAW 9100 taraması** (~250 adres, ~2 sn; ESC/POS durum sorgusuna yanıt verenler ayrıca işaretlenir). | Seçimden sonra **test fişi basılır**; kullanıcı "fiş çıktı mı?" sorusunu yanıtlar. USB yazıcı paylaşımda değilse uygulama paylaşıma açmayı dener, olmazsa elle yapılacak adımı söyler. |
| **3. Terazi barkodu** | **CAS CL3000 kasaya bağlanmaz** — etiket basar, kasa okur. Bu yüzden cihaz bağlantısı istenmez. | Yalnızca gerçek etiketle **barkod formatı kalibrasyonu** yapılır (bkz. [04](04-kurulum-ve-isletim.md#5-terazi-barkod-formatı--zorunlu-ilk-adım)). |

Bir adım tamamlanmadan da kurulum bitirilebilir (uyarı verilir) — mağaza yazıcı
gelmeden satışa başlayabilir.

**Kalıcılık:** Tüm seçimler `%APPDATA%\DagcihanPOS\config\pos.config.json`
içine yazılır ve sonraki açılışlarda **sorulmadan** kullanılır. Güncelleme bu
dosyaya dokunmaz; yeni sürümle gelen ayar anahtarları eklenir, mevcut değerler
korunur.

## 8. Yönetim ekranları

Hepsi mevcut backend'in `/api/admin/*` uçlarına bağlıdır; ayrı bir yönetim
sunucusu yoktur.

| Ekran | İçerik |
|---|---|
| Genel Bakış | Günün satışı, sistem durumu (DB, denetim zinciri, stok, fiş kuyruğu, okuyucu) |
| Ürünler | Ürün ekleme/düzenleme, fiyat, KDV, **barkod ve PLU yönetimi** |
| Stok | Mal kabul, fire, sayım, hareket geçmişi, defter-bakiye tutarlılık kontrolü ve onarım |
| Satışlar | Gün bazında fiş listesi, fiş detayı, **iade**, fiş tekrar basımı |
| Kasa | Oturum geçmişi, özet, X/Z raporu bastırma |
| Raporlar | Gün/aralık özeti, KDV dökümü, en çok satan ürünler |
| Kasiyerler | Kullanıcı oluşturma, rol, PIN değiştirme, aktif/pasif |
| Yazıcı | Bağlantı tipi, kod sayfası, test fişi, Türkçe karakter testi, fiş kuyruğu |
| Terazi Barkodu | **Kalibrasyon sihirbazı** (etiket okut → değerleri gir → çözümle → uygula), PLU dışa aktarım |
| Sistem | Mağaza/fiş bilgileri, Windows tercihleri, yedek al, klasörleri aç, tanılama |

Yetkiler role göredir: kasiyer yalnızca görüntüleme ekranlarını, müdür ürün/stok/yazıcı
ekranlarını, yönetici tümünü görür.

## 9. Sorun giderme

| Belirti | Yapılacak |
|---|---|
| Uygulama açılmıyor, hata kutusu çıkıyor | Mesajdaki dosyayı kontrol edin: genelde bozuk `config\pos.config.json`. Dosyayı silin; varsayılan yeniden kopyalanır (veritabanı etkilenmez). |
| "Terazi barkod formatı tanımlı değil" şeridi | Yönetim → Terazi Barkodu → kalibrasyon |
| Türkçe harfler fişte bozuk | Yönetim → Yazıcı → Türkçe Karakter Testi → doğru satırın değerini kod sayfasına yazın |
| Üstte "Yazıcı: N bekliyor" | Yazıcıyı kontrol edin; düzelince kuyruk kendiliğinden basar. Elle: Yönetim → Yazıcı → Yeniden Dene |
| İkinci kopya açılmıyor | Doğru davranış: tek örnek kilidi. Var olan pencere öne gelir. |
| Veri kayboldu sanılıyor | `%APPDATA%\DagcihanPOS\data\` klasörünü kontrol edin; yedekler `backups\` altındadır. |
| Ne olduğunu anlamak | `%APPDATA%\DagcihanPOS\logs\` (Yönetim → Sistem → Log Klasörünü Aç) |

## 10. Geliştirme komutları

```bash
npm run typecheck    # tip denetimi
npm test             # 198 test
npm run build        # TypeScript -> dist/ + varlıklar + simge
npm run desktop      # derle ve masaüstü uygulamasını aç
npm run dist:win     # Windows kurulum dosyası (Windows makinede)
npm run dist:dir     # paketleme yapılandırmasını doğrula (her platformda)
npm start            # yalnızca backend + tarayıcı arayüzü (Electron'suz)
node src/app/cli.ts  # yönetim komutları (kurulum, teşhis, bakım)
```
