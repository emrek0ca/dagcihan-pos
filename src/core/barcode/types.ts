import type { CheckDigitAlgorithm, EmbeddedCheckAlgorithm } from './checkdigit.ts';

/** Barkoddaki degisken alanin ne anlama geldigi */
export type WeightedValueKind = 'WEIGHT_KG' | 'PRICE' | 'COUNT';

/** itemCode alaninin urunle nasil eslestirilecegi */
export type ItemCodeLookup = 'PLU' | 'PRODUCT_CODE' | 'BARCODE_PREFIX';

export type RuleMatch =
  | { readonly type: 'any' }
  | { readonly type: 'prefix'; readonly value: string }
  | { readonly type: 'prefixRange'; readonly from: string; readonly to: string }
  | { readonly type: 'regex'; readonly pattern: string };

export interface FieldSpec {
  /** Normalize edilmis barkod icindeki 0-tabanli baslangic */
  readonly offset: number;
  readonly length: number;
}

export interface ItemCodeSpec extends FieldSpec {
  readonly lookup: ItemCodeLookup;
  /** Bastaki sifirlar kirpilsin mi (PLU 00123 -> 123) */
  readonly stripLeadingZeros?: boolean;
}

export interface ValueSpec extends FieldSpec {
  readonly kind: WeightedValueKind;
  /** Ondalik basamak sayisi: 3 => 01234 = 1,234 kg ; 2 => 01234 = 12,34 TL */
  readonly scale: number;
  /** Alanin hemen sonrasinda/oncesinde yer alan gomulu kontrol hanesi */
  readonly embeddedCheck?: {
    readonly algorithm: EmbeddedCheckAlgorithm;
    /** Kontrol hanesinin 0-tabanli konumu (barkodun tamaminda) */
    readonly offset: number;
  };
}

export interface WeightedBarcodeRule {
  readonly id: string;
  readonly description?: string;
  readonly enabled: boolean;
  /** Kucuk sayi once denenir */
  readonly priority: number;
  /** Kabul edilen toplam uzunluk(lar) */
  readonly length: number | readonly number[];
  readonly match: RuleMatch;
  readonly checkDigit: { readonly algorithm: CheckDigitAlgorithm };
  readonly fields: {
    readonly itemCode: ItemCodeSpec;
    readonly value: ValueSpec;
  };
  /** Guvenlik siniri: cozumlenen deger bu araligin disindaysa kural reddedilir */
  readonly limits?: {
    readonly maxWeightMilli?: number;
    readonly maxPriceKurus?: number;
    readonly minPriceKurus?: number;
  };
}

export interface BarcodeParserConfig {
  readonly rules: readonly WeightedBarcodeRule[];
  /** Duz barkodlarda kabul edilen minimum uzunluk */
  readonly minPlainLength: number;
  readonly maxPlainLength: number;
  readonly limits: {
    readonly maxWeightMilli: number;
    readonly maxPriceKurus: number;
    readonly minPriceKurus: number;
  };
}

// ------------------------------- Sonuc tipleri -------------------------------

export interface WeightedScan {
  readonly kind: 'WEIGHTED';
  readonly raw: string;
  readonly normalized: string;
  readonly ruleId: string;
  readonly itemCode: string;
  readonly lookup: ItemCodeLookup;
  readonly valueKind: WeightedValueKind;
  /** WEIGHT_KG/COUNT icin milli-birim, PRICE icin kurus */
  readonly value: number;
  readonly rawValueField: string;
}

export interface PlainScan {
  readonly kind: 'PLAIN';
  readonly raw: string;
  readonly normalized: string;
  readonly checkDigitValid: boolean | null;
}

export interface InvalidScan {
  readonly kind: 'INVALID';
  readonly raw: string;
  readonly normalized: string;
  readonly reason: InvalidReason;
  readonly ruleId?: string;
  readonly detail?: string;
}

export interface EmptyScan {
  readonly kind: 'EMPTY';
  readonly raw: string;
}

export type InvalidReason =
  | 'EMPTY'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'CHECK_DIGIT'
  | 'EMBEDDED_CHECK_DIGIT'
  | 'NON_NUMERIC_FIELD'
  | 'VALUE_OUT_OF_RANGE'
  | 'ZERO_VALUE';

export type BarcodeParseResult = WeightedScan | PlainScan | InvalidScan | EmptyScan;
