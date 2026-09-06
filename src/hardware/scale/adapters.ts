/**
 * Terazi (CAS CL3000) adapterleri.
 *
 * Terazinin POS acisindan tek gorevi vardir: URUN/FIYAT TABLOSUNUN GUNCEL KALMASI.
 * Tartma ve etiket basma terazide olur; POS o etiketi okur.
 *
 * CsvExportScale : CL-Works'un okudugu bicimde PLU dosyasi uretir. Magazada
 *                  bugun de kullanilan yontemdir ve CIHAZ OLMADAN calisir.
 * CasTcpScale    : Dogrudan ag uzerinden PLU yukleme. CL3000'in protokol cercevesi
 *                  cihaz uzerinde dogrulanmadan uygulanmaz - bu adapter cagrildiginda
 *                  ACIK HATA verir; sessizce "basarili" donmez.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import type { DeviceStatus, ScalePluItem, ScalePort, ScaleSyncResult } from '../ports.ts';

function csvEscape(value: string): string {
  return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Fiyati kurus tam sayisindan CL-Works'un bekledigi ondalikli metne cevirir */
function priceText(kurus: number): string {
  const sign = kurus < 0 ? '-' : '';
  const abs = Math.abs(kurus);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export class CsvExportScale implements ScalePort {
  readonly name: string;
  readonly #dir: string;
  readonly #departmentNo: number;

  constructor(options: { path: string; departmentNo?: number }) {
    this.#dir = options.path;
    this.#departmentNo = options.departmentNo ?? 1;
    this.name = `CSV disa aktarim (${options.path})`;
  }

  async syncItems(items: readonly ScalePluItem[]): Promise<ScaleSyncResult> {
    await fs.mkdir(this.#dir, { recursive: true });
    const header = [
      'PLU', 'DEPT', 'ITEM_NAME', 'UNIT_PRICE', 'UNIT_TYPE', 'TAX_RATE', 'BARCODE_FORMAT',
    ].join(',');

    const rows = items.map((item) =>
      [
        String(item.plu),
        String(item.departmentNo || this.#departmentNo),
        csvEscape(item.name),
        priceText(item.unitPrice),
        item.unit === 'KG' ? '1' : '0',      // 1 = tartili, 0 = adet
        (item.taxRateBp / 100).toFixed(2),
        item.barcodeFormat ?? '',
      ].join(','),
    );

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(this.#dir, `plu-${stamp}.csv`);
    const latest = join(this.#dir, 'plu-latest.csv');
    const content = `${[header, ...rows].join('\r\n')}\r\n`;
    await fs.writeFile(file, content, 'latin1');
    await fs.writeFile(latest, content, 'latin1');

    return {
      sent: items.length,
      failed: 0,
      detail: `PLU dosyasi yazildi: ${file} (CL-Works ile teraziye yuklenir)`,
      target: this.name,
    };
  }

  async status(): Promise<DeviceStatus> {
    try {
      await fs.mkdir(this.#dir, { recursive: true });
      return { state: 'CONNECTED', detail: 'Dosya yolu erisilebilir', at: Date.now() };
    } catch (error) {
      return { state: 'ERROR', detail: (error as Error).message, at: Date.now() };
    }
  }
}

/**
 * Dogrudan TCP yukleme.
 *
 * CL3000'in cerceve yapisi (komut kodlari, uzunluk alani, checksum) uretici
 * dokumaninda kapalidir ve modele gore degisir. Cihaz uzerinde dogrulanmamis bir
 * protokol implementasyonu "yukledim" deyip TERAZIYI YANLIS FIYATLA birakabilir.
 * Bu yuzden burada tahmin yurutulmez: baglanti test edilir, yukleme reddedilir.
 *
 * Cihaz erisimi saglandiginda yapilacak: CL-Works ile terazi arasindaki trafik
 * kaydedilir, cerceve cozulur ve `syncItems` bu dosyada uygulanir. Ust katmanlarda
 * hicbir degisiklik gerekmez.
 */
export class CasTcpScale implements ScalePort {
  readonly name: string;
  readonly #host: string;
  readonly #port: number;

  constructor(options: { host: string; port?: number }) {
    this.#host = options.host;
    this.#port = options.port ?? 20304;
    this.name = `CAS TCP ${this.#host}:${this.#port}`;
  }

  async syncItems(items: readonly ScalePluItem[]): Promise<ScaleSyncResult> {
    const reachable = await this.status();
    return {
      sent: 0,
      failed: items.length,
      detail:
        `CL3000 dogrudan yukleme protokolu bu cihazda henuz dogrulanmadi. ` +
        `Baglanti durumu: ${reachable.state}. ` +
        `Su an CSV disa aktarim + CL-Works kullanilmalidir (adapter: CSV_EXPORT).`,
      target: this.name,
    };
  }

  async status(): Promise<DeviceStatus> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.#host, port: this.#port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ state: 'DISCONNECTED', detail: 'Zaman asimi', at: Date.now() });
      }, 3000);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ state: 'CONNECTED', detail: 'Port acik', at: Date.now() });
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        resolve({ state: 'DISCONNECTED', detail: error.message, at: Date.now() });
      });
    });
  }
}

export class SimulatorScale implements ScalePort {
  readonly name = 'Simulator terazi (TEST)';
  readonly synced: ScalePluItem[] = [];

  async syncItems(items: readonly ScalePluItem[]): Promise<ScaleSyncResult> {
    this.synced.push(...items);
    return { sent: items.length, failed: 0, detail: 'SIMULATOR', target: this.name };
  }

  async status(): Promise<DeviceStatus> {
    return { state: 'CONNECTED', detail: 'SIMULATOR', at: Date.now() };
  }
}
