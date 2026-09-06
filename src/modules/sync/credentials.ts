/**
 * Cihaz token'inin yerel saklanmasi.
 *
 * Token AYRI bir dosyada, YALNIZCA kullanicinin okuyabilecegi izinlerle tutulur
 * (Windows'ta %APPDATA% zaten kullaniciya ozeldir; POSIX'te 0600 uygulanir).
 * Veritabaninda tutulmaz: veritabani yedekleri kopyalanip tasinabilir,
 * token'in yedekle birlikte dolasmasi istenmez.
 *
 * NOT: Token duz metin saklanir cunku istemcinin sunucuya sunmasi gerekir.
 * Calinmasi durumunda tek gercek savunma SUNUCU TARAFI IPTALdir
 * (yonetim ekranindan terminal iptal edilir, token aninda gecersiz olur).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeviceCredentials {
  readonly serverUrl: string;
  readonly token: string;
  readonly terminalId: string;
  readonly terminalCode: string;
  readonly storeId: string;
  readonly storeCode: string;
  readonly storeName: string;
  readonly organizationId: string;
  readonly enrolledAt: string;
}

export class CredentialStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  get path(): string {
    return this.#file;
  }

  exists(): boolean {
    return existsSync(this.#file);
  }

  read(): DeviceCredentials | null {
    if (!existsSync(this.#file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as DeviceCredentials;
      if (typeof parsed.token !== 'string' || typeof parsed.serverUrl !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(credentials: DeviceCredentials): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
    try {
      chmodSync(this.#file, 0o600);
    } catch {
      // Windows'ta chmod etkisizdir; koruma dosya sistemi ACL'ine birakilir
    }
  }

  clear(): void {
    rmSync(this.#file, { force: true });
  }
}
