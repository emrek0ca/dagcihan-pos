/**
 * Miktar aritmetigi. TUM miktarlar TAM SAYI MILLI-BIRIM'dir (olcek 1000).
 * 0,750 kg => 750 ; 3 adet => 3000
 */
import { type Money, money, roundedDiv } from '../money/money.ts';

export type Quantity = number & { readonly __quantity: unique symbol };

export const QUANTITY_SCALE = 1000;
export const ONE_UNIT = 1000 as Quantity;

export type ProductUnit = 'EACH' | 'KG';

const MAX_QUANTITY = 100_000 * QUANTITY_SCALE;

export function quantity(milli: number): Quantity {
  if (!Number.isSafeInteger(milli)) {
    throw new RangeError(`Quantity tam sayi milli-birim olmali: ${milli}`);
  }
  if (Math.abs(milli) > MAX_QUANTITY) throw new RangeError(`Quantity sinir disi: ${milli}`);
  return milli as Quantity;
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a + b);
}

export function subQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a - b);
}

/** Adet birimli urunlerde miktar tam katlar olmali (0,5 adet olmaz) */
export function isWholeUnits(q: Quantity): boolean {
  return q % QUANTITY_SCALE === 0;
}

/**
 * Satir tutari = miktar * birim fiyat / 1000, ticari yuvarlama ile.
 * 0,750 kg * 120,00 TL/kg = 90,00 TL  ->  quantity 750, unitPrice 12000 -> 9000
 */
export function lineAmount(q: Quantity, unitPrice: Money): Money {
  return money(roundedDiv(q * unitPrice, QUANTITY_SCALE));
}

/**
 * Tutar gomulu barkodda miktarin geri turetilmesi (stok icin; fiyat icin DEGIL).
 * unitPrice 0 ise turetilemez.
 */
export function deriveQuantity(amount: Money, unitPrice: Money): Quantity | null {
  if (unitPrice <= 0) return null;
  return quantity(roundedDiv(amount * QUANTITY_SCALE, unitPrice));
}

/** "0,750" | "0.750" | "1" -> milli-birim */
export function parseQuantity(input: string): Quantity {
  const raw = input.trim().replace(/\s/g, '').replace(',', '.');
  if (raw === '') throw new RangeError('Bos miktar');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new RangeError(`Gecersiz miktar: ${input}`);
  const neg = raw.startsWith('-');
  const [intPart = '0', fracPart = ''] = raw.replace('-', '').split('.');
  const frac = (fracPart + '0000').slice(0, 4);
  const base = Number(intPart) * QUANTITY_SCALE + Number(frac.slice(0, 3));
  const fourth = Number(frac[3] ?? '0');
  const value = base + (fourth >= 5 ? 1 : 0);
  return quantity(neg ? -value : value);
}

/** 750 -> "0,750" ; 3000 (EACH) -> "3" */
export function formatQuantity(q: Quantity, unit: ProductUnit): string {
  const neg = q < 0;
  const abs = Math.abs(q);
  if (unit === 'EACH' && abs % QUANTITY_SCALE === 0) {
    return `${neg ? '-' : ''}${abs / QUANTITY_SCALE}`;
  }
  const whole = Math.trunc(abs / QUANTITY_SCALE);
  const frac = String(abs % QUANTITY_SCALE).padStart(3, '0');
  return `${neg ? '-' : ''}${whole},${frac}`;
}

export function formatQuantityWithUnit(q: Quantity, unit: ProductUnit): string {
  return unit === 'KG' ? `${formatQuantity(q, unit)} kg` : `${formatQuantity(q, unit)} adet`;
}
