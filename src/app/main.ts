/**
 * POS uygulamasinin giris noktasi.
 * Windows'ta acilista baslatilir; cokerse yeniden baslatildiginda kaldigi yerden devam eder.
 */
import { join } from 'node:path';
import { loadBarcodeConfig, loadPosConfig, PROJECT_ROOT } from '../config/load.ts';
import { PosApplication } from './pos.ts';
import { PosServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadPosConfig();
  const barcodeConfig = loadBarcodeConfig();
  const app = new PosApplication({ config, barcodeConfig });

  const report = app.start();
  console.log('='.repeat(60));
  console.log(`${config.store.name} - ${config.terminal.name}`);
  console.log('='.repeat(60));
  console.log(`Veritabani      : ${report.databasePath} (sema v${report.schemaVersion})`);
  console.log(`Butunluk        : ${report.integrityOk ? 'TAMAM' : 'SORUNLU'}`);
  console.log(`Acik fis        : ${report.openSaleRecovered ?? 'yok'}`);
  console.log(`Askidaki fis    : ${report.parkedSales}`);
  console.log(`Bekleyen fis    : ${report.pendingPrintJobs}`);
  console.log(`Kasa oturumu    : ${report.openCashSession ?? 'kapali'}`);
  console.log(`Tartili format  : ${report.weightedFormatConfirmed ? 'tanimli' : 'TANIMSIZ'}`);
  for (const warning of report.warnings) console.log(`  ! ${warning}`);

  await app.startDevices();

  const server = new PosServer(app, { uiRoot: join(PROJECT_ROOT, 'ui') });
  const port = await server.listen();
  console.log(`\nArayuz          : http://${config.server.host}:${port}`);
  console.log('Kapatmak icin Ctrl+C\n');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} alindi, kapatiliyor...`);
    await server.close();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Beklenmeyen hata uygulamayi dusurmemeli: satis verisi diskte, surec ayakta kalmali
  process.on('uncaughtException', (error) => {
    console.error('[BEKLENMEYEN HATA]', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[ISLENMEYEN RET]', reason);
  });
}

await main();
