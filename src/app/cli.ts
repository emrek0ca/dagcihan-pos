/**
 * Yonetim komutlari. Magazada kurulum, teshis ve bakim icin kullanilir.
 *   node src/app/cli.ts <komut> [...]
 */
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadBarcodeConfig, loadPosConfig, PROJECT_ROOT } from '../config/load.ts';
import { PosApplication } from './pos.ts';
import { analyzeSamples, type BarcodeSample } from '../core/barcode/analyzer.ts';
import { verifyAuditChain } from '../modules/audit/audit.ts';
import { renderCodePageTest, renderReceipt } from '../modules/printing/render.ts';
import { escPosToPlainText } from '../modules/printing/preview.ts';
import { backupDatabase as backupDb } from './backup.ts';
import { CODE_PAGE_CANDIDATES } from '../hardware/printer/encoding.ts';
import { formatMoney, money, parseMoney, percent } from '../core/money/money.ts';
import { parseQuantity } from '../core/quantity/quantity.ts';
import type { Role } from '../modules/users/users.ts';
import type { ScalePluItem } from '../hardware/ports.ts';

function open(): PosApplication {
  const app = new PosApplication({
    config: loadPosConfig(),
    barcodeConfig: loadBarcodeConfig(),
  });
  return app;
}

function usage(): void {
  console.log(`
POS yonetim komutlari

  db check                          Veritabani butunlugu ve sema surumu
  db stats                          Ozet sayilar
  db backup                         Veritabaninin yedegini al
  db reset --confirm                Veriyi arsivleyip SIFIRDAN basla (canliya gecmeden once)

  user add <kadi> <ad> <pin> <rol>  Kullanici olustur (rol: CASHIER|MANAGER|ADMIN)
  user list                         Kullanicilari listele

  product add <kod> <ad> <EACH|KG> <fiyat> [kdv%] [--plu=N] [--barcode=X] [--stok=N]
  product import <dosya.csv>        CSV'den toplu urun yukle
  product list [arama]

  barcode try <kod>                 Bir barkodu cozumlemeyi dene (teshis)
  barcode analyze [--plu-list]      Cozumlenemeyen okumalardan format cikar
  barcode samples                   Kaydedilmis cozumlenemeyen okumalari listele
  barcode apply <aday-id>           Bulunan adayi config'e yaz ve etkinlestir

  printer preview <fisId>           Fisi ekranda onizle (kagit harcamadan)
  printer test                      Yaziciya test fisi bas
  printer codepage                  Turkce karakter kod sayfasi test sayfasi
  printer queue                     Fis kuyrugu durumu
  printer retry                     Basarisiz fisleri yeniden dene

  scale export                      Terazi icin PLU dosyasi uret

  sync enroll <sunucuUrl> <kod>     Kasayi merkezi sunucuya kaydet
  sync push-catalog <eposta>        Yerel urunleri merkezi katalogla esitle (ilk kurulum)
  sync reconcile-stock              Merkezi stok bakiyesini yerel ile hizala (fark gonderir)
  sync status                       Senkronizasyon durumu
  sync now                          Simdi senkronize et
  sync retry                        Olu olaylari yeniden kuyruga al

  inventory verify | rebuild        Stok defteri ile bakiye karsilastirma/onarim
  audit verify                      Denetim zinciri dogrulama
  report session [oturumId]         Kasa oturumu ozeti
`);
}

async function run(argv: string[]): Promise<void> {
  const [group, command, ...rest] = argv;
  const flags = new Map<string, string>();
  const args: string[] = [];
  for (const item of rest) {
    if (item.startsWith('--')) {
      const [key, value = 'true'] = item.slice(2).split('=');
      flags.set(key!, value);
    } else {
      args.push(item);
    }
  }

  if (group === undefined || group === 'help' || group === '--help') {
    usage();
    return;
  }

  const app = open();
  try {
    switch (`${group} ${command ?? ''}`.trim()) {
      case 'db check': {
        const integrity = app.db.integrityCheck();
        const version = app.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
        console.log(`Sema surumu : ${version}`);
        console.log(`Butunluk    : ${integrity.ok ? 'TAMAM' : 'SORUNLU'}`);
        for (const problem of integrity.problems) console.log(`  - ${problem}`);
        break;
      }

      case 'db stats': {
        const tables = ['products', 'sales', 'sale_items', 'payments', 'stock_movements',
          'audit_events', 'scan_log', 'print_jobs'];
        for (const table of tables) {
          const n = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
          console.log(`${table.padEnd(18)}: ${n}`);
        }
        break;
      }

      case 'db backup': {
        const target = backupDb(app.db, { backupDir: app.config.database.backupDir }).file;
        console.log(`Yedek alindi: ${target}`);
        break;
      }

      case 'db reset': {
        if (!flags.has('confirm')) {
          console.error('Bu komut TUM satis, stok ve denetim kayitlarini arsivler.');
          console.error('Emin iseniz: db reset --confirm');
          process.exitCode = 1;
          break;
        }
        const archived = backupDb(app.db, {
          backupDir: app.config.database.backupDir, prefix: 'arsiv',
        }).file;
        app.db.close();
        for (const suffix of ['', '-wal', '-shm']) {
          rmSync(`${app.config.database.path}${suffix}`, { force: true });
        }
        console.log(`Onceki veri arsivlendi: ${archived}`);
        console.log('Veritabani sifirlandi. Yeni kullanici ve urunleri yukleyin.');
        return;
      }

      case 'user add': {
        const [username, displayName, pin, role] = args;
        if (!username || !displayName || !pin || !role) {
          console.error('Kullanim: user add <kadi> <ad> <pin> <CASHIER|MANAGER|ADMIN>');
          process.exitCode = 1;
          break;
        }
        const user = app.users.create({
          username, displayName, pin, role: role.toUpperCase() as Role,
        });
        console.log(`Olusturuldu: #${user.id} ${user.username} (${user.role})`);
        break;
      }

      case 'user list': {
        for (const user of app.users.list()) {
          console.log(`#${user.id}\t${user.username}\t${user.displayName}\t${user.role}\t${user.active ? 'aktif' : 'pasif'}`);
        }
        break;
      }

      case 'product add': {
        const [code, name, unit, price, tax] = args;
        if (!code || !name || !unit || !price) {
          console.error('Kullanim: product add <kod> <ad> <EACH|KG> <fiyat> [kdv%] [--plu=N] [--barcode=X] [--stok=N]');
          process.exitCode = 1;
          break;
        }
        const product = app.products.create({
          code, name,
          unit: unit.toUpperCase() === 'KG' ? 'KG' : 'EACH',
          unitPrice: parseMoney(price),
          taxRateBp: percent(Number(tax ?? 1)),
          ...(flags.has('stok') ? { stockQty: parseQuantity(flags.get('stok')!) } : {}),
          ...(flags.has('plu') ? { plus: [Number(flags.get('plu'))] } : {}),
          ...(flags.has('barcode') ? { barcodes: [flags.get('barcode')!] } : {}),
        });
        console.log(`Olusturuldu: #${product.id} ${product.name} ${formatMoney(product.unitPrice)}`);
        break;
      }

      case 'product import': {
        const [file] = args;
        if (!file) {
          console.error('Kullanim: product import <dosya.csv>');
          console.error('Sutunlar: kod,ad,birim(EACH|KG),fiyat,kdv,plu,barkod,stok');
          process.exitCode = 1;
          break;
        }
        const text = readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
        let created = 0;
        let failed = 0;
        app.db.tx(() => {
          for (const [index, line] of lines.entries()) {
            if (index === 0 && /kod|code/i.test(line)) continue;
            const [code, name, unit, price, tax, plu, barcode, stock] = line.split(/[;,]/).map((c) => c.trim());
            if (!code || !name) {
              failed++;
              continue;
            }
            try {
              app.products.create({
                code, name,
                unit: (unit ?? 'EACH').toUpperCase() === 'KG' ? 'KG' : 'EACH',
                unitPrice: parseMoney(price ?? '0'),
                taxRateBp: percent(Number(tax ?? 1)),
                ...(stock ? { stockQty: parseQuantity(stock) } : {}),
                ...(plu ? { plus: [Number(plu)] } : {}),
                ...(barcode ? { barcodes: [barcode] } : {}),
              });
              created++;
            } catch (error) {
              failed++;
              console.error(`  satir ${index + 1}: ${(error as Error).message}`);
            }
          }
        });
        console.log(`Yuklendi: ${created}, hatali: ${failed}`);
        break;
      }

      case 'product list': {
        const term = args[0];
        const products = term === undefined ? app.products.list({ limit: 100 }) : app.products.search(term);
        for (const p of products) {
          const plus = app.products.pluListFor(p.id);
          console.log(
            `#${p.id}\t${p.code}\t${p.name.padEnd(24)}\t${p.unit}\t${formatMoney(p.unitPrice).padStart(10)}` +
            `\tPLU:${plus.join('/') || '-'}\tstok:${p.stockQty / 1000}`,
          );
        }
        break;
      }

      case 'barcode try': {
        const [code] = args;
        if (!code) {
          console.error('Kullanim: barcode try <kod>');
          process.exitCode = 1;
          break;
        }
        const parsed = app.resolver.parser.parse(code);
        console.log('Cozumleme:', JSON.stringify(parsed, null, 2));
        try {
          const item = app.resolver.resolve(code, { terminalId: app.terminalId });
          console.log(`\nURUN     : ${item.product.name}`);
          console.log(`MIKTAR   : ${item.quantity / 1000}`);
          console.log(`B.FIYAT  : ${formatMoney(item.unitPrice)}`);
          console.log(`TUTAR    : ${formatMoney(item.fixedGross ?? money(Math.round(item.quantity * item.unitPrice / 1000)))}`);
          console.log(`KAYNAK   : ${item.priceSource}`);
        } catch (error) {
          console.log(`\nURUNE BAGLANAMADI: ${(error as Error).message}`);
        }
        break;
      }

      case 'barcode samples': {
        const rows = app.db.all<{ raw: string; n: number; last: number; result: string }>(
          `SELECT raw, COUNT(*) AS n, MAX(at) AS last, result FROM scan_log
            WHERE result IN ('UNKNOWN','INVALID') GROUP BY raw ORDER BY n DESC LIMIT 100`,
        );
        if (rows.length === 0) {
          console.log('Cozumlenemeyen okuma kaydi yok.');
          break;
        }
        for (const row of rows) {
          console.log(`${row.raw}\t${row.result}\tx${row.n}\t${new Date(row.last).toLocaleString('tr-TR')}`);
        }
        break;
      }

      case 'barcode analyze': {
        const rows = app.db.all<{ raw: string }>(
          `SELECT DISTINCT raw FROM scan_log WHERE result IN ('UNKNOWN','INVALID')
            AND raw GLOB '[0-9]*' ORDER BY at DESC LIMIT 500`,
        );
        const extra = flags.get('code');
        const samples: BarcodeSample[] = rows.map((r) => ({ raw: r.raw }));
        if (extra !== undefined) {
          samples.push({
            raw: extra,
            ...(flags.has('kg') ? { knownWeightMilli: parseQuantity(flags.get('kg')!) } : {}),
            ...(flags.has('tl') ? { knownPriceKurus: parseMoney(flags.get('tl')!) } : {}),
            ...(flags.has('plu') ? { knownPlu: Number(flags.get('plu')) } : {}),
          });
        }
        if (samples.length === 0) {
          console.log('Analiz edilecek ornek yok. Once teraziden bir etiket okutun,');
          console.log('veya: barcode analyze --code=<barkod> --kg=0,750 --plu=231');
          break;
        }
        const candidates = analyzeSamples(samples, { knownPlus: app.products.allPlus() });
        if (candidates.length === 0) {
          console.log('Aday format bulunamadi.');
          break;
        }
        console.log(`${samples.length} ornek incelendi. En iyi adaylar:\n`);
        for (const [i, candidate] of candidates.slice(0, 5).entries()) {
          console.log(`[${i}] ${candidate.rule.id}  guven=${candidate.confidence}  puan=${candidate.score}`);
          console.log(`    ${candidate.rule.description}`);
          console.log(`    PLU eslesme: ${candidate.evidence.pluMatches}/${candidate.evidence.samplesTotal}` +
            `, deger araligi: ${candidate.evidence.valueInRange}/${candidate.evidence.samplesTotal}`);
          for (const note of candidate.evidence.notes) console.log(`    ! ${note}`);
          const sample = candidate.decoded[0];
          if (sample !== undefined) {
            console.log(`    ornek: ${sample.raw} -> kod=${sample.itemCode} deger=${sample.value} (${sample.valueKind})`);
          }
          console.log();
        }
        writeFileSync(
          join(PROJECT_ROOT, 'config', 'barcode-candidates.json'),
          JSON.stringify(candidates.slice(0, 10).map((c) => c.rule), null, 2),
        );
        console.log('Adaylar config/barcode-candidates.json dosyasina yazildi.');
        console.log('Dogru adayi etkinlestirmek icin: barcode apply <index>');
        break;
      }

      case 'barcode apply': {
        const index = Number(args[0] ?? -1);
        const file = join(PROJECT_ROOT, 'config', 'barcode-candidates.json');
        const candidates = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
        const chosen = candidates[index];
        if (chosen === undefined) {
          console.error(`Gecersiz aday indeksi: ${index}`);
          process.exitCode = 1;
          break;
        }
        const configFile = join(PROJECT_ROOT, 'config', 'barcode-rules.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
          rules: { id: string }[]; weightedFormatConfirmed: boolean;
        };
        const rule = { ...(chosen as Record<string, unknown>), enabled: true, priority: 1 } as
          unknown as Record<string, unknown> & { id: string };
        config.rules = [rule as never, ...config.rules.filter((r) => r.id !== rule.id)];
        config.weightedFormatConfirmed = true;
        writeFileSync(configFile, JSON.stringify(config, null, 2));
        console.log(`Kural etkinlestirildi: ${rule.id}`);
        console.log('POS yeniden baslatilmali.');
        break;
      }

      case 'printer preview': {
        const saleId = Number(args[0] ?? 0);
        const sale = app.sales.view(saleId);
        const doc = app.previewDocument(saleId, 'RECEIPT');
        const bytes = renderReceipt(doc, {
          codePage: 'ASCII',
          codePageIndex: 0,
          charactersPerLine: app.config.devices.printer.charactersPerLine,
        });
        console.log(escPosToPlainText(bytes));
        console.log(`(${bytes.length} bayt ESC/POS · fis ${sale.receiptSeries ?? ''}${sale.receiptNo ?? '-'})`);
        break;
      }

      case 'printer test': {
        const doc = {
          kind: 'TEST' as const,
          storeName: app.config.store.name,
          storeLines: app.config.store.addressLines,
          title: 'YAZICI TEST FISI',
          meta: [
            { label: 'Tarih', value: new Date().toLocaleString('tr-TR') },
            { label: 'Kasa', value: app.config.terminal.name },
            { label: 'Yazici', value: app.devices.printer.name },
          ],
          lines: [
            { name: 'Turkce test: sigla ÇÖĞÜŞİ', detail: '1,000 kg x 100,00', amount: '100,00' },
            { name: 'Ikinci satir', detail: '', amount: '9,90' },
          ],
          totals: [{ label: 'TOPLAM', value: '109,90', emphasize: true }],
          taxRows: [{ label: 'KDV %1', base: '108,81', tax: '1,09' }],
          payments: [{ label: 'NAKIT', value: '110,00' }],
          footer: ['Test tamamlandi'],
          copy: false,
        };
        app.printQueue.enqueueDocument(doc);
        const printed = await app.printQueue.processDue();
        console.log(printed > 0 ? 'Test fisi basildi.' : 'Basilamadi, kuyrukta bekliyor:');
        for (const job of app.printQueue.pending()) {
          console.log(`  is #${job.id} ${job.status} deneme=${job.attempts} hata=${job.lastError ?? '-'}`);
        }
        break;
      }

      case 'printer codepage': {
        const bytes = renderCodePageTest(
          CODE_PAGE_CANDIDATES, app.config.devices.printer.charactersPerLine,
        );
        await app.devices.printer.write(bytes);
        console.log('Kod sayfasi test sayfasi gonderildi.');
        console.log('Turkce harflerin dogru ciktigi satirin indeksini not edin ve');
        console.log('config/pos.config.json -> devices.printer.codePage alanina yazin.');
        console.log('Ornek: "CP857:15" veya "CP1254:25"');
        break;
      }

      case 'printer queue': {
        const jobs = app.printQueue.pending();
        console.log(`Bekleyen: ${app.printQueue.pendingCount()}, basarisiz: ${app.printQueue.failedCount()}`);
        for (const job of jobs) {
          console.log(`  #${job.id}\t${job.kind}\t${job.status}\tdeneme=${job.attempts}\t${job.lastError ?? ''}`);
        }
        break;
      }

      case 'printer retry': {
        const count = app.printQueue.retryFailed();
        const printed = await app.printQueue.processDue(50);
        console.log(`${count} is yeniden kuyruga alindi, ${printed} tanesi basildi.`);
        break;
      }

      case 'scale export': {
        const items: ScalePluItem[] = [];
        for (const product of app.products.list({ activeOnly: true, limit: 10000 })) {
          for (const plu of app.products.pluListFor(product.id)) {
            items.push({
              plu,
              name: product.name,
              unitPrice: product.unitPrice,
              unit: product.unit,
              departmentNo: app.config.devices.scale.departmentNo,
              taxRateBp: product.taxRateBp,
            });
          }
        }
        const result = await app.devices.scale.syncItems(items);
        console.log(`${result.sent} PLU gonderildi, ${result.failed} basarisiz.`);
        console.log(result.detail);
        break;
      }

      case 'sync enroll': {
        const [serverUrl, code] = args;
        if (!serverUrl || !code) {
          console.error('Kullanim: sync enroll <https://sunucu> <AKTIVASYON-KODU>');
          process.exitCode = 1;
          break;
        }
        const result = await app.sync.enroll({
          serverUrl,
          enrollmentCode: code,
          terminalCode: flags.get('terminal') ?? app.config.terminal.code,
          name: app.config.terminal.name,
        });
        console.log(`Kasa kaydedildi: ${result.storeName} (terminal ${result.terminalId})`);
        console.log('Ilk senkronizasyon baslatiliyor...');
        const status = await app.sync.runOnce();
        console.log(`Durum: ${status.state} · bekleyen ${status.pending} · imlec ${status.pullCursor}`);
        break;
      }

      case 'sync push-catalog': {
        const [email] = args;
        const password = flags.get('password') ?? process.env.POS_ADMIN_PASSWORD;
        const credentials = new (await import('../modules/sync/credentials.ts')).CredentialStore(
          join(app.config.database.path, '..', 'sync-credentials.json'),
        ).read();
        if (!email || !password || credentials === null) {
          console.error('Kullanim: sync push-catalog <eposta> --password=<parola>');
          console.error('(Kasa once "sync enroll" ile kaydedilmis olmali)');
          process.exitCode = 1;
          break;
        }
        const { SyncClient } = await import('../modules/sync/client.ts');
        const client = new SyncClient({ baseUrl: credentials.serverUrl });
        const login = await client.loginUser(email, password);
        client.setToken(login.token);

        let created = 0;
        let failed = 0;
        for (const product of app.products.list({ limit: 20000 })) {
          try {
            await client.upsertProduct({
              code: product.code,
              name: product.name,
              unit: product.unit,
              unitPrice: product.unitPrice,
              taxRateBp: product.taxRateBp,
              trackStock: product.trackStock,
              barcodes: app.products.barcodesFor(product.id),
              plus: app.products.pluListFor(product.id),
            });
            created++;
          } catch (error) {
            failed++;
            console.error(`  ${product.code}: ${(error as Error).message}`);
          }
        }
        console.log(`Merkezi kataloga yazildi: ${created}, hatali: ${failed}`);
        console.log('Simdi "sync now" ile merkezi surumu geri cekin.');
        break;
      }

      case 'sync reconcile-stock': {
        const balances = app.products.list({ limit: 20000 })
          .filter((p) => p.trackStock)
          .map((p) => ({ code: p.code, quantity: p.stockQty as number }));
        const result = await app.sync.reconcileStock(balances);
        console.log(`${result.adjusted} urunde fark bulundu, ${result.alreadyInSync} urun zaten esit.`);
        const status = await app.sync.runOnce();
        console.log(`Durum: ${status.state} · bekleyen ${status.pending}`);
        break;
      }

      case 'sync status': {
        const status = app.sync.status();
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      case 'sync now': {
        const status = await app.sync.runOnce();
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      case 'sync retry': {
        console.log(`${app.sync.retryFailed()} olay yeniden kuyruga alindi.`);
        const status = await app.sync.runOnce();
        console.log(`Durum: ${status.state} · bekleyen ${status.pending}`);
        break;
      }

      case 'inventory verify': {
        const result = app.inventory.verify();
        console.log(result.ok ? 'Stok tutarli.' : `${result.mismatches.length} tutarsizlik:`);
        for (const m of result.mismatches) {
          console.log(`  ${m.name}: kayitli=${m.stored / 1000} defter=${m.computed / 1000}`);
        }
        break;
      }

      case 'inventory rebuild': {
        const changed = app.inventory.rebuild();
        console.log(`${changed} urun bakiyesi hareket defterinden yeniden kuruldu.`);
        break;
      }

      case 'audit verify': {
        const result = verifyAuditChain(app.db);
        console.log(result.message);
        if (!result.ok) process.exitCode = 1;
        break;
      }

      case 'report session': {
        const sessionId = args[0] !== undefined
          ? Number(args[0])
          : app.cashRegister.current(app.terminalId)?.id;
        if (sessionId === undefined) {
          console.log('Acik kasa oturumu yok. Oturum id verin: report session <id>');
          break;
        }
        const s = app.cashRegister.summary(sessionId);
        console.log(`Oturum #${s.session.id} (${s.session.businessDate}) - ${s.session.status}`);
        console.log(`  Acilis devri  : ${formatMoney(s.session.openingFloat)}`);
        console.log(`  Fis / Toplam  : ${s.salesCount} / ${formatMoney(s.salesTotal)}`);
        console.log(`  Iade / Toplam : ${s.refundCount} / ${formatMoney(s.refundTotal)}`);
        console.log(`  Nakit satis   : ${formatMoney(s.cashSales)}`);
        console.log(`  Kart satis    : ${formatMoney(s.cardSales)}`);
        console.log(`  Kasa giris    : ${formatMoney(s.paidIn)}`);
        console.log(`  Kasa cikis    : ${formatMoney(s.paidOut)}`);
        console.log(`  Beklenen nakit: ${formatMoney(s.expectedCash)}`);
        for (const t of s.taxBreakdown) {
          console.log(`  KDV %${t.rateBp / 100}: matrah ${formatMoney((t.net - t.tax) as never)} vergi ${formatMoney(t.tax)}`);
        }
        break;
      }

      default:
        usage();
        process.exitCode = 1;
    }
  } finally {
    app.db.close();
  }
}

await run(process.argv.slice(2));


