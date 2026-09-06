import type { Money } from '../../core/money/money.ts';
import type { ProductUnit, Quantity } from '../../core/quantity/quantity.ts';
import type { CalcResult, Discount, PriceSource, ScanSource } from '../../core/sale/types.ts';

export type SaleStatus = 'OPEN' | 'PARKED' | 'COMPLETED' | 'VOIDED';
export type DocType = 'SALE' | 'REFUND';
export type PaymentMethod = 'CASH' | 'CARD';

export interface SaleItemView {
  readonly id: number;
  readonly lineNo: number;
  readonly productId: number;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly gross: Money;
  readonly discountAmount: Money;
  readonly saleDiscountShare: Money;
  readonly net: Money;
  readonly taxRateBp: number;
  readonly taxAmount: Money;
  readonly priceSource: PriceSource;
  readonly scanSource: ScanSource;
  readonly rawBarcode: string | null;
  readonly voided: boolean;
  readonly voidReason: string | null;
  readonly originalItemId: number | null;
}

export interface PaymentView {
  readonly id: number;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tendered: Money;
  readonly changeGiven: Money;
  readonly reference: string | null;
}

export interface SaleView {
  readonly id: number;
  readonly uid: string;
  readonly docType: DocType;
  readonly status: SaleStatus;
  readonly terminalId: number;
  readonly userId: number;
  readonly cashSessionId: number | null;
  readonly originalSaleId: number | null;
  readonly receiptSeries: string | null;
  readonly receiptNo: number | null;
  readonly businessDate: string | null;
  readonly openedAt: number;
  readonly completedAt: number | null;
  readonly items: readonly SaleItemView[];
  readonly payments: readonly PaymentView[];
  readonly saleDiscount: Discount | null;
  readonly totals: CalcResult;
  readonly paidTotal: Money;
  readonly changeDue: Money;
  readonly note: string | null;
}

export interface PaymentRequest {
  readonly method: PaymentMethod;
  readonly tendered: Money;
  readonly amount?: Money;
  readonly reference?: string;
}
