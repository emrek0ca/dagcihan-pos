/**
 * Barkod kontrol hanesi algoritmalari. Saf fonksiyonlar, I/O yok.
 */

export type CheckDigitAlgorithm = 'NONE' | 'EAN13' | 'EAN8' | 'UPCA' | 'MOD10';
export type EmbeddedCheckAlgorithm = 'NONE' | 'MOD10' | 'PRICE_CHECK_4_GS1';

function digits(s: string): number[] | null {
  const out: number[] = [];
  for (const ch of s) {
    const d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) return null;
    out.push(d);
  }
  return out;
}

/**
 * GTIN ailesi (EAN13/EAN8/UPCA) icin standart mod-10 kontrol hanesi.
 * Agirliklar sagdan sola 3,1,3,1... seklindedir; bu sayede tek fonksiyon
 * tum GTIN uzunluklarini dogru hesaplar.
 */
export function gtinCheckDigit(payload: string): number | null {
  const d = digits(payload);
  if (d === null || d.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    // sagdan ilk hane agirlik 3
    const fromRight = d.length - 1 - i;
    sum += d[i]! * (fromRight % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** Basit mod-10 (agirlik 1) - bazi dahili formatlarda kullanilir */
export function mod10CheckDigit(payload: string): number | null {
  const d = digits(payload);
  if (d === null) return null;
  const sum = d.reduce((a, b) => a + b, 0);
  return (10 - (sum % 10)) % 10;
}

const EXPECTED_LENGTH: Record<Exclude<CheckDigitAlgorithm, 'NONE' | 'MOD10'>, number> = {
  EAN13: 13,
  EAN8: 8,
  UPCA: 12,
};

/**
 * Barkodun tamaminin (kontrol hanesi dahil) gecerliligini dogrular.
 * NONE -> her zaman gecerli.
 */
export function verifyCheckDigit(code: string, algorithm: CheckDigitAlgorithm): boolean {
  if (algorithm === 'NONE') return true;
  if (algorithm !== 'MOD10') {
    const expected = EXPECTED_LENGTH[algorithm];
    if (code.length !== expected) return false;
  }
  if (code.length < 2) return false;
  const payload = code.slice(0, -1);
  const actual = code.charCodeAt(code.length - 1) - 48;
  if (actual < 0 || actual > 9) return false;
  const computed = algorithm === 'MOD10' ? mod10CheckDigit(payload) : gtinCheckDigit(payload);
  return computed !== null && computed === actual;
}

/** Eksik kontrol hanesini hesaplayip barkodu tamamlar (etiket uretimi/test icin) */
export function appendCheckDigit(payload: string, algorithm: CheckDigitAlgorithm): string {
  if (algorithm === 'NONE') return payload;
  const cd = algorithm === 'MOD10' ? mod10CheckDigit(payload) : gtinCheckDigit(payload);
  if (cd === null) throw new RangeError(`Kontrol hanesi hesaplanamadi: ${payload}`);
  return payload + String(cd);
}

// ---------------------------------------------------------------------------
// Gomulu (fiyat/agirlik alani ici) kontrol hanesi
// ---------------------------------------------------------------------------

// GS1 "price/weight check digit" agirlik tablolari (4 haneli alan icin)
const W2 = [0, 2, 4, 6, 8, 9, 1, 3, 5, 7];
const W3 = [0, 3, 6, 9, 2, 5, 8, 1, 4, 7];
const W5 = [0, 5, 1, 6, 2, 7, 3, 8, 4, 9];

/**
 * GS1 4 haneli fiyat/agirlik kontrol hanesi.
 *
 * !! DIKKAT: Bu algoritmanin varyantlari uretici bazinda farklilik gosterebilir.
 * Bu implementasyon gercek bir CAS CL3000 etiketi ile DOGRULANMADAN
 * uretimde etkinlestirilmemelidir. Varsayilan konfigurasyonda kapalidir;
 * `pos barcode analyze` komutu toplanan gercek etiketlerle hangi varyantin
 * tuttugunu otomatik test eder.
 */
export function priceCheck4Gs1(fourDigits: string): number | null {
  if (fourDigits.length !== 4) return null;
  const d = digits(fourDigits);
  if (d === null) return null;
  const sum = W2[d[0]!]! + W2[d[1]!]! + W3[d[2]!]! + W5[d[3]!]!;
  return (10 - (sum % 10)) % 10;
}

export function verifyEmbeddedCheck(
  valueField: string,
  checkDigit: string,
  algorithm: EmbeddedCheckAlgorithm,
): boolean {
  if (algorithm === 'NONE') return true;
  const actual = checkDigit.charCodeAt(0) - 48;
  if (checkDigit.length !== 1 || actual < 0 || actual > 9) return false;
  const computed =
    algorithm === 'MOD10' ? mod10CheckDigit(valueField) : priceCheck4Gs1(valueField);
  return computed !== null && computed === actual;
}
