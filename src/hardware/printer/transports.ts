/**
 * Yazici tasima katmani - GERCEK cihaz baglantilari.
 *
 *  Tcp9100Transport      : Ethernet/WiFi yazici (RAW 9100). Durum sorgusu desteklenir.
 *  WindowsShareTransport : USB yazici, Windows paylasimi uzerinden ham bayt gonderimi.
 *                          (Kurulum: yazici paylasima acilir, ornek \\localhost\XP-Q805K)
 *  SerialTransport       : COM portu (Windows'ta `mode` ile ayarlanir, sonra dogrudan yazilir)
 *  FileTransport         : Baytlari dosyaya yazar. GELISTIRME/TESTE ozeldir.
 *  NullTransport         : Yutar. YALNIZCA test.
 */
import { createWriteStream, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';
import type { PrinterPort, PrinterStatus } from '../ports.ts';
import { STATUS_QUERY, decodeStatus } from './escpos.ts';

const execFileAsync = promisify(execFile);

function now(): number {
  return Date.now();
}

// --------------------------------- TCP (9100) ---------------------------------

export class Tcp9100Transport implements PrinterPort {
  readonly name: string;
  readonly #host: string;
  readonly #port: number;
  readonly #timeoutMs: number;

  constructor(options: { host: string; port?: number; timeoutMs?: number }) {
    this.#host = options.host;
    this.#port = options.port ?? 9100;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.name = `TCP ${this.#host}:${this.#port}`;
  }

  #connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.#host, port: this.#port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Yazici baglanti zaman asimi: ${this.name}`));
      }, this.#timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    const socket = await this.#connect();
    try {
      await new Promise<void>((resolve, reject) => {
        socket.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
      // Baytlarin yaziciya ulasmasi icin kisa bekleme (soket hemen kapanirsa kesilebilir)
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      socket.end();
      socket.destroy();
    }
  }

  async status(): Promise<PrinterStatus> {
    let socket: net.Socket;
    try {
      socket = await this.#connect();
    } catch (error) {
      return { state: 'DISCONNECTED', detail: (error as Error).message, at: now() };
    }
    try {
      const query = async (command: Uint8Array): Promise<number | undefined> =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 700);
          socket.once('data', (data: Buffer) => {
            clearTimeout(timer);
            resolve(data[0]);
          });
          socket.write(command);
        });

      const printer = await query(STATUS_QUERY.PRINTER);
      const offline = await query(STATUS_QUERY.OFFLINE);
      const error = await query(STATUS_QUERY.ERROR);
      const paper = await query(STATUS_QUERY.PAPER);

      if (printer === undefined) {
        return { state: 'CONNECTED', detail: 'Durum sorgusuna yanit yok', online: true, at: now() };
      }
      const decoded = decodeStatus({
        ...(printer !== undefined ? { printer } : {}),
        ...(offline !== undefined ? { offline } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(paper !== undefined ? { paper } : {}),
      });
      const problems: string[] = [];
      if (decoded.coverOpen) problems.push('kapak acik');
      if (decoded.paperOut) problems.push('kagit bitti');
      if (decoded.paperLow) problems.push('kagit azaldi');
      if (decoded.error) problems.push('yazici hatasi');
      return {
        state: decoded.online && !decoded.paperOut && !decoded.error ? 'CONNECTED' : 'ERROR',
        ...(problems.length > 0 ? { detail: problems.join(', ') } : {}),
        online: decoded.online,
        paperOut: decoded.paperOut,
        coverOpen: decoded.coverOpen,
        at: now(),
      };
    } finally {
      socket.end();
      socket.destroy();
    }
  }

  async close(): Promise<void> {
    /* baglanti her yazimda acilip kapanir */
  }
}

// --------------------------- Windows yazici paylasimi ---------------------------

export class WindowsShareTransport implements PrinterPort {
  readonly name: string;
  readonly #share: string;

  constructor(options: { share: string }) {
    this.#share = options.share;
    this.name = `Windows paylasimi ${options.share}`;
  }

  async write(bytes: Uint8Array): Promise<void> {
    const file = join(tmpdir(), `pos-print-${randomUUID()}.bin`);
    await fs.writeFile(file, bytes);
    try {
      // `copy /b` ham bayt gonderir; yazici surucusu araya girmez.
      await execFileAsync('cmd', ['/c', 'copy', '/b', file, this.#share], { timeout: 15000 });
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async status(): Promise<PrinterStatus> {
    // Paylasim uzerinden gercek zamanli durum okunamaz; erisilebilirlik test edilir.
    try {
      await execFileAsync('cmd', ['/c', 'if', 'exist', this.#share, 'echo', 'ok'], {
        timeout: 5000,
      });
      return { state: 'UNKNOWN', detail: 'Paylasim uzerinden durum sorgusu yok', at: now() };
    } catch (error) {
      return { state: 'DISCONNECTED', detail: (error as Error).message, at: now() };
    }
  }

  async close(): Promise<void> {}
}

// --------------------------------- Seri port ---------------------------------

export class SerialTransport implements PrinterPort {
  readonly name: string;
  readonly #port: string;
  readonly #baudRate: number;
  #configured = false;

  constructor(options: { port: string; baudRate?: number }) {
    this.#port = options.port;
    this.#baudRate = options.baudRate ?? 115200;
    this.name = `Seri ${options.port}@${this.#baudRate}`;
  }

  async #configure(): Promise<void> {
    if (this.#configured || process.platform !== 'win32') return;
    await execFileAsync('cmd', [
      '/c', 'mode', `${this.#port}:`,
      `BAUD=${this.#baudRate}`, 'PARITY=n', 'DATA=8', 'STOP=1', 'to=off', 'xon=off',
      'odsr=off', 'octs=off', 'dtr=on', 'rts=on', 'idsr=off',
    ], { timeout: 5000 });
    this.#configured = true;
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.#configure();
    const target = process.platform === 'win32' ? `\\\\.\\${this.#port}` : this.#port;
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target, { flags: 'w' });
      stream.on('error', reject);
      stream.write(bytes, (error) => {
        if (error) {
          reject(error);
          return;
        }
        stream.end(() => resolve());
      });
    });
  }

  async status(): Promise<PrinterStatus> {
    try {
      await this.#configure();
      return { state: 'UNKNOWN', detail: 'Seri portta durum sorgusu yapilmadi', at: now() };
    } catch (error) {
      return { state: 'DISCONNECTED', detail: (error as Error).message, at: now() };
    }
  }

  async close(): Promise<void> {}
}

// ------------------------------ Dosya / bos ------------------------------

/** Baytlari dosyaya yazar. Gercek kagida basmaz - yalnizca gelistirme icindir. */
export class FileTransport implements PrinterPort {
  readonly name: string;
  readonly #path: string;

  constructor(options: { path: string }) {
    this.#path = options.path;
    this.name = `Dosya ${options.path}`;
  }

  async write(bytes: Uint8Array): Promise<void> {
    await fs.mkdir(this.#path, { recursive: true });
    const file = join(this.#path, `${new Date().toISOString().replace(/[:.]/g, '-')}.escpos`);
    await fs.writeFile(file, bytes);
  }

  async status(): Promise<PrinterStatus> {
    return { state: 'CONNECTED', detail: 'DOSYA MODU - gercek yazici degil', at: now() };
  }

  async close(): Promise<void> {}
}

export class NullTransport implements PrinterPort {
  readonly name = 'Bos yazici (test)';
  readonly written: Uint8Array[] = [];
  #fail = false;

  failNext(fail = true): void {
    this.#fail = fail;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#fail) throw new Error('Yazici simulasyon hatasi');
    this.written.push(bytes);
  }

  async status(): Promise<PrinterStatus> {
    return this.#fail
      ? { state: 'ERROR', detail: 'Simule hata', at: now() }
      : { state: 'CONNECTED', at: now() };
  }

  async close(): Promise<void> {}
}
