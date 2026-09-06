/**
 * Dosya tabanli uygulama gunlugu.
 *
 * Magazada sorun yasandiginda "ne olmustu" sorusunun cevabi buradadir.
 * Konsol da aynalanir; log yazilamamasi uygulamayi asla durdurmaz.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export class FileLogger {
  readonly #dir: string;
  readonly #keepDays: number;
  #day = '';
  #closed = false;

  constructor(options: { dir: string; keepDays?: number }) {
    this.#dir = options.dir;
    this.#keepDays = options.keepDays ?? 30;
    mkdirSync(this.#dir, { recursive: true });
    this.#day = this.#today();
    this.prune();
  }

  get file(): string {
    return join(this.#dir, `pos-${this.#day}.log`);
  }

  #today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Gun degistiyse yeni dosyaya gecer */
  #rotate(): void {
    this.#day = this.#today();
  }

  write(level: LogLevel, message: string, detail?: unknown): void {
    this.#rotate();
    const time = new Date().toISOString();
    let line = `${time} ${level.padEnd(5)} ${message}`;
    if (detail !== undefined) {
      const text =
        detail instanceof Error
          ? `${detail.message}\n${detail.stack ?? ''}`
          : safeStringify(detail);
      line += ` | ${text}`;
    }
    // Senkron yazim bilincli: uygulama bir hatanin hemen ardindan kapanirsa
    // o satirin diske dusmus olmasi gerekir (magazada tek kanit budur).
    try {
      appendFileSync(this.file, `${line}\n`);
    } catch {
      /* log yazilamamasi POS'u durdurmaz */
    }
    const target = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    target(line);
  }

  info(message: string, detail?: unknown): void {
    this.write('INFO', message, detail);
  }
  warn(message: string, detail?: unknown): void {
    this.write('WARN', message, detail);
  }
  error(message: string, detail?: unknown): void {
    this.write('ERROR', message, detail);
  }

  prune(): number {
    const cutoff = Date.now() - this.#keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      for (const name of readdirSync(this.#dir)) {
        if (!name.startsWith('pos-') || !name.endsWith('.log')) continue;
        const day = name.slice(4, -4);
        const at = Date.parse(day);
        if (Number.isFinite(at) && at < cutoff) {
          rmSync(join(this.#dir, name), { force: true });
          removed++;
        }
      }
    } catch {
      /* yok say */
    }
    return removed;
  }

  close(): void {
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
