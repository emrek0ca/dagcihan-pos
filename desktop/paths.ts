/**
 * Masaustu uygulamasinin dosya yollari.
 *
 * KURAL: Program klasoru (Program Files) salt-okunurdur ve GUNCELLEMEDE SILINIR.
 * Satis veritabani, konfigurasyon, yedekler ve loglar bu yuzden kullanici veri
 * klasorunde (%APPDATA%\<uygulama>) tutulur. Guncelleme bu klasore dokunmaz.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AppPaths {
  readonly userData: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly logDir: string;
  readonly backupDir: string;
  readonly posConfigFile: string;
  readonly barcodeConfigFile: string;
  readonly databaseFile: string;
}

export function resolveAppPaths(userData: string): AppPaths {
  const configDir = join(userData, 'config');
  const dataDir = join(userData, 'data');
  return {
    userData,
    configDir,
    dataDir,
    logDir: join(userData, 'logs'),
    backupDir: join(dataDir, 'backups'),
    posConfigFile: join(configDir, 'pos.config.json'),
    barcodeConfigFile: join(configDir, 'barcode-rules.json'),
    databaseFile: join(dataDir, 'pos.db'),
  };
}

export function ensureDirectories(paths: AppPaths): void {
  for (const dir of [paths.configDir, paths.dataDir, paths.logDir, paths.backupDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ilk calistirmada varsayilan konfigurasyonu kullanici klasorune kopyalar.
 * MEVCUT DOSYALARIN USTUNE YAZMAZ - guncelleme sonrasi magazanin ayarlari
 * (fiyat serisi, yazici, terazi barkod kurali) oldugu gibi kalir.
 */
export function seedUserConfig(
  paths: AppPaths,
  defaultsDir: string,
): { created: string[]; kept: string[]; addedKeys: string[] } {
  ensureDirectories(paths);
  const created: string[] = [];
  const kept: string[] = [];
  const addedKeys: string[] = [];
  const files: [string, string][] = [
    ['pos.config.json', paths.posConfigFile],
    ['barcode-rules.json', paths.barcodeConfigFile],
  ];
  for (const [name, target] of files) {
    const source = join(defaultsDir, name);
    if (!existsSync(target)) {
      if (!existsSync(source)) continue;
      copyFileSync(source, target);
      created.push(target);
      continue;
    }
    kept.push(target);
    // Yeni surumde EKLENEN ayar anahtarlarini mevcut dosyaya tasi.
    // Var olan degerlere ASLA dokunulmaz: magazanin yaptigi ayar korunur.
    if (existsSync(source)) {
      addedKeys.push(...mergeMissingKeys(source, target, name));
    }
  }
  return { created, kept, addedKeys };
}

/**
 * Varsayilan dosyada olup kullanici dosyasinda OLMAYAN anahtarlari ekler.
 * Mevcut anahtarlarin degeri degistirilmez; diziler bir butun sayilir
 * (barkod kurallari gibi listeler kullanicinin duzenlemesine birakilir).
 */
function mergeMissingKeys(sourceFile: string, targetFile: string, label: string): string[] {
  let defaults: Record<string, unknown>;
  let current: Record<string, unknown>;
  try {
    defaults = JSON.parse(readFileSync(sourceFile, 'utf8')) as Record<string, unknown>;
    current = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return []; // Bozuk JSON'a dokunma; config yukleyici anlamli hata verir
  }

  const added: string[] = [];
  const walk = (from: Record<string, unknown>, to: Record<string, unknown>, path: string): void => {
    for (const [key, value] of Object.entries(from)) {
      const fullPath = path === '' ? key : `${path}.${key}`;
      if (!(key in to)) {
        to[key] = value;
        added.push(`${label}:${fullPath}`);
        continue;
      }
      const target = to[key];
      if (
        value !== null && typeof value === 'object' && !Array.isArray(value) &&
        target !== null && typeof target === 'object' && !Array.isArray(target)
      ) {
        walk(value as Record<string, unknown>, target as Record<string, unknown>, fullPath);
      }
    }
  };
  walk(defaults, current, '');

  if (added.length > 0) {
    writeFileSync(targetFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  }
  return added;
}
