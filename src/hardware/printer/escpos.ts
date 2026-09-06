/**
 * ESC/POS komut uretici (Xprinter XP-Q805K ve uyumlu 80mm termal yazicilar).
 * Saf bayt uretimi yapar, I/O yoktur -> tamamen test edilebilir.
 */
import { encodeText, type CodePageName } from './encoding.ts';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = 'LEFT' | 'CENTER' | 'RIGHT';

export interface EscPosOptions {
  readonly codePage: CodePageName;
  /** ESC t <index> - modele gore degisir, konfigurasyondan gelir */
  readonly codePageIndex: number;
  readonly charactersPerLine: number;
}

export class EscPosBuilder {
  readonly #bytes: number[] = [];
  readonly #options: EscPosOptions;

  constructor(options: EscPosOptions) {
    this.#options = options;
  }

  get width(): number {
    return this.#options.charactersPerLine;
  }

  raw(...bytes: number[]): this {
    this.#bytes.push(...bytes);
    return this;
  }

  /** ESC @ - yaziciyi bilinen bir duruma getirir */
  init(): this {
    this.raw(ESC, 0x40);
    this.raw(ESC, 0x74, this.#options.codePageIndex);
    return this;
  }

  align(mode: Align): this {
    const value = mode === 'LEFT' ? 0 : mode === 'CENTER' ? 1 : 2;
    return this.raw(ESC, 0x61, value);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  underline(on: boolean): this {
    return this.raw(ESC, 0x2d, on ? 1 : 0);
  }

  /** GS ! - genislik/yukseklik carpani (0-7) */
  size(width: number, height: number): this {
    const w = Math.max(0, Math.min(7, width));
    const h = Math.max(0, Math.min(7, height));
    return this.raw(GS, 0x21, (w << 4) | h);
  }

  text(value: string): this {
    const encoded = encodeText(value, this.#options.codePage);
    this.#bytes.push(...encoded);
    return this;
  }

  line(value = ''): this {
    return this.text(value).raw(LF);
  }

  feed(lines = 1): this {
    for (let i = 0; i < lines; i++) this.raw(LF);
    return this;
  }

  /** Sol ve saga yaslanmis iki sutun (fis satirlarinin temeli) */
  columns(left: string, right: string, width = this.#options.charactersPerLine): this {
    const l = left ?? '';
    const r = right ?? '';
    const space = width - l.length - r.length;
    if (space >= 1) return this.line(l + ' '.repeat(space) + r);
    // Sigmiyorsa sol tarafi kirp, sag taraf (tutar) asla kirpilmaz
    const maxLeft = Math.max(0, width - r.length - 1);
    return this.line(`${l.slice(0, maxLeft)} ${r}`);
  }

  rule(char = '-'): this {
    return this.line(char.repeat(this.#options.charactersPerLine));
  }

  /** GS V - kagit kesme (66 = besleme sonrasi kismi kesme) */
  cut(): this {
    return this.feed(4).raw(GS, 0x56, 66, 0x00);
  }

  /** ESC p - para cekmecesi acma darbesi */
  openDrawer(pin: 0 | 1 = 0): this {
    return this.raw(ESC, 0x70, pin, 25, 250);
  }

  /** GS k - barkod basimi (CODE128, fis numarasi icin) */
  barcodeCode128(data: string, height = 60): this {
    const payload = `{B${data}`;
    this.raw(GS, 0x68, height);      // yukseklik
    this.raw(GS, 0x77, 2);           // genislik
    this.raw(GS, 0x48, 0);           // HRI yazdirma
    this.raw(GS, 0x6b, 73, payload.length);
    for (const ch of payload) this.raw(ch.charCodeAt(0) & 0x7f);
    return this;
  }

  /** GS ( k - QR kod (fis dogrulama icin) */
  qr(data: string, size = 6): this {
    const bytes = encodeText(data, 'ASCII');
    this.raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0);            // model 2
    this.raw(GS, 0x28, 0x6b, 3, 0, 49, 67, Math.max(1, Math.min(16, size))); // modul boyu
    this.raw(GS, 0x28, 0x6b, 3, 0, 49, 69, 49);               // hata duzeltme M
    const len = bytes.length + 3;
    this.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 49, 80, 48);
    this.#bytes.push(...bytes);
    this.raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48);               // bas
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/** DLE EOT n - gercek zamanli durum sorgusu (yazici cevrimici mi, kagit var mi) */
export const STATUS_QUERY = {
  PRINTER: Uint8Array.from([0x10, 0x04, 1]),
  OFFLINE: Uint8Array.from([0x10, 0x04, 2]),
  ERROR: Uint8Array.from([0x10, 0x04, 3]),
  PAPER: Uint8Array.from([0x10, 0x04, 4]),
} as const;

export interface DecodedPrinterStatus {
  readonly online: boolean;
  readonly coverOpen: boolean;
  readonly paperOut: boolean;
  readonly paperLow: boolean;
  readonly error: boolean;
}

/** DLE EOT 1..4 yanit baytlarini coz (bit anlamları ESC/POS standardidir) */
export function decodeStatus(bytes: {
  printer?: number; offline?: number; error?: number; paper?: number;
}): DecodedPrinterStatus {
  const printer = bytes.printer ?? 0x16;
  const offline = bytes.offline ?? 0x12;
  const error = bytes.error ?? 0x12;
  const paper = bytes.paper ?? 0x12;
  return {
    online: (printer & 0x08) === 0,
    coverOpen: (offline & 0x04) !== 0,
    paperOut: (paper & 0x60) === 0x60,
    paperLow: (paper & 0x0c) === 0x0c,
    error: (error & 0x40) !== 0,
  };
}
