/**
 * Uygulama simgesini uretir (build/icon.png).
 * Harici bagimlilik yok: ham piksel + zlib ile PNG yazilir.
 * electron-builder bu PNG'den Windows .ico dosyasini kendisi uretir.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buffer) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// --- cizim: koyu yuvarlak kare + fis serisi + barkod cizgileri
const pixels = Buffer.alloc(SIZE * SIZE * 4);
const put = (x, y, r, g, b, a = 255) => {
  const i = (y * SIZE + x) * 4;
  pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
};

const radius = 96;
const inside = (x, y) => {
  const cx = Math.min(Math.max(x, radius), SIZE - radius);
  const cy = Math.min(Math.max(y, radius), SIZE - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inside(x, y)) { put(x, y, 0, 0, 0, 0); continue; }
    // ust koyu maviden alt lacivert'e gecis (POS arayuzuyle ayni palet)
    const t = y / SIZE;
    put(x, y, Math.round(23 + t * 8), Math.round(33 + t * 6), Math.round(44 + t * 8));
  }
}

// fis govdesi (beyaz)
const rx = 128, ry = 104, rw = SIZE - 256, rh = 224;
for (let y = ry; y < ry + rh; y++) {
  for (let x = rx; x < rx + rw; x++) put(x, y, 236, 240, 246);
}
// fisin ziczak alt kenari
for (let x = rx; x < rx + rw; x++) {
  const depth = 16 - Math.abs(((x - rx) % 32) - 16);
  for (let y = ry + rh; y < ry + rh + depth; y++) put(x, y, 236, 240, 246);
}
// fis uzerindeki satirlar
const line = (y, from, to, shade) => {
  for (let x = from; x < to; x++) {
    for (let d = 0; d < 14; d++) put(x, y + d, shade, shade, shade);
  }
};
line(150, rx + 28, rx + 150, 120);
line(150, rx + rw - 90, rx + rw - 28, 120);
line(196, rx + 28, rx + 170, 150);
line(196, rx + rw - 110, rx + rw - 28, 150);
line(242, rx + 28, rx + 130, 150);
line(242, rx + rw - 96, rx + rw - 28, 150);

// alt kisimda barkod cizgileri (mavi)
const widths = [8, 4, 12, 4, 8, 16, 4, 8, 4, 12, 8, 4];
let bx = rx + 24;
for (const [index, width] of widths.entries()) {
  if (index % 2 === 0) {
    for (let x = bx; x < bx + width && x < rx + rw - 24; x++) {
      for (let y = 372; y < 440; y++) put(x, y, 47, 129, 247);
    }
  }
  bx += width + 6;
}

// --- PNG olarak yaz
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.png'), png);
console.log(`build/icon.png yazildi (${SIZE}x${SIZE}, ${Math.round(png.length / 1024)} KB)`);
