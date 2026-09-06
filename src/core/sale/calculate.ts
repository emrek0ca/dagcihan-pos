/**
 * Fis hesaplama - sistemin TEK hesaplama noktasi.
 *
 * Guvenceler:
 *  - Toplam korunumu: sum(satir net) - fis indirimi == toplam
 *  - KDV, oran gruplari uzerinden hesaplanir; satirlara toplami bozmadan dagitilir
 *  - Hicbir tutar negatife dusmez
 *  - Ayni girdi daima ayni ciktiyi verir (deterministik)
 */
import {
  ZERO,
  addMoney,
  applyBasisPoints,
  distribute,
  money,
  roundedDiv,
  subMoney,
  taxFromGross,
  type BasisPoints,
  type Money,
} from '../money/money.ts';
import { lineAmount } from '../quantity/quantity.ts';
import { PosError } from '../errors.ts';
import type {
  CalcInput,
  CalcLine,
  CalcLineResult,
  CalcResult,
  CashRoundingMode,
  Discount,
  TaxBucket,
} from './types.ts';

function discountAmountFor(base: Money, discount: Discount | undefined): Money {
  if (discount === undefined) return ZERO;
  if (discount.type === 'PERCENT') {
    if (discount.value < 0 || discount.value > 10_000) {
      throw new PosError('DISCOUNT_INVALID', `Gecersiz indirim yuzdesi: ${discount.value} bp`);
    }
    return applyBasisPoints(base, discount.value as BasisPoints);
  }
  if (discount.value < 0) {
    throw new PosError('DISCOUNT_INVALID', `Negatif indirim tutari: ${discount.value}`);
  }
  // Indirim asla tutari negatife dusuremez
  return money(Math.min(discount.value, base));
}

function roundCash(total: Money, mode: CashRoundingMode): Money {
  switch (mode) {
    case 'NONE':
      return total;
    case 'NEAREST_5_KURUS':
      return money(roundedDiv(total, 5) * 5);
    case 'NEAREST_25_KURUS':
      return money(roundedDiv(total, 25) * 25);
  }
}

export function grossOf(line: CalcLine): Money {
  if (line.fixedGross !== undefined) return line.fixedGross;
  return lineAmount(line.quantity, line.unitPrice);
}

export function calculateSale(input: CalcInput): CalcResult {
  const active = input.lines.filter((l) => l.voided !== true);

  // 1) Satir brut + satir indirimi
  const grossValues: Money[] = [];
  const lineDiscounts: Money[] = [];
  const netAfterLineDiscount: Money[] = [];
  for (const line of active) {
    const gross = grossOf(line);
    const disc = discountAmountFor(gross, line.discount);
    grossValues.push(gross);
    lineDiscounts.push(disc);
    netAfterLineDiscount.push(subMoney(gross, disc));
  }

  const subtotal = addMoney(...netAfterLineDiscount);
  const grossTotal = addMoney(...grossValues);
  const lineDiscountTotal = addMoney(...lineDiscounts);

  // 2) Fis indirimi -> satirlara net oraninda dagitilir (KDV dokumu bozulmasin diye)
  const saleDiscountTotal = discountAmountFor(subtotal, input.saleDiscount);
  const shares =
    saleDiscountTotal === 0
      ? netAfterLineDiscount.map(() => ZERO)
      : distribute(saleDiscountTotal, netAfterLineDiscount);

  const finalNets = netAfterLineDiscount.map((n, i) => subMoney(n, shares[i] ?? ZERO));

  // 3) KDV: once oran grubu bazinda, sonra satirlara dagitilarak (kurus farki olusmaz)
  const groups = new Map<number, number[]>(); // rateBp -> satir indeksleri
  for (const [i, line] of active.entries()) {
    const list = groups.get(line.taxRateBp) ?? [];
    list.push(i);
    groups.set(line.taxRateBp, list);
  }

  const lineTax: Money[] = finalNets.map(() => ZERO);
  const taxBreakdown: TaxBucket[] = [];
  for (const [rateBp, indexes] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const groupNet = addMoney(...indexes.map((i) => finalNets[i] ?? ZERO));
    const groupTax = taxFromGross(groupNet, rateBp as BasisPoints);
    const perLine = distribute(groupTax, indexes.map((i) => finalNets[i] ?? ZERO));
    for (const [k, i] of indexes.entries()) lineTax[i] = perLine[k] ?? ZERO;
    taxBreakdown.push({
      rateBp: rateBp as BasisPoints,
      net: groupNet,
      tax: groupTax,
      base: subMoney(groupNet, groupTax),
    });
  }

  const totalBeforeRounding = subMoney(subtotal, saleDiscountTotal);
  const roundedTotal = roundCash(totalBeforeRounding, input.cashRounding ?? 'NONE');
  const roundingAdjustment = subMoney(roundedTotal, totalBeforeRounding);

  const lines: CalcLineResult[] = active.map((line, i) => ({
    lineNo: line.lineNo,
    gross: grossValues[i] ?? ZERO,
    discountAmount: lineDiscounts[i] ?? ZERO,
    saleDiscountShare: shares[i] ?? ZERO,
    net: finalNets[i] ?? ZERO,
    taxRateBp: line.taxRateBp,
    taxAmount: lineTax[i] ?? ZERO,
  }));

  return {
    lines,
    subtotal,
    grossTotal,
    lineDiscountTotal,
    saleDiscountTotal,
    discountTotal: addMoney(lineDiscountTotal, saleDiscountTotal),
    taxTotal: addMoney(...taxBreakdown.map((b) => b.tax)),
    taxBreakdown,
    roundingAdjustment,
    total: roundedTotal,
    itemCount: active.length,
  };
}

/**
 * Odeme durumu. Nakit para ustu yalnizca nakit odemelerden verilir.
 */
export interface PaymentInput {
  readonly method: 'CASH' | 'CARD';
  /** Musterinin verdigi tutar */
  readonly tendered: Money;
  /** Kart odemesinde alinan tutar (tendered ile ayni olmali) */
  readonly amount?: Money;
}

export interface PaymentSummary {
  readonly applied: readonly { method: 'CASH' | 'CARD'; amount: Money; tendered: Money; change: Money }[];
  readonly paidTotal: Money;
  readonly remaining: Money;
  readonly changeDue: Money;
  readonly settled: boolean;
}

export function summarizePayments(total: Money, payments: readonly PaymentInput[]): PaymentSummary {
  let remaining = total;
  const applied: { method: 'CASH' | 'CARD'; amount: Money; tendered: Money; change: Money }[] = [];
  let changeDue = ZERO;

  for (const p of payments) {
    if (p.tendered < 0) throw new PosError('PAYMENT_INVALID', 'Negatif odeme tutari');
    if (p.method === 'CARD') {
      const amount = p.amount ?? p.tendered;
      if (amount !== p.tendered) {
        throw new PosError('PAYMENT_INVALID', 'Kart odemesinde para ustu verilemez');
      }
      if (amount > remaining) {
        throw new PosError('PAYMENT_EXCEEDS_TOTAL', 'Kart odemesi kalan tutari asamaz', {
          details: { amount, remaining },
        });
      }
      applied.push({ method: 'CARD', amount, tendered: amount, change: ZERO });
      remaining = subMoney(remaining, amount);
    } else {
      const amount = money(Math.min(p.tendered, Math.max(remaining, 0)));
      const change = subMoney(p.tendered, amount);
      applied.push({ method: 'CASH', amount, tendered: p.tendered, change });
      changeDue = addMoney(changeDue, change);
      remaining = subMoney(remaining, amount);
    }
  }

  return {
    applied,
    paidTotal: addMoney(...applied.map((a) => a.amount)),
    remaining: money(Math.max(remaining, 0)),
    changeDue,
    settled: remaining <= 0,
  };
}
