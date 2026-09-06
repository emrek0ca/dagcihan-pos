/**
 * Donanim port arayuzleri.
 *
 * modules/ ve core/ YALNIZCA bu arayuzleri bilir. Cihaz degisirse
 * hardware/ altinda yeni bir adapter yazilir, ust katmanlara dokunulmaz.
 */

export type DeviceState = 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'UNKNOWN';

export interface DeviceStatus {
  readonly state: DeviceState;
  readonly detail?: string;
  readonly at: number;
}

export interface ScanEvent {
  readonly raw: string;
  readonly at: number;
  readonly source: string;
}

export interface ScannerPort {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onScan(listener: (event: ScanEvent) => void): void;
  onStatus(listener: (status: DeviceStatus) => void): void;
  status(): DeviceStatus;
}

export interface PrinterStatus extends DeviceStatus {
  readonly paperOut?: boolean;
  readonly coverOpen?: boolean;
  readonly online?: boolean;
}

export interface PrinterPort {
  readonly name: string;
  /** Ham ESC/POS baytlarini yaziciya gonderir */
  write(bytes: Uint8Array): Promise<void>;
  status(): Promise<PrinterStatus>;
  close(): Promise<void>;
}

export interface ScalePluItem {
  readonly plu: number;
  readonly name: string;
  /** kurus/kg veya kurus/adet */
  readonly unitPrice: number;
  readonly unit: 'EACH' | 'KG';
  readonly departmentNo: number;
  readonly taxRateBp: number;
  readonly barcodeFormat?: string;
}

export interface ScaleSyncResult {
  readonly sent: number;
  readonly failed: number;
  readonly detail: string;
  readonly target: string;
}

export interface ScalePort {
  readonly name: string;
  syncItems(items: readonly ScalePluItem[]): Promise<ScaleSyncResult>;
  status(): Promise<DeviceStatus>;
}
