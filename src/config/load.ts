/**
 * Konfigurasyon yukleyici. Hatali config ile ACILMAK YERINE acilista patlar;
 * magazada "sessizce yanlis calisan" bir kasadansa acilmayan kasa yeglenir.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig as validateBarcodeConfig } from '../core/barcode/parser.ts';
import type { BarcodeConfigFile, PosConfig } from './types.ts';

/**
 * Proje koku: package.json iceren ilk ust klasor.
 *
 * Kaynaktan (src/config) ve derlenmis ciktidan (dist/src/config) calistirildiginda
 * klasor derinligi farklidir; sabit sayida '..' kullanmak derlenmis surumde
 * config dosyalarini kaybettirir. Yukari dogru arama her iki durumda da dogru
 * koku bulur. (Masaustu uygulamasi zaten acik yol verir; bu CLI ve testler icindir.)
 */
function findProjectRoot(from: string): string {
  let current = from;
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(from, '..', '..');
}

export const PROJECT_ROOT = findProjectRoot(dirname(fileURLToPath(import.meta.url)));

export class ConfigError extends Error {
  readonly file: string;
  constructor(message: string, file: string) {
    super(`${file}: ${message}`);
    this.name = 'ConfigError';
    this.file = file;
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) throw new ConfigError('dosya bulunamadi', file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`okunamadi: ${(error as Error).message}`, file);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`gecersiz JSON: ${(error as Error).message}`, file);
  }
}

class Checker {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  obj(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ConfigError(`${path} bir nesne olmali`, this.#file);
    }
    return value as Record<string, unknown>;
  }
  str(value: unknown, path: string, fallback?: string): string {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string') throw new ConfigError(`${path} metin olmali`, this.#file);
    return value;
  }
  num(value: unknown, path: string, fallback?: number): number {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ConfigError(`${path} sayi olmali`, this.#file);
    }
    return value;
  }
  int(value: unknown, path: string, fallback?: number): number {
    const n = this.num(value, path, fallback);
    if (!Number.isInteger(n)) throw new ConfigError(`${path} tam sayi olmali`, this.#file);
    return n;
  }
  bool(value: unknown, path: string, fallback?: boolean): boolean {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'boolean') throw new ConfigError(`${path} true/false olmali`, this.#file);
    return value;
  }
  strArray(value: unknown, path: string, fallback?: string[]): string[] {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Array.isArray(value)) throw new ConfigError(`${path} dizi olmali`, this.#file);
    return value.map((v, i) => this.str(v, `${path}[${i}]`));
  }
  numArray(value: unknown, path: string, fallback?: number[]): number[] {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Array.isArray(value)) throw new ConfigError(`${path} dizi olmali`, this.#file);
    return value.map((v, i) => this.num(v, `${path}[${i}]`));
  }
  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback?: T): T {
    const s = this.str(value, path, fallback);
    if (!(allowed as readonly string[]).includes(s)) {
      throw new ConfigError(`${path} su degerlerden biri olmali: ${allowed.join(', ')}`, this.#file);
    }
    return s as T;
  }
}

function optionalIso(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function resolvePath(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

/**
 * @param file       Okunacak config dosyasi
 * @param options.baseDir Config icindeki GORECELI yollarin (veritabani, yedek, disa
 *   aktarim) cozulecegi kok. Masaustu uygulamasinda bu, yazilabilir kullanici veri
 *   klasorudur (paketli uygulama klasoru salt-okunurdur). Varsayilan: proje koku.
 */
export function loadPosConfig(
  file = join(PROJECT_ROOT, 'config', 'pos.config.json'),
  options: { baseDir?: string } = {},
): PosConfig {
  const baseDir = options.baseDir ?? PROJECT_ROOT;
  const c = new Checker(file);
  const root = c.obj(readJson(file), 'kok');
  const store = c.obj(root.store, 'store');
  const terminal = c.obj(root.terminal, 'terminal');
  const sales = c.obj(root.sales, 'sales');
  const permissions = c.obj(root.permissions, 'permissions');
  const devices = c.obj(root.devices, 'devices');
  const scanner = c.obj(devices.scanner, 'devices.scanner');
  const printer = c.obj(devices.printer, 'devices.printer');
  const scale = c.obj(devices.scale, 'devices.scale');
  const database = c.obj(root.database, 'database');
  const server = c.obj(root.server, 'server');
  // Senkronizasyon blogu opsiyoneldir: eski config dosyalari da calisir
  const sync = c.obj(root.sync ?? {}, 'sync');
  const hardware = c.obj(root.hardware ?? {}, 'hardware');

  const serial = (v: unknown, path: string) => {
    const o = c.obj(v, path);
    return {
      port: c.str(o.port, `${path}.port`, ''),
      baudRate: c.int(o.baudRate, `${path}.baudRate`, 9600),
      dataBits: c.int(o.dataBits, `${path}.dataBits`, 8),
      parity: c.oneOf(o.parity, `${path}.parity`, ['none', 'even', 'odd'] as const, 'none'),
      stopBits: c.int(o.stopBits, `${path}.stopBits`, 1),
    };
  };
  const tcp = (v: unknown, path: string) => {
    const o = c.obj(v, path);
    return { host: c.str(o.host, `${path}.host`, ''), port: c.int(o.port, `${path}.port`, 0) };
  };

  const taxBp = c.int(sales.defaultTaxRateBp, 'sales.defaultTaxRateBp', 100);
  if (taxBp < 0 || taxBp > 10000) {
    throw new ConfigError('sales.defaultTaxRateBp 0-10000 arasi olmali (baz puan)', file);
  }

  return {
    store: {
      name: c.str(store.name, 'store.name'),
      addressLines: c.strArray(store.addressLines, 'store.addressLines', []),
      phone: c.str(store.phone, 'store.phone', ''),
      taxOffice: c.str(store.taxOffice, 'store.taxOffice', ''),
      taxNumber: c.str(store.taxNumber, 'store.taxNumber', ''),
      receiptFooter: c.strArray(store.receiptFooter, 'store.receiptFooter', []),
    },
    terminal: {
      code: c.str(terminal.code, 'terminal.code'),
      name: c.str(terminal.name, 'terminal.name'),
    },
    sales: {
      receiptSeries: c.str(sales.receiptSeries, 'sales.receiptSeries', 'A'),
      defaultTaxRateBp: taxBp,
      cashRounding: c.oneOf(sales.cashRounding, 'sales.cashRounding',
        ['NONE', 'NEAREST_5_KURUS', 'NEAREST_25_KURUS'] as const, 'NONE'),
      maxLineAmountKurus: c.int(sales.maxLineAmountKurus, 'sales.maxLineAmountKurus', 500000),
      blockNegativeStock: c.bool(sales.blockNegativeStock, 'sales.blockNegativeStock', false),
      weightedOnNonKgProduct: c.oneOf(sales.weightedOnNonKgProduct,
        'sales.weightedOnNonKgProduct', ['REJECT', 'ALLOW_AS_EACH'] as const, 'REJECT'),
      scanDedupeWindowMs: c.int(sales.scanDedupeWindowMs, 'sales.scanDedupeWindowMs', 120),
      priceMismatchTolerancePercent: c.num(sales.priceMismatchTolerancePercent,
        'sales.priceMismatchTolerancePercent', 0),
    },
    permissions: {
      maxDiscountPercentWithoutApproval: c.num(permissions.maxDiscountPercentWithoutApproval,
        'permissions.maxDiscountPercentWithoutApproval', 10),
      voidLineRequiresApproval: c.bool(permissions.voidLineRequiresApproval,
        'permissions.voidLineRequiresApproval', false),
      voidSaleRequiresApproval: c.bool(permissions.voidSaleRequiresApproval,
        'permissions.voidSaleRequiresApproval', true),
      refundRequiresApproval: c.bool(permissions.refundRequiresApproval,
        'permissions.refundRequiresApproval', true),
      blindRefundAllowed: c.bool(permissions.blindRefundAllowed,
        'permissions.blindRefundAllowed', false),
      priceOverrideRequiresApproval: c.bool(permissions.priceOverrideRequiresApproval,
        'permissions.priceOverrideRequiresApproval', true),
    },
    devices: {
      scanner: {
        adapter: c.oneOf(scanner.adapter, 'devices.scanner.adapter',
          ['HID_WEDGE', 'SERIAL', 'TCP', 'SIMULATOR'] as const, 'HID_WEDGE'),
        serial: serial(scanner.serial, 'devices.scanner.serial'),
        tcp: tcp(scanner.tcp, 'devices.scanner.tcp'),
        terminatorChars: c.strArray(scanner.terminatorChars,
          'devices.scanner.terminatorChars', ['\r', '\n']),
        interCharTimeoutMs: c.int(scanner.interCharTimeoutMs,
          'devices.scanner.interCharTimeoutMs', 60),
      },
      printer: {
        adapter: c.oneOf(printer.adapter, 'devices.printer.adapter',
          ['WINDOWS_SHARE', 'TCP', 'SERIAL', 'FILE', 'NULL'] as const, 'WINDOWS_SHARE'),
        share: c.str(printer.share, 'devices.printer.share', ''),
        tcp: tcp(printer.tcp, 'devices.printer.tcp'),
        serial: serial(printer.serial, 'devices.printer.serial'),
        file: {
          path: resolvePath(baseDir,
            c.str(c.obj(printer.file, 'devices.printer.file').path,
              'devices.printer.file.path', './data/receipts')),
        },
        codePage: c.str(printer.codePage, 'devices.printer.codePage', 'PC857_TURKISH'),
        charactersPerLine: c.int(printer.charactersPerLine,
          'devices.printer.charactersPerLine', 48),
        cutAfterReceipt: c.bool(printer.cutAfterReceipt, 'devices.printer.cutAfterReceipt', true),
        openDrawerOnCash: c.bool(printer.openDrawerOnCash,
          'devices.printer.openDrawerOnCash', true),
        retryDelaysMs: c.numArray(printer.retryDelaysMs,
          'devices.printer.retryDelaysMs', [1000, 5000, 15000, 60000]),
        maxAttempts: c.int(printer.maxAttempts, 'devices.printer.maxAttempts', 8),
      },
      scale: {
        adapter: c.oneOf(scale.adapter, 'devices.scale.adapter',
          ['CSV_EXPORT', 'CAS_TCP', 'SIMULATOR'] as const, 'CSV_EXPORT'),
        tcp: tcp(scale.tcp, 'devices.scale.tcp'),
        export: {
          path: resolvePath(baseDir,
            c.str(c.obj(scale.export, 'devices.scale.export').path,
              'devices.scale.export.path', './data/scale-export')),
          format: c.str(c.obj(scale.export, 'devices.scale.export').format,
            'devices.scale.export.format', 'CL_WORKS_CSV'),
        },
        departmentNo: c.int(scale.departmentNo, 'devices.scale.departmentNo', 1),
      },
    },
    database: {
      path: resolvePath(baseDir, c.str(database.path, 'database.path', './data/pos.db')),
      backupDir: resolvePath(baseDir,
        c.str(database.backupDir, 'database.backupDir', './data/backups')),
      backupIntervalMinutes: c.int(database.backupIntervalMinutes,
        'database.backupIntervalMinutes', 30),
    },
    server: {
      host: c.str(server.host, 'server.host', '127.0.0.1'),
      port: c.int(server.port, 'server.port', 7311),
    },
    hardware: {
      setupCompletedAt: optionalIso(hardware.setupCompletedAt),
      scannerVerifiedAt: optionalIso(hardware.scannerVerifiedAt),
      printerVerifiedAt: optionalIso(hardware.printerVerifiedAt),
      scaleCalibratedAt: optionalIso(hardware.scaleCalibratedAt),
    },
    sync: {
      enabled: c.bool(sync.enabled, 'sync.enabled', false),
      serverUrl: c.str(sync.serverUrl, 'sync.serverUrl', ''),
      intervalSeconds: c.int(sync.intervalSeconds, 'sync.intervalSeconds', 20),
      pushBatchSize: c.int(sync.pushBatchSize, 'sync.pushBatchSize', 50),
      maxAttempts: c.int(sync.maxAttempts, 'sync.maxAttempts', 25),
      baseDelayMs: c.int(sync.baseDelayMs, 'sync.baseDelayMs', 2000),
      maxDelayMs: c.int(sync.maxDelayMs, 'sync.maxDelayMs', 300000),
    },
  };
}

export function loadBarcodeConfig(
  file = join(PROJECT_ROOT, 'config', 'barcode-rules.json'),
): BarcodeConfigFile {
  const c = new Checker(file);
  const root = c.obj(readJson(file), 'kok');
  const limits = c.obj(root.limits, 'limits');
  if (!Array.isArray(root.rules)) throw new ConfigError('rules dizi olmali', file);

  const config: BarcodeConfigFile = {
    weightedFormatConfirmed: c.bool(root.weightedFormatConfirmed, 'weightedFormatConfirmed', false),
    discoveryPrefixes: c.strArray(root.discoveryPrefixes, 'discoveryPrefixes', ['2']),
    minPlainLength: c.int(root.minPlainLength, 'minPlainLength', 4),
    maxPlainLength: c.int(root.maxPlainLength, 'maxPlainLength', 48),
    limits: {
      maxWeightMilli: c.int(limits.maxWeightMilli, 'limits.maxWeightMilli', 50000),
      maxPriceKurus: c.int(limits.maxPriceKurus, 'limits.maxPriceKurus', 500000),
      minPriceKurus: c.int(limits.minPriceKurus, 'limits.minPriceKurus', 1),
    },
    rules: root.rules as BarcodeConfigFile['rules'],
  };

  // Kural yapisinin derin dogrulamasi parser tarafindadir (tek kaynak)
  validateBarcodeConfig(config);
  return config;
}
