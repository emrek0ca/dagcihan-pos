/**
 * Fis belgesi - yazicidan bagimsiz ara temsil.
 *
 * Kuyruga ESC/POS baytlari degil BU BELGE yazilir; boylece kod sayfasi veya
 * satir genisligi degisse bile bekleyen fisler dogru basilir ve tekrar basim
 * satis kaydina dokunmadan yapilabilir.
 */
export type ReceiptKind = 'RECEIPT' | 'REPRINT' | 'X_REPORT' | 'Z_REPORT' | 'TEST';

export interface ReceiptLine {
  readonly name: string;
  /** "0,750 kg x 120,00" gibi ikinci satir; adet 1 ise bos birakilir */
  readonly detail: string;
  readonly amount: string;
  readonly voided?: boolean;
}

export interface ReceiptTotalRow {
  readonly label: string;
  readonly value: string;
  readonly emphasize?: boolean;
}

export interface ReceiptDocument {
  readonly kind: ReceiptKind;
  readonly storeName: string;
  readonly storeLines: readonly string[];
  readonly title: string;
  readonly meta: readonly { readonly label: string; readonly value: string }[];
  readonly lines: readonly ReceiptLine[];
  readonly totals: readonly ReceiptTotalRow[];
  readonly taxRows: readonly { readonly label: string; readonly base: string; readonly tax: string }[];
  readonly payments: readonly { readonly label: string; readonly value: string }[];
  readonly footer: readonly string[];
  readonly barcodeData?: string;
  readonly qrData?: string;
  readonly copy: boolean;
  /** Simulator/dosya modunda basildi ise fise damga vurulur */
  readonly simulated?: boolean;
  readonly openDrawer?: boolean;
}
