/**
 * Kompozisyon koku: tum modulleri baglar, acilis kurtarmasini yapar.
 *
 * Buradaki sira onemlidir:
 *   1. Veritabani ac + butunluk kontrolu + migration
 *   2. Servisleri kur
 *   3. Kurtarma: yarim kalmis isler, bekleyen fisler, acik satis
 *   4. Donanimi baslat (hata olsa da uygulama acilir)
 */
import { dirname, join } from 'node:path';
import { Db, migrate } from '../data/db.ts';
import { IdempotencyStore } from '../data/idempotency.ts';
import { SystemClock, type Clock } from '../core/clock.ts';
import { AuditLog } from '../modules/audit/audit.ts';
import { UserService } from '../modules/users/users.ts';
import { ProductService } from '../modules/products/products.ts';
import { InventoryService } from '../modules/inventory/inventory.ts';
import { CashRegisterService } from '../modules/cash-register/cash-register.ts';
import { SalesService } from '../modules/sales/sales.ts';
import { ScanResolver } from '../modules/scanner/resolve.ts';
import { PrintQueue } from '../modules/printing/queue.ts';
import { buildReceipt, buildSessionReport } from '../modules/printing/receipt-builder.ts';
import { createDevices, type DeviceSet } from './devices.ts';
import { Outbox } from '../modules/sync/outbox.ts';
import { CredentialStore } from '../modules/sync/credentials.ts';
import { SyncWorker } from '../modules/sync/worker.ts';
import type { BarcodeConfigFile, PosConfig } from '../config/types.ts';
import type { CodePageName } from '../hardware/printer/encoding.ts';
import type { ReceiptKind } from '../modules/printing/document.ts';
import { PosError } from '../core/errors.ts';

export interface StartupReport {
  readonly databasePath: string;
  readonly schemaVersion: number;
  readonly migrationsApplied: readonly string[];
  readonly integrityOk: boolean;
  readonly integrityProblems: readonly string[];
  readonly openSaleRecovered: number | null;
  readonly parkedSales: number;
  readonly stuckPrintJobsRequeued: number;
  readonly pendingPrintJobs: number;
  readonly openCashSession: number | null;
  readonly weightedFormatConfirmed: boolean;
  readonly simulatedDevices: readonly string[];
  readonly warnings: readonly string[];
}

export interface PosDeps {
  readonly config: PosConfig;
  readonly barcodeConfig: BarcodeConfigFile;
  readonly clock?: Clock;
  readonly devices?: DeviceSet;
  readonly databasePath?: string;
  /** Cihaz token dosyasi (varsayilan: veritabaninin yanindaki sync-credentials.json) */
  readonly credentialsFile?: string;
  readonly appVersion?: string;
}

export class PosApplication {
  readonly db: Db;
  readonly clock: Clock;
  readonly config: PosConfig;
  readonly barcodeConfig: BarcodeConfigFile;
  readonly audit: AuditLog;
  readonly users: UserService;
  readonly products: ProductService;
  readonly inventory: InventoryService;
  readonly cashRegister: CashRegisterService;
  readonly sales: SalesService;
  readonly resolver: ScanResolver;
  readonly printQueue: PrintQueue;
  readonly devices: DeviceSet;
  readonly idempotency: IdempotencyStore;
  readonly outbox: Outbox;
  readonly sync: SyncWorker;
  #terminalId: number;

  constructor(deps: PosDeps) {
    this.config = deps.config;
    this.barcodeConfig = deps.barcodeConfig;
    this.clock = deps.clock ?? new SystemClock();
    this.devices = deps.devices ?? createDevices(deps.config.devices);

    this.db = new Db({ path: deps.databasePath ?? deps.config.database.path });
    migrate(this.db);

    this.audit = new AuditLog(this.db, this.clock);
    this.idempotency = new IdempotencyStore(this.db, this.clock);

    // Outbox HER ZAMAN yazar; senkronizasyon kapaliysa olaylar sadece birikir.
    // Bu bilincli: sonradan sunucuya baglanildiginda gecmis kaybolmus olmaz.
    this.outbox = new Outbox(this.db, this.clock);
    const credentialsFile = deps.credentialsFile
      ?? join(dirname(deps.databasePath ?? deps.config.database.path), 'sync-credentials.json');
    this.sync = new SyncWorker({
      db: this.db,
      clock: this.clock,
      audit: this.audit,
      credentials: new CredentialStore(credentialsFile),
      ...(deps.appVersion !== undefined ? { appVersion: deps.appVersion } : {}),
      options: {
        pushBatchSize: deps.config.sync.pushBatchSize,
        intervalMs: deps.config.sync.intervalSeconds * 1000,
        maxAttempts: deps.config.sync.maxAttempts,
        baseDelayMs: deps.config.sync.baseDelayMs,
        maxDelayMs: deps.config.sync.maxDelayMs,
      },
    });

    this.users = new UserService(this.db, this.clock, this.audit, this.outbox);
    this.products = new ProductService(this.db, this.clock, this.audit, this.outbox);
    this.inventory = new InventoryService(this.db, this.clock, this.audit, {
      blockNegativeStock: deps.config.sales.blockNegativeStock,
      outbox: this.outbox,
    });
    this.cashRegister = new CashRegisterService(this.db, this.clock, this.audit, this.outbox);

    this.printQueue = new PrintQueue({
      db: this.db,
      clock: this.clock,
      printer: this.devices.printer,
      audit: this.audit,
      options: {
        retryDelaysMs: deps.config.devices.printer.retryDelaysMs,
        maxAttempts: deps.config.devices.printer.maxAttempts,
        escPos: {
          codePage: normalizeCodePage(deps.config.devices.printer.codePage),
          codePageIndex: codePageIndexOf(deps.config.devices.printer.codePage),
          charactersPerLine: deps.config.devices.printer.charactersPerLine,
        },
      },
    });

    this.sales = new SalesService({
      db: this.db,
      clock: this.clock,
      audit: this.audit,
      inventory: this.inventory,
      idempotency: this.idempotency,
      printQueue: this.printQueue,
      outbox: this.outbox,
      options: {
        receiptSeries: deps.config.sales.receiptSeries,
        cashRounding: deps.config.sales.cashRounding,
        maxDiscountPercentWithoutApproval:
          deps.config.permissions.maxDiscountPercentWithoutApproval,
        blindRefundAllowed: deps.config.permissions.blindRefundAllowed,
        mergeRepeatedScans: true,
      },
    });

    this.resolver = new ScanResolver(
      this.db, this.clock, this.products, this.barcodeConfig,
      {
        weightedOnNonKgProduct: deps.config.sales.weightedOnNonKgProduct,
        maxLineAmountKurus: deps.config.sales.maxLineAmountKurus,
      },
    );

    this.#terminalId = this.#ensureTerminal();
    this.printQueue.setDocumentFactory((saleId, kind) => this.#buildDocument(saleId, kind));
  }

  get terminalId(): number {
    return this.#terminalId;
  }

  #ensureTerminal(): number {
    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM terminals WHERE code = ?', this.config.terminal.code,
    );
    if (existing !== undefined) return existing.id;
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO terminals (code, name, active, created_at) VALUES (?, ?, 1, ?)',
      this.config.terminal.code, this.config.terminal.name, this.clock.now(),
    );
    return lastInsertRowid;
  }

  #buildDocument(saleId: number, kind: ReceiptKind) {
    const sale = this.sales.view(saleId);
    const cashier = this.db.get<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = ?', sale.userId,
    );
    return buildReceipt(sale, {
      storeName: this.config.store.name,
      storeLines: [...this.config.store.addressLines, this.config.store.phone].filter(
        (l) => l.trim() !== '',
      ),
      footer: this.config.store.receiptFooter,
      terminalName: this.config.terminal.name,
      cashierName: cashier?.display_name ?? '-',
      taxOffice: this.config.store.taxOffice,
      taxNumber: this.config.store.taxNumber,
      simulated: this.devices.simulated.some((s) => s.includes('yazici')),
    }, { copy: kind === 'REPRINT' });
  }

  /** Fis belgesini uretir (onizleme ve tekrar basim icin) */
  previewDocument(saleId: number, kind: ReceiptKind) {
    return this.#buildDocument(saleId, kind);
  }

  buildSessionReportDocument(sessionId: number, kind: 'X_REPORT' | 'Z_REPORT') {
    return buildSessionReport(this.cashRegister.summary(sessionId), {
      storeName: this.config.store.name,
      storeLines: [...this.config.store.addressLines].filter((l) => l.trim() !== ''),
      footer: [],
      terminalName: this.config.terminal.name,
      cashierName: '-',
      simulated: this.devices.simulated.some((s) => s.includes('yazici')),
    }, kind);
  }

  // ------------------------------ Acilis ------------------------------

  start(): StartupReport {
    const warnings: string[] = [];
    const integrity = this.db.integrityCheck();
    if (!integrity.ok) {
      warnings.push(`VERITABANI BUTUNLUK SORUNU: ${integrity.problems.join('; ')}`);
    }

    const stuck = this.printQueue.recoverStuckJobs();
    if (stuck > 0) {
      warnings.push(`${stuck} yarim kalmis fis isi yeniden kuyruga alindi (mukerrer basim olabilir)`);
    }

    const openSale = this.sales.currentOpenSale(this.#terminalId);
    const parked = this.sales.listParked(this.#terminalId).length;
    const session = this.cashRegister.current(this.#terminalId);

    if (!this.barcodeConfig.weightedFormatConfirmed) {
      warnings.push(
        'Tartili barkod formati DOGRULANMADI: terazi etiketleri satisa eklenemez. ' +
        '"pos barcode analyze" ile format tanimlanmali.',
      );
    }
    if (this.devices.simulated.length > 0) {
      warnings.push(`SIMULATOR CIHAZ KULLANIMDA: ${this.devices.simulated.join(', ')}`);
    }
    if (this.users.list().length === 0) {
      warnings.push('Tanimli kullanici yok: "pos user add" ile kasiyer olusturun.');
    }

    this.db.tx(() => {
      this.audit.record({
        type: 'SYSTEM_STARTED',
        terminalId: this.#terminalId,
        data: {
          openSaleId: openSale?.id ?? null,
          parkedSales: parked,
          stuckPrintJobs: stuck,
          integrityOk: integrity.ok,
        },
      });
    });

    return {
      databasePath: this.db.path,
      schemaVersion: Number(
        this.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0,
      ),
      migrationsApplied: [],
      integrityOk: integrity.ok,
      integrityProblems: integrity.problems,
      openSaleRecovered: openSale?.id ?? null,
      parkedSales: parked,
      stuckPrintJobsRequeued: stuck,
      pendingPrintJobs: this.printQueue.pendingCount(),
      openCashSession: session?.id ?? null,
      weightedFormatConfirmed: this.barcodeConfig.weightedFormatConfirmed,
      simulatedDevices: this.devices.simulated,
      warnings,
    };
  }

  async startDevices(): Promise<void> {
    try {
      await this.devices.scanner.start();
    } catch (error) {
      // Okuyucu yoksa uygulama yine de acilir; elle arama calisir
      this.db.tx(() => {
        this.audit.record({
          type: 'DEVICE_ERROR', entity: 'scanner',
          data: { error: (error as Error).message },
        });
      });
    }
    this.printQueue.start();

    // Senkronizasyon arka planda baslar. Sunucu erisilemezse SESSIZCE bekler;
    // satis akisi bundan etkilenmez.
    if (this.config.sync.enabled && this.sync.enrolled) {
      this.sync.start();
    }
  }

  async stop(): Promise<void> {
    this.sync.stop();
    this.printQueue.stop();
    try {
      await this.devices.scanner.stop();
    } catch { /* yut */ }
    try {
      await this.devices.printer.close();
    } catch { /* yut */ }
    this.db.close();
  }

  /** Kasiyerin fis acmak icin ekstra islem yapmasina gerek kalmasin */
  ensureOpenSale(userId: number): number {
    const existing = this.sales.currentOpenSale(this.#terminalId);
    if (existing !== undefined) return existing.id;
    const session = this.cashRegister.current(this.#terminalId);
    if (session === undefined) {
      throw new PosError('CASH_SESSION_NOT_OPEN', 'Kasa acilisi yapilmadi');
    }
    return this.sales.openSale({
      terminalId: this.#terminalId,
      userId,
      cashSessionId: session.id,
    }).id;
  }
}

function normalizeCodePage(name: string): CodePageName {
  const upper = name.toUpperCase();
  if (upper.includes('1254')) return 'CP1254';
  if (upper.includes('857')) return 'CP857';
  if (upper.includes('ASCII')) return 'ASCII';
  return 'CP857';
}

function codePageIndexOf(name: string): number {
  const match = /:(\d+)$/.exec(name);
  if (match !== null) return Number(match[1]);
  return normalizeCodePage(name) === 'CP1254' ? 25 : 15;
}
