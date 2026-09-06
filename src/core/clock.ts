/** Zaman kaynagi soyutlamasi - testlerde deterministik, uretimde sistem saati. */
export interface Clock {
  now(): number;
  /** Yerel is gunu (YYYY-MM-DD). Gun sonu raporlari buna gore gruplanir. */
  businessDate(at?: number): string;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  businessDate(at: number = Date.now()): string {
    const d = new Date(at);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

export class FixedClock implements Clock {
  #current: number;
  constructor(start: number = Date.parse('2026-01-15T09:00:00')) {
    this.#current = start;
  }
  now(): number {
    return this.#current;
  }
  advance(ms: number): void {
    this.#current += ms;
  }
  set(ms: number): void {
    this.#current = ms;
  }
  businessDate(at: number = this.#current): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
