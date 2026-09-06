# Aşama 2 — Mimari

## 1. Teknoloji seçimi ve gerekçesi

| Katman | Seçim | Gerekçe |
|---|---|---|
| Dil | TypeScript (strict) | Tipli, test edilebilir; Node 24+ `.ts` dosyalarını doğrudan çalıştırır, build adımı zorunlu değil |
| Çalışma ortamı | Node.js 24+ (Windows'a sabitlenmiş runtime ile dağıtılır) | Kasa bilgisayarına derleme aracı (MSVC/node-gyp) kurulmaz |
| Veritabanı | **`node:sqlite`** (Node'un yerleşik SQLite'ı, WAL) | Yerel, tek dosya, transaction-safe, **native bağımlılık yok**, ayrı servis yok |
| Taşıma (UI↔çekirdek) | `node:http` + SSE (Server-Sent Events) | Ek framework yok; sunucu→UI anlık olay itmesi (barkod, yazıcı durumu) için yeterli |
| Test | `node:test` + `node:assert` | Yerleşik, ek bağımlılık yok |
| UI (Aşama 7) | Aynı süreç tarafından servis edilen yerel web arayüzü, Edge kiosk modunda tam ekran | Windows'ta zaten kurulu; Electron paketleme ileride mümkün, çekirdek değişmez |

**Runtime bağımlılık sayısı: 0.** `package.json` içinde yalnızca dev bağımlılığı olarak
`typescript` ve `@types/node` bulunur. Bu, mağaza kasasında kırılma yüzeyini en aza indirir.

> Not: `node:sqlite` Node 22'de bayrak ister, 24+'ta bayraksız çalışır. Dağıtımda Node sürümü
> uygulama ile birlikte sabitlenir (`engines` + taşınabilir runtime).

## 2. Katmanlar

```
┌─────────────────────────────────────────────────────────┐
│ ui/                Aşama 7 — yerel web arayüzü          │  ← en son
├─────────────────────────────────────────────────────────┤
│ app/               kompozisyon kökü, HTTP+SSE API, CLI   │
├─────────────────────────────────────────────────────────┤
│ modules/           uygulama servisleri (use-case)        │
│   products inventory sales payments cash-register        │
│   users reports printing scale scanner                   │
├─────────────────────────────────────────────────────────┤
│ core/              SAF iş mantığı — I/O YOK              │
│   money quantity barcode pricing sale                    │
├─────────────────────────────────────────────────────────┤
│ data/              SQLite, migration, repository, UoW    │
├─────────────────────────────────────────────────────────┤
│ hardware/          adapter'lar (port arayüzlerinin impl.) │
│   scanner/{hid-wedge,serial,tcp,simulator}               │
│   printer/{escpos, tcp9100, windows-share, serial, file} │
│   scale/{cas-cl3000, csv-export, simulator}              │
└─────────────────────────────────────────────────────────┘
```

**Bağımlılık yönü tek yönlüdür:** `hardware → (port arayüzü) ← modules → core`.
`core` hiçbir şeye bağlı değildir ve I/O yapmaz; bu yüzden tamamı deterministik test edilebilir.
`modules` yalnızca **port arayüzlerini** bilir, somut cihazı bilmez.

## 3. Donanım port arayüzleri (`src/hardware/ports.ts`)

```ts
interface ScannerPort  { start(): Promise<void>; stop(): Promise<void>;
                         onScan(cb: (e: ScanEvent) => void): void;
                         onStatus(cb: (s: DeviceStatus) => void): void; }

interface PrinterPort  { status(): Promise<PrinterStatus>;
                         write(bytes: Uint8Array): Promise<void>;
                         describe(): string; }

interface ScalePort    { syncItems(items: ScalePluItem[]): Promise<SyncResult>;
                         status(): Promise<DeviceStatus>; }
```

Cihaz değişirse yalnızca `hardware/` altında yeni bir adapter yazılır; `modules` ve `core`
dosyalarına dokunulmaz. Adapter seçimi `config/devices.json` ile yapılır (fabrika deseni).

**Simülatörler yalnızca test ve mağaza öncesi provada kullanılır**; üretim konfigürasyonunda
seçilirse uygulama açılışta yüksek sesle uyarır ve fişe `SIMULATOR` damgası basar
(sahte fişin gerçek sanılmasını önlemek için).

## 4. Modül sorumlulukları

| Modül | Sorumluluk | Sorumlu OLMADIĞI |
|---|---|---|
| `barcode` (core) | Ham dizi → `ResolvedScan` | Ürün araması, DB |
| `scanner` | Cihazdan olay alma, sıraya koyma, debounce | Barkod anlamı |
| `products` | Ürün/PLU/barkod CRUD, arama, fiyat | Stok düşme |
| `inventory` | Stok hareketleri, sayım, tutarlılık | Fiyat |
| `sales` | Satış yaşam döngüsü, satır işlemleri, tamamlama | Ödeme aracı detayı |
| `payments` | Ödeme satırları, para üstü, ödeme tipleri | Kasa devri |
| `cash-register` | Kasa oturumu, giriş/çıkış, Z raporu | Satış hesabı |
| `users` | Kasiyer, PIN, rol, yetki kontrolü | UI |
| `printing` | Fiş belgesi üretimi, ESC/POS, kuyruk, tekrar basma | Satış kuralları |
| `scale` | CL3000 PLU senkronu / dışa aktarım | Tartma |
| `reports` | X/Z raporu, satış özeti, denetim doğrulama | Yazma işlemleri |

## 5. Veri erişimi

- Tek `Database` örneği (`node:sqlite`, `journal_mode=WAL`, `synchronous=FULL`,
  `foreign_keys=ON`, `busy_timeout=5000`).
- **Unit of Work:** `db.tx(fn)` → `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`. İç içe çağrılarda
  SAVEPOINT kullanılır. Yazan tüm servisler transaction içinde çalışır.
- Repository'ler hazır (prepared) ifadeleri önceden derler; sıcak yol (barkod → ürün) tek
  indeksli sorgudur.
- Migration'lar `data/migrations/NNN-*.sql`, `PRAGMA user_version` ile sıralı ve tek yönlü.

## 6. Hata modeli

`PosError { code, message, severity, details, userMessage }` — `code` sabit bir enum
(`PLU_NOT_FOUND`, `TOTAL_MISMATCH`, `PRINTER_OFFLINE`, …). UI kodu gösterir, `userMessage`
Türkçe ve kasiyere yöneliktir. Beklenmeyen istisnalar loglanır, satış durumunu bozmaz.

## 7. Süreç modeli

Tek Node süreci:
- HTTP+SSE sunucusu (yalnızca `127.0.0.1`'e bağlanır — dışarıdan erişim yok)
- Barkod okuyucu dinleyicisi
- Yazıcı kuyruğu worker'ı (zamanlayıcı)
- Terazi senkron görevi (elle tetiklenir veya zamanlanır)

Windows'ta açılışta başlar (Task Scheduler / servis sarmalayıcı), çökerse yeniden başlatılır;
`OPEN` satış diskte olduğu için kasiyer kaldığı yerden devam eder.
