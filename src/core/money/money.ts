/**
 * Para aritmetigi. TUM tutarlar TAM SAYI KURUS'tur (TRY minor unit).
 * Floating point kesinlikle kullanilmaz; tek yuvarlama noktasi bu dosyadir.
 */

/** Tam sayi kurus. 12,45 TL => 1245 */
export type Money = number & { readonly __money: unique symbol };

/** Yuzde, baz puan (basis point) cinsinden. %10 => 1000, %12,5 => 1250 */
export type BasisPoints = number & { readonly __bp: unique symbol };

export const ZERO = 0 as Money;

const MAX_MONEY = 999_999_999_99; // 999.999.999,99 TL - makul ust sinir

export function money(kurus: number): Money {
  if (!Number.isSafeInteger(kurus)) {
    throw new RangeError(`Money tam sayi kurus olmali: ${kurus}`);
  }
  if (Math.abs(kurus) > MAX_MONEY) {
    throw new RangeError(`Money sinir disi: ${kurus}`);
  }
  return kurus as Money;
}

export function basisPoints(bp: number): BasisPoints {
  if (!Number.isSafeInteger(bp)) throw new RangeError(`BasisPoints tam sayi olmali: ${bp}`);
  return bp as BasisPoints;
}

/** %n -> baz puan. percent(10) === 1000 bp */
export function percent(p: number): BasisPoints {
  const bp = Math.round(p * 100);
  if (!Number.isFinite(bp)) throw new RangeError(`Gecersiz yuzde: ${p}`);
  return bp as BasisPoints;
}

/**
 * Ticari yuvarlama ile tam sayi bolme: yarim, sifirdan UZAGA yuvarlanir.
 * roundedDiv(15, 2) === 8 ; roundedDiv(-15, 2) === -8
 */
export function roundedDiv(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError('Sifira bolme');
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    throw new RangeError('Gecersiz bolme girdisi');
  }
  const neg = (numerator < 0) !== (denominator < 0);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  const rounded = r * 2 >= d ? q + 1 : q;
  return neg ? -rounded : rounded;
}

export function addMoney(...values: Money[]): Money {
  let sum = 0;
  for (const v of values) sum += v;
  return money(sum);
}

export function subMoney(a: Money, b: Money): Money {
  return money(a - b);
}

export function negateMoney(a: Money): Money {
  return money(-a);
}

export function maxMoney(a: Money, b: Money): Money {
  return a >= b ? a : b;
}

export function minMoney(a: Money, b: Money): Money {
  return a <= b ? a : b;
}

/** Tutarin yuzdesi (baz puan). applyBasisPoints(10000, percent(10)) === 1000 */
export function applyBasisPoints(amount: Money, bp: BasisPoints): Money {
  return money(roundedDiv(amount * bp, 10_000));
}

/**
 * KDV DAHIL tutardan KDV tutarini cikarir.
 * taxRateBp: KDV orani baz puan (%20 => 2000)
 */
export function taxFromGross(grossInclTax: Money, taxRateBp: BasisPoints): Money {
  if (taxRateBp === 0) return ZERO;
  return money(roundedDiv(grossInclTax * taxRateBp, 10_000 + taxRateBp));
}

/**
 * Tutari agirliklara gore, TOPLAMI KORUYARAK dagitir (largest-remainder yontemi).
 * Kurus artiklari en buyuk agirliktan baslayarak dagitilir; sum(result) === amount daima.
 */
export function distribute(amount: Money, weights: readonly number[]): Money[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) {
    // Agirlik yoksa esit dagit
    const base = Math.trunc(amount / n);
    const out = Array.from({ length: n }, () => money(base));
    let rest = amount - base * n;
    for (let i = 0; rest !== 0; i = (i + 1) % n) {
      const step = rest > 0 ? 1 : -1;
      out[i] = money(out[i]! + step);
      rest -= step;
    }
    return out;
  }

  const exact = weights.map((w) => (amount * w) / totalWeight);
  const floors = exact.map((e) => Math.trunc(e));
  let remainder = amount - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: Math.abs(e - floors[i]!), weight: weights[i]! }))
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight || a.i - b.i);

  const out = floors.map((f) => money(f));
  const step = remainder >= 0 ? 1 : -1;
  let k = 0;
  while (remainder !== 0) {
    const target = order[k % order.length]!.i;
    out[target] = money(out[target]! + step);
    remainder -= step;
    k++;
  }
  return out;
}

/** "12,45" | "12.45" | "1.234,56" -> 1245 / 123456 kurus */
export function parseMoney(input: string): Money {
  const raw = input.trim().replace(/\s/g, '');
  if (raw === '') throw new RangeError('Bos tutar');
  let normalized: string;
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  if (hasComma && hasDot) {
    // "1.234,56" (TR) veya "1,234.56" (EN) - son gelen ayirici ondaliktir
    normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '');
  } else if (hasComma) {
    normalized = raw.replace(',', '.');
  } else {
    normalized = raw;
  }
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) throw new RangeError(`Gecersiz tutar: ${input}`);
  const neg = normalized.startsWith('-');
  const [intPart = '0', fracPart = ''] = normalized.replace('-', '').split('.');
  const frac2 = (fracPart + '00').slice(0, 3);
  // 3. haneye gore yuvarla
  const base = Number(intPart) * 100 + Number(frac2.slice(0, 2));
  const third = Number(frac2[2] ?? '0');
  const value = base + (third >= 5 ? 1 : 0);
  return money(neg ? -value : value);
}

/** 123456 -> "1.234,56" (TR bicimi, para birimi eki yok) */
export function formatMoney(value: Money): string {
  const neg = value < 0;
  const abs = Math.abs(value);
  const lira = Math.trunc(abs / 100);
  const kurus = abs % 100;
  const liraStr = String(lira).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${liraStr},${String(kurus).padStart(2, '0')}`;
}

export function formatMoneyTRY(value: Money): string {
  return `${formatMoney(value)} TL`;
}
