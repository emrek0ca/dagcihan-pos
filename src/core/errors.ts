/**
 * Tek hata modeli. `code` makine icin sabittir, `userMessage` kasiyer icindir.
 * Beklenen is hatalari PosError'dir; beklenmeyenler ayri loglanir.
 */
export type PosErrorCode =
  // barkod / urun
  | 'BARCODE_EMPTY'
  | 'BARCODE_INVALID'
  | 'BARCODE_UNKNOWN'
  | 'WEIGHTED_FORMAT_NOT_CONFIGURED'
  | 'PLU_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'PRODUCT_UNIT_MISMATCH'
  | 'PRICE_UNAVAILABLE'
  | 'VALUE_OUT_OF_RANGE'
  // satis
  | 'SALE_NOT_FOUND'
  | 'SALE_NOT_OPEN'
  | 'SALE_EMPTY'
  | 'SALE_ALREADY_OPEN'
  | 'LINE_NOT_FOUND'
  | 'LINE_ALREADY_VOIDED'
  | 'INVALID_QUANTITY'
  | 'DISCOUNT_TOO_LARGE'
  | 'DISCOUNT_INVALID'
  | 'TOTAL_MISMATCH'
  // odeme
  | 'PAYMENT_INSUFFICIENT'
  | 'PAYMENT_EXCEEDS_TOTAL'
  | 'PAYMENT_INVALID'
  // iade
  | 'REFUND_ORIGINAL_REQUIRED'
  | 'REFUND_EXCEEDS_ORIGINAL'
  | 'REFUND_NOT_ALLOWED'
  // kasa / kullanici
  | 'CASH_SESSION_NOT_OPEN'
  | 'CASH_SESSION_ALREADY_OPEN'
  | 'UNAUTHORIZED'
  | 'APPROVAL_REQUIRED'
  | 'INVALID_CREDENTIALS'
  // stok
  | 'INSUFFICIENT_STOCK'
  // altyapi
  | 'IDEMPOTENCY_KEY_REUSE'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'PRINTER_OFFLINE'
  | 'PRINTER_ERROR'
  | 'DEVICE_UNAVAILABLE'
  | 'DATABASE_ERROR'
  | 'CONFIG_ERROR'
  | 'INTERNAL';

export type PosErrorSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';

export interface PosErrorOptions {
  readonly userMessage?: string;
  readonly severity?: PosErrorSeverity;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

const DEFAULT_USER_MESSAGES: Partial<Record<PosErrorCode, string>> = {
  BARCODE_INVALID: 'Barkod okunamadi. Lutfen tekrar okutun.',
  BARCODE_UNKNOWN: 'Bu barkod sistemde tanimli degil.',
  WEIGHTED_FORMAT_NOT_CONFIGURED:
    'Tartili barkod formati henuz tanimlanmadi. Yonetici ile gorusun.',
  PLU_NOT_FOUND: 'Etiketteki urun kodu sistemde bulunamadi.',
  PRODUCT_NOT_FOUND: 'Urun bulunamadi.',
  PRODUCT_INACTIVE: 'Bu urun satisa kapali.',
  PRODUCT_UNIT_MISMATCH: 'Tartili etiket ancak kilo ile satilan urunlerde kullanilir.',
  VALUE_OUT_OF_RANGE: 'Etiketteki deger gecerli araligin disinda.',
  SALE_NOT_OPEN: 'Bu fis kapali, islem yapilamaz.',
  SALE_EMPTY: 'Fis bos. Once urun ekleyin.',
  INVALID_QUANTITY: 'Gecersiz miktar.',
  DISCOUNT_TOO_LARGE: 'Indirim tutari fis toplamindan buyuk olamaz.',
  TOTAL_MISMATCH: 'Fis toplami degisti. Lutfen tekrar deneyin.',
  PAYMENT_INSUFFICIENT: 'Alinan tutar fis toplamini karsilamiyor.',
  APPROVAL_REQUIRED: 'Bu islem icin yonetici onayi gerekiyor.',
  UNAUTHORIZED: 'Bu islem icin yetkiniz yok.',
  INVALID_CREDENTIALS: 'Kullanici adi veya sifre hatali.',
  CASH_SESSION_NOT_OPEN: 'Kasa acik degil. Once kasa acilisi yapin.',
  INSUFFICIENT_STOCK: 'Yeterli stok yok.',
  PRINTER_OFFLINE: 'Yazici baglantisi yok. Fis kuyruga alindi, sonra basilacak.',
  IDEMPOTENCY_IN_PROGRESS: 'Islem zaten devam ediyor.',
  DATABASE_ERROR: 'Kayit hatasi. Islem tamamlanmadi.',
};

export class PosError extends Error {
  readonly code: PosErrorCode;
  readonly severity: PosErrorSeverity;
  readonly userMessage: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: PosErrorCode, message: string, options: PosErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PosError';
    this.code = code;
    this.severity = options.severity ?? 'ERROR';
    this.userMessage =
      options.userMessage ?? DEFAULT_USER_MESSAGES[code] ?? 'Islem tamamlanamadi.';
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      severity: this.severity,
      details: this.details,
    };
  }
}

export function isPosError(error: unknown): error is PosError {
  return error instanceof PosError;
}

export function posError(
  code: PosErrorCode,
  message: string,
  options?: PosErrorOptions,
): PosError {
  return new PosError(code, message, options);
}
