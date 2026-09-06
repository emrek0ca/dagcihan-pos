/**
 * Karakter akisini tam barkodlara bolme (framing).
 *
 * Seri/HID okuyucular barkodu karakter karakter gonderir. Bir okumanin bittigi
 * iki sekilde anlasilir:
 *   1. Sonlandirici karakter (CR/LF/TAB - okuyucu ayarina gore)
 *   2. Karakterler arasi sessizlik (interCharTimeoutMs) - sonlandirici yoksa
 *
 * Saf mantiktir: zamani disaridan alir, boylece testte deterministiktir.
 */
export interface FramerOptions {
  readonly terminators: readonly string[];
  readonly interCharTimeoutMs: number;
  readonly maxLength?: number;
}

export class BarcodeFramer {
  #buffer = '';
  #lastCharAt = 0;
  readonly #options: FramerOptions;

  constructor(options: FramerOptions) {
    this.#options = options;
  }

  get pending(): string {
    return this.#buffer;
  }

  /** Gelen parcayi isler, tamamlanan barkodlari dondurur */
  push(chunk: string, at: number): string[] {
    const complete: string[] = [];
    const maxLength = this.#options.maxLength ?? 64;

    // Sessizlik suresi asildiysa yarim kalan tampon kendi basina bir okumadir
    if (
      this.#buffer.length > 0 &&
      at - this.#lastCharAt > this.#options.interCharTimeoutMs
    ) {
      complete.push(this.#buffer);
      this.#buffer = '';
    }

    for (const ch of chunk) {
      this.#lastCharAt = at;
      if (this.#options.terminators.includes(ch)) {
        if (this.#buffer.length > 0) {
          complete.push(this.#buffer);
          this.#buffer = '';
        }
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) continue; // diger kontrol karakterleri atlanir
      this.#buffer += ch;
      if (this.#buffer.length >= maxLength) {
        complete.push(this.#buffer);
        this.#buffer = '';
      }
    }
    return complete;
  }

  /** Sessizlik zaman asimi doldugunda cagrilir; bekleyen tamponu tamamlar */
  flushIfIdle(at: number): string | null {
    if (this.#buffer.length === 0) return null;
    if (at - this.#lastCharAt < this.#options.interCharTimeoutMs) return null;
    const value = this.#buffer;
    this.#buffer = '';
    return value;
  }

  reset(): void {
    this.#buffer = '';
  }
}
