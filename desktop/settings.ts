/**
 * Masaustu tercihleri (tam ekran, otomatik acilis, ekran uykusu).
 * POS is ayarlarindan AYRI tutulur: bunlar makineye ozgudur, magazaya degil.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DesktopSettings {
  kiosk: boolean;
  fullscreen: boolean;
  autoStart: boolean;
  preventDisplaySleep: boolean;
  zoomFactor: number;
}

const DEFAULTS: DesktopSettings = {
  kiosk: false,
  fullscreen: true,
  autoStart: true,
  preventDisplaySleep: true,
  zoomFactor: 1,
};

export class SettingsStore {
  readonly #file: string;
  #value: DesktopSettings;

  constructor(userData: string) {
    this.#file = join(userData, 'desktop-settings.json');
    this.#value = { ...DEFAULTS };
    if (existsSync(this.#file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<DesktopSettings>;
        this.#value = { ...DEFAULTS, ...parsed };
      } catch {
        // Bozuk tercih dosyasi uygulamayi durdurmaz, varsayilana donulur
      }
    }
  }

  get all(): DesktopSettings {
    return { ...this.#value };
  }

  get<K extends keyof DesktopSettings>(key: K): DesktopSettings[K] {
    return this.#value[key];
  }

  set<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]): void {
    this.#value[key] = value;
    this.save();
  }

  save(): void {
    try {
      writeFileSync(this.#file, JSON.stringify(this.#value, null, 2));
    } catch {
      /* yazilamazsa bellekte kalir */
    }
  }
}
