/**
 * Test kosum ortami: gercek sema, gercek servisler, deterministik saat,
 * bellek disi (dosya) veritabani -> cokme/yeniden acilis senaryolari gercekci.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../src/core/clock.ts';
import { PosApplication } from '../../src/app/pos.ts';
import { NullTransport } from '../../src/hardware/printer/transports.ts';
import { SimulatorScanner } from '../../src/hardware/scanner/adapters.ts';
import { SimulatorScale } from '../../src/hardware/scale/adapters.ts';
import type { BarcodeConfigFile, PosConfig } from '../../src/config/types.ts';
import type { WeightedBarcodeRule } from '../../src/core/barcode/types.ts';
import { percent } from '../../src/core/money/money.ts';

export const TEST_WEIGHT_RULE: WeightedBarcodeRule = {
  id: 'test-weight',
  enabled: true,
  priority: 10,
  length: 13,
  match: { type: 'prefix', value: '27' },
  checkDigit: { algorithm: 'EAN13' },
  fields: {
    itemCode: { offset: 2, length: 5, lookup: 'PLU', stripLeadingZeros: true },
    value: { offset: 7, length: 5, scale: 3, kind: 'WEIGHT_KG' },
  },
};

export const TEST_PRICE_RULE: WeightedBarcodeRule = {
  id: 'test-price',
  enabled: true,
  priority: 11,
  length: 13,
  match: { type: 'prefix', value: '28' },
  checkDigit: { algorithm: 'EAN13' },
  fields: {
    itemCode: { offset: 2, length: 5, lookup: 'PLU', stripLeadingZeros: true },
    value: { offset: 7, length: 5, scale: 2, kind: 'PRICE' },
  },
};

export function testPosConfig(overrides: Partial<PosConfig> = {}): PosConfig {
  return {
    store: {
      name: 'TEST MARKET',
      addressLines: ['Test Mahallesi No 1'],
      phone: '0000',
      taxOffice: 'Test',
      taxNumber: '1234567890',
      receiptFooter: ['Tesekkurler'],
    },
    terminal: { code: 'KASA-TEST', name: 'Test Kasa' },
    sales: {
      receiptSeries: 'T',
      defaultTaxRateBp: percent(1),
      cashRounding: 'NONE',
      maxLineAmountKurus: 500000,
      blockNegativeStock: false,
      weightedOnNonKgProduct: 'REJECT',
      scanDedupeWindowMs: 120,
      priceMismatchTolerancePercent: 0,
    },
    permissions: {
      maxDiscountPercentWithoutApproval: 10,
      voidLineRequiresApproval: false,
      voidSaleRequiresApproval: true,
      refundRequiresApproval: true,
      blindRefundAllowed: false,
      priceOverrideRequiresApproval: true,
    },
    devices: {
      scanner: {
        adapter: 'SIMULATOR',
        serial: { port: '', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
        tcp: { host: '', port: 0 },
        terminatorChars: ['\r', '\n'],
        interCharTimeoutMs: 60,
      },
      printer: {
        adapter: 'NULL',
        share: '',
        tcp: { host: '', port: 0 },
        serial: { port: '', baudRate: 9600 },
        file: { path: '' },
        codePage: 'CP857',
        charactersPerLine: 48,
        cutAfterReceipt: true,
        openDrawerOnCash: true,
        retryDelaysMs: [10, 20, 30],
        maxAttempts: 3,
      },
      scale: {
        adapter: 'SIMULATOR',
        tcp: { host: '', port: 0 },
        export: { path: '', format: 'CL_WORKS_CSV' },
        departmentNo: 1,
      },
    },
    database: { path: ':memory:', backupDir: '', backupIntervalMinutes: 30 },
    server: { host: '127.0.0.1', port: 0 },
    sync: {
      enabled: false, serverUrl: '', intervalSeconds: 20, pushBatchSize: 50,
      maxAttempts: 25, baseDelayMs: 2000, maxDelayMs: 300000,
    },
    hardware: {
      setupCompletedAt: null, scannerVerifiedAt: null,
      printerVerifiedAt: null, scaleCalibratedAt: null,
    },
    ...overrides,
  };
}

export function testBarcodeConfig(
  rules: readonly WeightedBarcodeRule[] = [TEST_WEIGHT_RULE, TEST_PRICE_RULE],
  confirmed = true,
): BarcodeConfigFile {
  return {
    weightedFormatConfirmed: confirmed,
    discoveryPrefixes: ['2'],
    minPlainLength: 4,
    maxPlainLength: 48,
    limits: { maxWeightMilli: 50000, maxPriceKurus: 500000, minPriceKurus: 1 },
    rules,
  };
}

export interface Harness {
  readonly app: PosApplication;
  readonly clock: FixedClock;
  readonly printer: NullTransport;
  readonly scanner: SimulatorScanner;
  readonly dir: string;
  readonly dbPath: string;
  /** Cokme simulasyonu: DB kapatilir, ayni dosyayla yeni uygulama acilir */
  restart(): Harness;
  dispose(): void;
}

export function createHarness(options: {
  dir?: string;
  config?: PosConfig;
  barcodeConfig?: BarcodeConfigFile;
  startAt?: number;
} = {}): Harness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'pos-test-'));
  const dbPath = join(dir, 'pos.db');
  const clock = new FixedClock(options.startAt ?? Date.parse('2026-03-10T09:00:00'));
  const printer = new NullTransport();
  const scanner = new SimulatorScanner();
  const scale = new SimulatorScale();
  const config = options.config ?? testPosConfig();
  const barcodeConfig = options.barcodeConfig ?? testBarcodeConfig();

  const app = new PosApplication({
    config,
    barcodeConfig,
    clock,
    databasePath: dbPath,
    devices: { scanner, printer, scale, simulated: [] },
  });

  const harness: Harness = {
    app, clock, printer, scanner, dir, dbPath,
    restart(): Harness {
      app.db.close();
      return createHarness({ ...options, dir, config, barcodeConfig, startAt: clock.now() });
    },
    dispose(): void {
      try {
        app.db.close();
      } catch { /* zaten kapali */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Standart test verisi: kasiyer, yonetici, kasa acilisi, urunler */
export function seed(h: Harness) {
  const cashier = h.app.users.create({
    username: 'kasiyer', displayName: 'Ayse K.', pin: '1234', role: 'CASHIER',
  });
  const manager = h.app.users.create({
    username: 'mudur', displayName: 'Mehmet Y.', pin: '9999', role: 'MANAGER',
  });

  const findik = h.app.products.create({
    code: 'F001', name: 'Ic Findik', unit: 'KG',
    unitPrice: 30000 as never, taxRateBp: percent(1),
    stockQty: 50000 as never, plus: [231],
  });
  const fistik = h.app.products.create({
    code: 'F002', name: 'Antep Fistigi', unit: 'KG',
    unitPrice: 45000 as never, taxRateBp: percent(1),
    stockQty: 30000 as never, plus: [405],
  });
  const su = h.app.products.create({
    code: 'S001', name: 'Su 0.5L', unit: 'EACH',
    unitPrice: 750 as never, taxRateBp: percent(10),
    stockQty: 100000 as never, barcodes: ['8690504060017'],
  });
  const cikolata = h.app.products.create({
    code: 'C001', name: 'Cikolata', unit: 'EACH',
    unitPrice: 4550 as never, taxRateBp: percent(20),
    stockQty: 50000 as never, barcodes: ['8691234567895'],
  });

  const session = h.app.cashRegister.open({
    terminalId: h.app.terminalId, userId: cashier.id, openingFloat: 20000 as never,
  });

  return { cashier, manager, findik, fistik, su, cikolata, session };
}
