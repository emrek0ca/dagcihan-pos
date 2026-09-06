/**
 * SaleView -> ReceiptDocument donusumu.
 * Fiste bulunmasi zorunlu alanlar: urun, miktar/kg, birim fiyat, tutar, odeme tipi,
 * tarih/saat, kasa, kasiyer ve satis numarasi.
 */
import { formatMoney, type Money } from '../../core/money/money.ts';
import { formatQuantityWithUnit } from '../../core/quantity/quantity.ts';
import type { SaleView } from '../sales/types.ts';
import type { ReceiptDocument, ReceiptLine, ReceiptTotalRow } from './document.ts';
import type { SessionSummary } from '../cash-register/cash-register.ts';

export interface ReceiptContext {
  readonly storeName: string;
  readonly storeLines: readonly string[];
  readonly footer: readonly string[];
  readonly terminalName: string;
  readonly cashierName: string;
  readonly taxOffice?: string;
  readonly taxNumber?: string;
  readonly simulated?: boolean;
}

function formatDateTime(at: number): { date: string; time: string } {
  const d = new Date(at);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
  };
}

function taxLabel(rateBp: number): string {
  const percent = rateBp / 100;
  return `KDV %${Number.isInteger(percent) ? percent : percent.toFixed(2)}`;
}

export function buildReceipt(
  sale: SaleView,
  context: ReceiptContext,
  options: { copy?: boolean } = {},
): ReceiptDocument {
  const { date, time } = formatDateTime(sale.completedAt ?? sale.openedAt);
  const receipt = sale.receiptNo === null ? '-' : `${sale.receiptSeries ?? ''}${sale.receiptNo}`;
  const isRefund = sale.docType === 'REFUND';

  const lines: ReceiptLine[] = sale.items
    .filter((item) => !item.voided)
    .map((item) => {
      const isSingleUnit = item.unit === 'EACH' && item.quantity === 1000;
      return {
        name: item.name,
        detail: isSingleUnit
          ? ''
          : `${formatQuantityWithUnit(item.quantity, item.unit)} x ${formatMoney(item.unitPrice)}`,
        amount: formatMoney(item.net),
      };
    });

  const totals: ReceiptTotalRow[] = [];
  if (sale.totals.discountTotal > 0) {
    totals.push({ label: 'ARA TOPLAM', value: formatMoney(sale.totals.grossTotal) });
    totals.push({ label: 'INDIRIM', value: `-${formatMoney(sale.totals.discountTotal)}` });
  }
  if (sale.totals.roundingAdjustment !== 0) {
    totals.push({
      label: 'YUVARLAMA',
      value: formatMoney(sale.totals.roundingAdjustment as Money),
    });
  }
  totals.push({
    label: isRefund ? 'IADE TOPLAM' : 'TOPLAM',
    value: formatMoney(sale.totals.total),
    emphasize: true,
  });

  const payments = sale.payments.map((p) => ({
    label: p.method === 'CASH' ? 'NAKIT' : 'KREDI KARTI',
    value: formatMoney(p.tendered),
  }));
  if (sale.changeDue > 0) {
    payments.push({ label: 'PARA USTU', value: formatMoney(sale.changeDue) });
  }

  const meta = [
    { label: 'Tarih', value: date },
    { label: 'Saat', value: time },
    { label: 'Fis No', value: receipt },
    { label: 'Kasa', value: context.terminalName },
    { label: 'Kasiyer', value: context.cashierName },
  ];
  if (isRefund && sale.originalSaleId !== null) {
    meta.push({ label: 'Iade Fisi', value: `#${sale.originalSaleId}` });
  }

  return {
    kind: options.copy === true ? 'REPRINT' : 'RECEIPT',
    storeName: context.storeName,
    storeLines: [
      ...context.storeLines,
      ...(context.taxOffice !== undefined && context.taxOffice !== ''
        ? [`${context.taxOffice} V.D. ${context.taxNumber ?? ''}`]
        : []),
    ].filter((l) => l.trim() !== ''),
    title: isRefund ? 'IADE FISI' : 'SATIS FISI',
    meta,
    lines,
    totals,
    taxRows: sale.totals.taxBreakdown.map((t) => ({
      label: taxLabel(t.rateBp),
      base: formatMoney(t.base),
      tax: formatMoney(t.tax),
    })),
    payments,
    footer: context.footer,
    ...(sale.receiptNo === null ? {} : { barcodeData: receipt }),
    copy: options.copy === true,
    ...(context.simulated === true ? { simulated: true } : {}),
    openDrawer: !isRefund && sale.payments.some((p) => p.method === 'CASH'),
  };
}

/** Kasa X/Z raporu belgesi */
export function buildSessionReport(
  summary: SessionSummary,
  context: ReceiptContext,
  kind: 'X_REPORT' | 'Z_REPORT',
): ReceiptDocument {
  const opened = formatDateTime(summary.session.openedAt);
  const closed =
    summary.session.closedAt === null ? null : formatDateTime(summary.session.closedAt);

  const totals: ReceiptTotalRow[] = [
    { label: 'Fis Sayisi', value: String(summary.salesCount) },
    { label: 'Satis Toplami', value: formatMoney(summary.salesTotal) },
    { label: 'Iade Sayisi', value: String(summary.refundCount) },
    { label: 'Iade Toplami', value: formatMoney(summary.refundTotal) },
    { label: 'Indirim Toplami', value: formatMoney(summary.discountTotal) },
    { label: 'Iptal Fis', value: String(summary.voidedSales) },
    { label: 'Nakit Satis', value: formatMoney(summary.cashSales) },
    { label: 'Kart Satis', value: formatMoney(summary.cardSales) },
    { label: 'Kasa Giris', value: formatMoney(summary.paidIn) },
    { label: 'Kasa Cikis', value: formatMoney(summary.paidOut) },
    { label: 'Acilis Devri', value: formatMoney(summary.session.openingFloat) },
    { label: 'BEKLENEN NAKIT', value: formatMoney(summary.expectedCash), emphasize: true },
  ];
  if (summary.session.countedCash !== null) {
    totals.push({ label: 'Sayilan Nakit', value: formatMoney(summary.session.countedCash) });
    totals.push({
      label: 'FARK',
      value: formatMoney(summary.session.variance ?? (0 as Money)),
      emphasize: true,
    });
  }

  return {
    kind,
    storeName: context.storeName,
    storeLines: context.storeLines,
    title: kind === 'Z_REPORT' ? 'Z RAPORU (GUN SONU)' : 'X RAPORU (ARA RAPOR)',
    meta: [
      { label: 'Is Gunu', value: summary.session.businessDate },
      { label: 'Kasa', value: context.terminalName },
      { label: 'Acilis', value: `${opened.date} ${opened.time}` },
      ...(closed !== null ? [{ label: 'Kapanis', value: `${closed.date} ${closed.time}` }] : []),
      { label: 'Oturum', value: `#${summary.session.id}` },
    ],
    lines: [],
    totals,
    taxRows: summary.taxBreakdown.map((t) => ({
      label: taxLabel(t.rateBp),
      base: formatMoney((t.net - t.tax) as Money),
      tax: formatMoney(t.tax),
    })),
    payments: [],
    footer: [],
    copy: false,
    ...(context.simulated === true ? { simulated: true } : {}),
  };
}
