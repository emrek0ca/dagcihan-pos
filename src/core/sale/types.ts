import type { BasisPoints, Money } from '../money/money.ts';
import type { ProductUnit, Quantity } from '../quantity/quantity.ts';

export type DiscountType = 'PERCENT' | 'AMOUNT';

export interface Discount {
  readonly type: DiscountType;
  /** PERCENT icin baz puan (%10 -> 1000), AMOUNT icin kurus */
  readonly value: number;
  readonly reason?: string;
}

export type PriceSource =
  | 'PRODUCT'
  | 'BARCODE_WEIGHT'
  | 'BARCODE_PRICE'
  | 'MANUAL_OVERRIDE'
  | 'REFUND_ORIGINAL';

export type ScanSource = 'SCAN_PLAIN' | 'SCAN_WEIGHTED' | 'MANUAL' | 'PLU' | 'SEARCH' | 'REFUND';

/** Hesaplama girdisi olarak satir (DB'den bagimsiz, saf) */
export interface CalcLine {
  readonly lineNo: number;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly taxRateBp: BasisPoints;
  readonly unit: ProductUnit;
  /** Tutar gomulu barkodda tutar sabittir; miktar x fiyat ile YENIDEN hesaplanmaz */
  readonly fixedGross?: Money;
  readonly discount?: Discount;
  readonly voided?: boolean;
}

export interface CalcLineResult {
  readonly lineNo: number;
  readonly gross: Money;
  readonly discountAmount: Money;
  readonly saleDiscountShare: Money;
  readonly net: Money;
  readonly taxRateBp: BasisPoints;
  readonly taxAmount: Money;
}

export interface TaxBucket {
  readonly rateBp: BasisPoints;
  readonly net: Money;
  readonly tax: Money;
  readonly base: Money;
}

export type CashRoundingMode = 'NONE' | 'NEAREST_5_KURUS' | 'NEAREST_25_KURUS';

export interface CalcInput {
  readonly lines: readonly CalcLine[];
  readonly saleDiscount?: Discount;
  readonly cashRounding?: CashRoundingMode;
}

export interface CalcResult {
  readonly lines: readonly CalcLineResult[];
  /** Satir indirimlerinden SONRAKI toplam */
  readonly subtotal: Money;
  readonly lineDiscountTotal: Money;
  readonly saleDiscountTotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  readonly taxBreakdown: readonly TaxBucket[];
  readonly roundingAdjustment: Money;
  readonly total: Money;
  readonly itemCount: number;
  /** Bilgi amacli: satirlarin indirimsiz brut toplami */
  readonly grossTotal: Money;
}
