/**
 * Donanim kesfi (ilk kurulum sihirbazi icin).
 *
 * ILKELER
 *  - Hicbir cagri asili kalmaz: her islemin zaman asimi vardir.
 *  - Windows disinda calistirildiginda (gelistirme/test) HATA VERMEZ,
 *    bos liste + acik bir not doner.
 *  - Kesif "tahmin"dir; KESIN dogrulama her zaman gercek testtir:
 *    yaziciya test fisi basmak, okuyucudan gercek barkod almak.
 */
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

async function powershell(script: string, timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  return stdout;
}

function parseJsonList<T>(raw: string): T[] {
  const text = raw.trim();
  if (text === '') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ yazicilar

export interface WindowsPrinter {
  readonly name: string;
  readonly portName: string;
  readonly driverName: string;
  readonly shared: boolean;
  readonly shareName: string | null;
  readonly isDefault: boolean;
  /** Isminden/surucusunden termal fis yazicisi oldugu tahmin ediliyor mu */
  readonly likelyReceiptPrinter: boolean;
  /** Ham bayt gonderilebilmesi icin kullanilacak paylasim yolu */
  readonly sharePath: string | null;
}

const RECEIPT_HINTS = [
  'xprinter', 'xp-', 'pos-', 'pos58', 'pos80', 'thermal', 'termal', 'receipt',
  'epson tm', 'tm-t', 'star tsp', 'bixolon', 'gprinter', 'rongta', 'zjiang', '80mm', '58mm',
];

function looksLikeReceiptPrinter(name: string, driver: string): boolean {
  const text = `${name} ${driver}`.toLowerCase();
  return RECEIPT_HINTS.some((hint) => text.includes(hint));
}

export async function listWindowsPrinters(): Promise<{
  printers: WindowsPrinter[]; supported: boolean; note?: string;
}> {
  if (!isWindows) {
    return {
      printers: [],
      supported: false,
      note: 'Windows yazici listesi yalnizca Windows uzerinde okunabilir.',
    };
  }
  try {
    const raw = await powershell(
      'Get-Printer | Select-Object Name,PortName,DriverName,Shared,ShareName,Default ' +
      '| ConvertTo-Json -Compress -Depth 3',
    );
    const rows = parseJsonList<{
      Name: string; PortName: string; DriverName: string;
      Shared: boolean; ShareName: string | null; Default: boolean;
    }>(raw);
    return {
      printers: rows.map((row) => ({
        name: row.Name,
        portName: row.PortName ?? '',
        driverName: row.DriverName ?? '',
        shared: row.Shared === true,
        shareName: row.ShareName ?? null,
        isDefault: row.Default === true,
        likelyReceiptPrinter: looksLikeReceiptPrinter(row.Name ?? '', row.DriverName ?? ''),
        sharePath: row.Shared === true && row.ShareName
          ? `\\\\localhost\\${row.ShareName}`
          : null,
      })),
      supported: true,
    };
  } catch (error) {
    return {
      printers: [],
      supported: true,
      note: `Yazici listesi alinamadi: ${(error as Error).message}`,
    };
  }
}

/**
 * Ham bayt gonderebilmek icin yaziciyi yerel paylasima acar.
 * Yonetici yetkisi gerekir; basarisiz olursa elle yapilacak adim raporlanir.
 */
export async function shareWindowsPrinter(
  printerName: string,
  shareName: string,
): Promise<{ ok: boolean; sharePath?: string; error?: string }> {
  if (!isWindows) return { ok: false, error: 'Yalnizca Windows' };
  const safeShare = shareName.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) || 'POSPRINTER';
  try {
    await powershell(
      `Set-Printer -Name '${printerName.replace(/'/g, "''")}' -Shared $true ` +
      `-ShareName '${safeShare}'`,
    );
    return { ok: true, sharePath: `\\\\localhost\\${safeShare}` };
  } catch (error) {
    return {
      ok: false,
      error:
        `Yazici paylasima acilamadi (yonetici yetkisi gerekebilir): ` +
        `${(error as Error).message}`,
    };
  }
}

// ------------------------------------------------------------------ ag yazicilari

export interface NetworkPrinter {
  readonly host: string;
  readonly port: number;
  /** ESC/POS durum sorgusuna yanit verdi mi (gercek fis yazicisi gostergesi) */
  readonly respondsToEscPos: boolean;
}

function localSubnets(): string[] {
  const prefixes = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Yalnizca /24 taranir; daha genis aglarda tarama pratik degildir
      const parts = address.address.split('.');
      if (parts.length === 4) prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
    }
  }
  return [...prefixes];
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** ESC/POS gercek zamanli durum sorgusu: cihazin fis yazicisi oldugunu dogrular */
function escPosProbe(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(Uint8Array.from([0x10, 0x04, 1])));
    socket.once('data', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Yerel agda RAW 9100 portu acik cihazlari arar.
 * Tarama eszamanli ve kisa zaman asimlidir; tipik bir /24 agda birkac saniye surer.
 */
export async function scanNetworkPrinters(options: {
  port?: number; timeoutMs?: number; concurrency?: number; subnet?: string;
} = {}): Promise<{ printers: NetworkPrinter[]; scanned: number; subnets: string[] }> {
  const port = options.port ?? 9100;
  const timeoutMs = options.timeoutMs ?? 400;
  const concurrency = options.concurrency ?? 64;
  const subnets = options.subnet !== undefined ? [options.subnet] : localSubnets();

  const targets: string[] = [];
  for (const prefix of subnets) {
    for (let host = 1; host <= 254; host++) targets.push(`${prefix}.${host}`);
  }

  const found: NetworkPrinter[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (index < targets.length) {
      const host = targets[index++]!;
      if (await probe(host, port, timeoutMs)) {
        found.push({ host, port, respondsToEscPos: await escPosProbe(host, port) });
      }
    }
  });
  await Promise.all(workers);

  found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  return { printers: found, scanned: targets.length, subnets };
}

// ------------------------------------------------------------------ okuyucular

export interface HidCandidate {
  readonly name: string;
  readonly instanceId: string;
  readonly manufacturer: string | null;
  /** Barkod okuyucu olma ihtimali yuksek mi (isim/uretici ipuclari) */
  readonly likelyScanner: boolean;
}

const SCANNER_HINTS = [
  'perkon', 'ps5700', 'barcode', 'barkod', 'scanner', 'symbol', 'zebra', 'honeywell',
  'datalogic', 'newland', 'sunlux', 'netum', 'pos-x', 'hid keyboard',
];

export async function listHidCandidates(): Promise<{
  devices: HidCandidate[]; supported: boolean; note?: string;
}> {
  if (!isWindows) {
    return {
      devices: [],
      supported: false,
      note: 'HID cihaz listesi yalnizca Windows uzerinde okunabilir.',
    };
  }
  try {
    const raw = await powershell(
      "Get-PnpDevice -Class 'HIDClass','Keyboard' -Status OK " +
      '| Select-Object FriendlyName,InstanceId,Manufacturer ' +
      '| ConvertTo-Json -Compress -Depth 3',
    );
    const rows = parseJsonList<{
      FriendlyName: string; InstanceId: string; Manufacturer: string | null;
    }>(raw);
    const devices = rows
      .filter((row) => typeof row.FriendlyName === 'string' && row.FriendlyName !== '')
      .map((row) => {
        const text = `${row.FriendlyName} ${row.Manufacturer ?? ''}`.toLowerCase();
        return {
          name: row.FriendlyName,
          instanceId: row.InstanceId ?? '',
          manufacturer: row.Manufacturer ?? null,
          likelyScanner: SCANNER_HINTS.some((hint) => text.includes(hint)),
        };
      });
    // Once muhtemel okuyucular
    devices.sort((a, b) => Number(b.likelyScanner) - Number(a.likelyScanner));
    return { devices, supported: true };
  } catch (error) {
    return {
      devices: [],
      supported: true,
      note: `HID cihaz listesi alinamadi: ${(error as Error).message}`,
    };
  }
}

export async function listSerialPorts(): Promise<{ ports: string[]; supported: boolean }> {
  if (!isWindows) return { ports: [], supported: false };
  try {
    const raw = await powershell(
      '[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress',
    );
    const parsed = parseJsonList<string>(raw);
    return { ports: parsed.filter((p) => typeof p === 'string'), supported: true };
  } catch {
    return { ports: [], supported: true };
  }
}
