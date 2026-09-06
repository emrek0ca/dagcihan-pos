/**
 * ESC/POS bayt akisini okunabilir metne cevirir.
 * Kagit harcamadan fis onizlemek ve ciktiyi test etmek icin kullanilir.
 */
export function escPosToPlainText(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;

    if (b === 0x1b) {                       // ESC
      const next = bytes[i + 1];
      // ESC @ = 2 bayt, ESC p = 5 bayt, digerleri 3 bayt.
      // Dongunun kendi i++ artisi telafi edilerek atlanir.
      i += (next === 0x40 ? 2 : next === 0x70 ? 5 : 3) - 1;
      continue;
    }

    if (b === 0x1d) {                       // GS
      const next = bytes[i + 1];
      if (next === 0x6b) {                  // GS k - barkod
        i += 3 + (bytes[i + 3] ?? 0);
        continue;
      }
      if (next === 0x28) {                  // GS ( k - QR
        const length = (bytes[i + 3] ?? 0) + ((bytes[i + 4] ?? 0) << 8);
        i += 4 + length;
        continue;
      }
      if (next === 0x56) {                  // GS V - kesme (4 bayt)
        i += 3;
        continue;
      }
      i += 2;                               // GS ! / h / w / H (3 bayt)
      continue;
    }

    if (b === 0x0a) {
      out += '\n';
      continue;
    }
    if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
  }
  return out;
}
