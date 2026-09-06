/**
 * Yazici karakter kodlamasi.
 *
 * Termal yazicilar UTF-8 anlamaz; tek baytlik bir kod sayfasi kullanirlar.
 * Turkce icin iki yaygin secenek vardir:
 *   CP857  (DOS Turkish)      - eski/klasik ESC-POS kod sayfasi
 *   CP1254 (Windows Turkish)  - Latin-1 ustune Turkce harfler
 *
 * Hangi kod sayfasinin hangi `ESC t n` indeksiyle secildigi MODELE gore degisir.
 * Bu yuzden indeks konfigurasyondan gelir ve `pos printer test` komutu
 * adaylari tek tek basarak dogru olani magazada belirlemeyi saglar.
 * Eslenemeyen karakterler ASCII'ye cevrilir - fis asla bozuk basilmaz.
 */

export type CodePageName = 'CP857' | 'CP1254' | 'ASCII';

/** CP857 (DOS Turkish) - Turkce ve yaygin Latin harfleri */
const CP857: Record<string, number> = {
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'å': 0x86, 'ç': 0x87,
  'ê': 0x88, 'ë': 0x89, 'è': 0x8a, 'ï': 0x8b, 'î': 0x8c, 'ı': 0x8d, 'Ä': 0x8e, 'Å': 0x8f,
  'É': 0x90, 'æ': 0x91, 'Æ': 0x92, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95, 'û': 0x96, 'ù': 0x97,
  'İ': 0x98, 'Ö': 0x99, 'Ü': 0x9a, 'ø': 0x9b, '£': 0x9c, 'Ø': 0x9d, 'Ş': 0x9e, 'ş': 0x9f,
  'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'Ğ': 0xa6, 'ğ': 0xa7,
  '¿': 0xa8, '®': 0xa9, '¬': 0xaa, '½': 0xab, '¼': 0xac, '¡': 0xad, '«': 0xae, '»': 0xaf,
};

/** CP1254 (Windows-1254 / Latin-5) */
const CP1254: Record<string, number> = {
  'Ğ': 0xd0, 'ğ': 0xf0, 'İ': 0xdd, 'ı': 0xfd, 'Ş': 0xde, 'ş': 0xfe,
  'Ç': 0xc7, 'ç': 0xe7, 'Ö': 0xd6, 'ö': 0xf6, 'Ü': 0xdc, 'ü': 0xfc,
  'Â': 0xc2, 'â': 0xe2, 'Î': 0xce, 'î': 0xee, 'Û': 0xdb, 'û': 0xfb,
  '€': 0x80, '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '–': 0x96, '—': 0x97,
  '£': 0xa3, '½': 0xbd, '¼': 0xbc, '«': 0xab, '»': 0xbb, '°': 0xb0,
};

/** Kod sayfasinda karsiligi olmayan karakterler icin ASCII karsiligi */
const TRANSLITERATE: Record<string, string> = {
  'ı': 'i', 'İ': 'I', 'ş': 's', 'Ş': 'S', 'ğ': 'g', 'Ğ': 'G',
  'ç': 'c', 'Ç': 'C', 'ö': 'o', 'Ö': 'O', 'ü': 'u', 'Ü': 'U',
  'â': 'a', 'Â': 'A', 'î': 'i', 'Î': 'I', 'û': 'u', 'Û': 'U',
  '₺': 'TL', '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '€': 'EUR',
};

function tableFor(codePage: CodePageName): Record<string, number> | null {
  switch (codePage) {
    case 'CP857': return CP857;
    case 'CP1254': return CP1254;
    case 'ASCII': return null;
  }
}

/** Metni yazicinin anlayacagi tek baytlik kodlamaya cevirir */
export function encodeText(text: string, codePage: CodePageName): Uint8Array {
  const table = tableFor(codePage);
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const mapped = table?.[ch];
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }
    // Latin-1 araligi CP1254'te dogrudan gecerlidir
    if (codePage === 'CP1254' && code <= 0xff && !(code >= 0x80 && code <= 0x9f)) {
      out.push(code);
      continue;
    }
    const ascii = TRANSLITERATE[ch];
    if (ascii !== undefined) {
      for (const a of ascii) out.push(a.charCodeAt(0));
      continue;
    }
    out.push(0x3f); // '?'
  }
  return Uint8Array.from(out);
}

/** Turkce karakterleri ASCII'ye indirger (kod sayfasi belirsizken guvenli mod) */
export function toAscii(text: string): string {
  let out = '';
  for (const ch of text) {
    out += ch.codePointAt(0)! < 0x80 ? ch : (TRANSLITERATE[ch] ?? '?');
  }
  return out;
}

/** ESC t komutu icin yaygin kod sayfasi indeksleri (model bazinda degisir) */
export const CODE_PAGE_CANDIDATES: readonly { index: number; label: string; codePage: CodePageName }[] = [
  { index: 15, label: 'PC857 (aday 15)', codePage: 'CP857' },
  { index: 40, label: 'PC857 (aday 40)', codePage: 'CP857' },
  { index: 12, label: 'PC857 (aday 12)', codePage: 'CP857' },
  { index: 25, label: 'WPC1254 (aday 25)', codePage: 'CP1254' },
  { index: 33, label: 'WPC1254 (aday 33)', codePage: 'CP1254' },
];
