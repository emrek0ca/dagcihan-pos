import type { BarcodeParserConfig } from '../core/barcode/types.ts';

export interface StoreConfig {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly phone: string;
  readonly taxOffice: string;
  readonly taxNumber: string;
  readonly receiptFooter: readonly string[];
}

export interface TerminalConfig {
  readonly code: string;
  readonly name: string;
}

export type CashRoundingMode = 'NONE' | 'NEAREST_5_KURUS' | 'NEAREST_25_KURUS';
export type WeightedOnNonKgPolicy = 'REJECT' | 'ALLOW_AS_EACH';

export interface SalesConfig {
  readonly receiptSeries: string;
  readonly defaultTaxRateBp: number;
  readonly cashRounding: CashRoundingMode;
  readonly maxLineAmountKurus: number;
  readonly blockNegativeStock: boolean;
  readonly weightedOnNonKgProduct: WeightedOnNonKgPolicy;
  readonly scanDedupeWindowMs: number;
  readonly priceMismatchTolerancePercent: number;
}

export interface PermissionsConfig {
  readonly maxDiscountPercentWithoutApproval: number;
  readonly voidLineRequiresApproval: boolean;
  readonly voidSaleRequiresApproval: boolean;
  readonly refundRequiresApproval: boolean;
  readonly blindRefundAllowed: boolean;
  readonly priceOverrideRequiresApproval: boolean;
}

export type ScannerAdapterKind = 'HID_WEDGE' | 'SERIAL' | 'TCP' | 'SIMULATOR';
export type PrinterAdapterKind = 'WINDOWS_SHARE' | 'TCP' | 'SERIAL' | 'FILE' | 'NULL';
export type ScaleAdapterKind = 'CSV_EXPORT' | 'CAS_TCP' | 'SIMULATOR';

export interface SerialSettings {
  readonly port: string;
  readonly baudRate: number;
  readonly dataBits?: number;
  readonly parity?: 'none' | 'even' | 'odd';
  readonly stopBits?: number;
}

export interface TcpSettings {
  readonly host: string;
  readonly port: number;
}

export interface ScannerDeviceConfig {
  readonly adapter: ScannerAdapterKind;
  readonly serial: SerialSettings;
  readonly tcp: TcpSettings;
  readonly terminatorChars: readonly string[];
  readonly interCharTimeoutMs: number;
}

export interface PrinterDeviceConfig {
  readonly adapter: PrinterAdapterKind;
  readonly share: string;
  readonly tcp: TcpSettings;
  readonly serial: SerialSettings;
  readonly file: { readonly path: string };
  readonly codePage: string;
  readonly charactersPerLine: number;
  readonly cutAfterReceipt: boolean;
  readonly openDrawerOnCash: boolean;
  readonly retryDelaysMs: readonly number[];
  readonly maxAttempts: number;
}

export interface ScaleDeviceConfig {
  readonly adapter: ScaleAdapterKind;
  readonly tcp: TcpSettings;
  readonly export: { readonly path: string; readonly format: string };
  readonly departmentNo: number;
}

export interface DevicesConfig {
  readonly scanner: ScannerDeviceConfig;
  readonly printer: PrinterDeviceConfig;
  readonly scale: ScaleDeviceConfig;
}

export interface DatabaseConfig {
  readonly path: string;
  readonly backupDir: string;
  readonly backupIntervalMinutes: number;
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

/** Merkezi sunucu (VPS control-plane) baglantisi. Kapali olabilir; POS calisir. */
export interface SyncConfig {
  readonly enabled: boolean;
  /** Ornek: https://pos-api.ornek.com  (bos ise cihaz kaydi yapilana kadar kapali) */
  readonly serverUrl: string;
  readonly intervalSeconds: number;
  readonly pushBatchSize: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Ilk kurulum donanim sihirbazinin durumu (kalici) */
export interface HardwareSetupConfig {
  readonly setupCompletedAt: string | null;
  readonly scannerVerifiedAt: string | null;
  readonly printerVerifiedAt: string | null;
  readonly scaleCalibratedAt: string | null;
}

export interface PosConfig {
  readonly store: StoreConfig;
  readonly terminal: TerminalConfig;
  readonly sales: SalesConfig;
  readonly permissions: PermissionsConfig;
  readonly devices: DevicesConfig;
  readonly database: DatabaseConfig;
  readonly server: ServerConfig;
  readonly sync: SyncConfig;
  readonly hardware: HardwareSetupConfig;
}

export interface BarcodeConfigFile extends BarcodeParserConfig {
  /** Gercek CAS etiketiyle dogrulandi mi? false ise tartili satis engellenir. */
  readonly weightedFormatConfirmed: boolean;
  /** Cozumlenemeyen ama tartili olma ihtimali olan barkodlarin on ekleri (teshis icin) */
  readonly discoveryPrefixes: readonly string[];
}
