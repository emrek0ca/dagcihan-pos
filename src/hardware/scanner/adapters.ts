/**
 * Barkod okuyucu adapterleri (Perkon PS5700 ve uyumlu cihazlar).
 *
 *  HidWedgeScanner : Okuyucu klavye gibi davranir (fabrika varsayilani). Tuslar
 *                    POS arayuzunde yakalanir ve bu adapter'a iletilir.
 *  SerialScanner   : Okuyucu COM portundan veri gonderir (RS232 / USB-COM modu).
 *  TcpScanner      : Ag uzerinden barkod gonderen okuyucu/ara birim.
 *  SimulatorScanner: YALNIZCA test.
 */
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import type { DeviceStatus, ScanEvent, ScannerPort } from '../ports.ts';
import { BarcodeFramer, type FramerOptions } from '../../core/barcode/framing.ts';

const execFileAsync = promisify(execFile);

abstract class BaseScanner implements ScannerPort {
  abstract readonly name: string;
  protected listeners: ((event: ScanEvent) => void)[] = [];
  protected statusListeners: ((status: DeviceStatus) => void)[] = [];
  protected currentStatus: DeviceStatus = { state: 'UNKNOWN', at: Date.now() };

  onScan(listener: (event: ScanEvent) => void): void {
    this.listeners.push(listener);
  }

  onStatus(listener: (status: DeviceStatus) => void): void {
    this.statusListeners.push(listener);
  }

  status(): DeviceStatus {
    return this.currentStatus;
  }

  protected emit(raw: string, source: string): void {
    const event: ScanEvent = { raw, at: Date.now(), source };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Bir dinleyicinin hatasi digerlerini ve okuyucuyu etkilemez
      }
    }
  }

  protected setStatus(status: DeviceStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        /* yut */
      }
    }
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}

/**
 * Klavye emulasyonu (HID wedge) - Perkon PS5700'un varsayilan modu.
 * Cihaz isletim sistemine klavye olarak gorunur; tuslar arayuzde yakalanip
 * `submit()` ile buraya iletilir. Odak gerektirmeyen yakalama UI tarafindadir.
 */
export class HidWedgeScanner extends BaseScanner {
  readonly name = 'HID klavye okuyucu';
  readonly #framer: BarcodeFramer;

  constructor(options: FramerOptions) {
    super();
    this.#framer = new BarcodeFramer(options);
  }

  async start(): Promise<void> {
    this.setStatus({ state: 'CONNECTED', detail: 'Klavye modu', at: Date.now() });
  }

  async stop(): Promise<void> {
    this.setStatus({ state: 'DISCONNECTED', at: Date.now() });
  }

  /** Arayuzden gelen tam barkod */
  submit(raw: string): void {
    this.emit(raw, 'hid');
  }

  /** Arayuzden gelen tek tus (framer ile birlestirilir) */
  submitChar(char: string, at: number = Date.now()): void {
    for (const complete of this.#framer.push(char, at)) this.emit(complete, 'hid');
  }
}

export class SerialScanner extends BaseScanner {
  readonly name: string;
  readonly #port: string;
  readonly #baudRate: number;
  readonly #framer: BarcodeFramer;
  #stream: ReturnType<typeof createReadStream> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(options: { port: string; baudRate?: number } & FramerOptions) {
    super();
    this.#port = options.port;
    this.#baudRate = options.baudRate ?? 9600;
    this.name = `Seri okuyucu ${options.port}`;
    this.#framer = new BarcodeFramer(options);
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#open();
    this.#idleTimer = setInterval(() => {
      const pending = this.#framer.flushIfIdle(Date.now());
      if (pending !== null) this.emit(pending, 'serial');
    }, 50);
    this.#idleTimer.unref?.();
  }

  async #open(): Promise<void> {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('cmd', [
          '/c', 'mode', `${this.#port}:`, `BAUD=${this.#baudRate}`,
          'PARITY=n', 'DATA=8', 'STOP=1', 'to=off', 'xon=off', 'dtr=on', 'rts=on',
        ], { timeout: 5000 });
      }
      const target = process.platform === 'win32' ? `\\\\.\\${this.#port}` : this.#port;
      const stream = createReadStream(target, { encoding: 'latin1' });
      stream.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('latin1');
        for (const complete of this.#framer.push(text, Date.now())) this.emit(complete, 'serial');
      });
      stream.on('error', (error) => {
        this.setStatus({ state: 'ERROR', detail: error.message, at: Date.now() });
        this.#scheduleReconnect();
      });
      stream.on('close', () => {
        if (!this.#stopped) {
          this.setStatus({ state: 'DISCONNECTED', detail: 'Port kapandi', at: Date.now() });
          this.#scheduleReconnect();
        }
      });
      this.#stream = stream;
      this.setStatus({ state: 'CONNECTED', at: Date.now() });
    } catch (error) {
      this.setStatus({ state: 'ERROR', detail: (error as Error).message, at: Date.now() });
      this.#scheduleReconnect();
    }
  }

  /** Kablo cikarsa uygulama cokmez; arka planda yeniden baglanmayi dener */
  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const timer = setTimeout(() => void this.#open(), 3000);
    timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#idleTimer !== null) clearInterval(this.#idleTimer);
    this.#stream?.destroy();
    this.#stream = null;
    this.setStatus({ state: 'DISCONNECTED', at: Date.now() });
  }
}

export class TcpScanner extends BaseScanner {
  readonly name: string;
  readonly #host: string;
  readonly #port: number;
  readonly #framer: BarcodeFramer;
  #socket: net.Socket | null = null;
  #stopped = false;

  constructor(options: { host: string; port: number } & FramerOptions) {
    super();
    this.#host = options.host;
    this.#port = options.port;
    this.name = `TCP okuyucu ${options.host}:${options.port}`;
    this.#framer = new BarcodeFramer(options);
  }

  async start(): Promise<void> {
    this.#stopped = false;
    this.#connect();
  }

  #connect(): void {
    const socket = net.createConnection({ host: this.#host, port: this.#port });
    socket.setEncoding('latin1');
    socket.on('connect', () => this.setStatus({ state: 'CONNECTED', at: Date.now() }));
    socket.on('data', (chunk: string) => {
      for (const complete of this.#framer.push(chunk, Date.now())) this.emit(complete, 'tcp');
    });
    socket.on('error', (error) =>
      this.setStatus({ state: 'ERROR', detail: error.message, at: Date.now() }));
    socket.on('close', () => {
      this.setStatus({ state: 'DISCONNECTED', at: Date.now() });
      if (!this.#stopped) {
        const timer = setTimeout(() => this.#connect(), 3000);
        timer.unref?.();
      }
    });
    this.#socket = socket;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/** Test ve prova amaclidir. Uretim konfigurasyonunda secilirse uyari verilir. */
export class SimulatorScanner extends BaseScanner {
  readonly name = 'Simulator okuyucu (TEST)';

  async start(): Promise<void> {
    this.setStatus({ state: 'CONNECTED', detail: 'SIMULATOR', at: Date.now() });
  }

  async stop(): Promise<void> {
    this.setStatus({ state: 'DISCONNECTED', at: Date.now() });
  }

  scan(raw: string): void {
    this.emit(raw, 'simulator');
  }
}
