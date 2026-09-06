/**
 * Derleme sonrasi varlik kopyalama.
 * tsc yalnizca .ts dosyalarini uretir; SQL migration'lari ve CommonJS preload
 * dosyasi elle kopyalanir. Windows/macOS/Linux'ta ayni sekilde calisir.
 */
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const copies = [
  ['src/data/migrations', 'dist/src/data/migrations'],
  ['desktop/preload.cjs', 'dist/desktop/preload.cjs'],
];

for (const [from, to] of copies) {
  const source = join(root, from);
  const target = join(root, to);
  if (!existsSync(source)) {
    console.error(`Kaynak bulunamadi: ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log(`kopyalandi: ${from} -> ${to}`);
}
