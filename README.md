# DAĞCIHAN POS

Kuruyemiş/market mağazası için **Windows masaüstü satış noktası (POS) uygulaması**.
Mevcut lisanslı POS yazılımının yerine geçer; **donanım değişmez**.

- CAS CL3000 etiket yazıcılı terazi (tartılı barkod)
- Perkon PS5700 barkod okuyucu
- Xprinter XP-Q805K ESC/POS fiş yazıcısı
- Windows kasa bilgisayarı

İnternet gerekmez. Tüm satış, stok ve kasa işlemleri mağaza içinde, yerel olarak çalışır.

## Kurulum (mağaza)

`Dagcihan-POS-Kurulum-x.y.z.exe` çalıştırılır → **POS Kasa** kısayolu açılır →
uygulama ilk açılışta yönetici hesabı ister. Terminal, Node kurulumu veya komut
satırı gerekmez.

Ayrıntı: [docs/05-windows-uygulamasi.md](docs/05-windows-uygulamasi.md)

## Geliştirme

```bash
npm ci
npm test          # 198 test
npm run desktop   # masaüstü uygulamasını derleyip aç
npm run dist:win  # Windows kurulum dosyası (Windows makinede)
```

## Belgeler

| Belge | İçerik |
|---|---|
| [01 — Analiz ve algoritma](docs/01-analiz-ve-algoritma.md) | Satış akışı, algoritmalar, arıza senaryoları |
| [02 — Mimari](docs/02-mimari.md) | Katmanlar, modüller, donanım soyutlaması |
| [03 — Teknik rapor](docs/03-teknik-rapor.md) | Doğrulama raporu ve bilinen eksikler |
| [04 — Kurulum ve işletim](docs/04-kurulum-ve-isletim.md) | Donanım ayarları, günlük kullanım, kalibrasyon |
| [05 — Windows uygulaması](docs/05-windows-uygulamasi.md) | Masaüstü mimarisi, installer, güncelleme, yönetim ekranları |
| [server/DEPLOYMENT.md](server/DEPLOYMENT.md) | Merkezi backend (VPS) kurulumu, yedekleme, güncelleme |
| [server/SYNC.md](server/SYNC.md) | Offline-first senkronizasyon tasarımı ve çakışma politikası |

## Mimari

```
Windows POS (Electron + SQLite)          VPS (Node + PostgreSQL 16)
  yerel satış, stok, kasa, fiş     ⇄     merkezi katalog, fiyat, stok defteri,
  transactional outbox                   satış arşivi, sipariş modeli
        │                                        │
        └── internet YOKKEN de çalışır           └── gelecekteki e-ticaret /
            (VPS kritik yolda değil)                 sipariş uygulaması buraya bağlanır
```

## Tasarım ilkeleri

1. **Satış kaybolmaz.** Her değişiklik diske yazılır; çökme sonrası açık fiş geri gelir.
2. **Yanlış fiyat hesaplanmaz.** Para tam sayı kuruştur; tartılı barkod formatı
   doğrulanmadan tahminle satış yapılmaz.
3. **Donanım arızası satışı durdurmaz.** Yazıcı kapalıysa fiş kuyruğa alınır.
4. **Her şey denetlenebilir.** Append-only olay kaydı ve hash zinciri.
5. **Güncelleme veriyi silmez.** Veritabanı ve ayarlar kullanıcı klasöründe durur.
6. **Bağlılık yok.** POS'un sıfır runtime bağımlılığı var; SQLite Node'un içinden gelir.
7. **Merkez zorunlu değil.** VPS kapalıyken mağaza satış yapmaya devam eder;
   kayıtlar kuyrukta bekler ve bağlantı gelince kendiliğinden gider.

## Yığın

TypeScript (strict) · Electron 44 (Node 24) · `node:sqlite` (WAL, `synchronous=FULL`) ·
`node:http` + SSE · `node:test`. **Runtime bağımlılığı: 0.**
