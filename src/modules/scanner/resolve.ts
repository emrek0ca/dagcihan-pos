/**
 * Okutulan barkodu satisa eklenebilir bir satira donusturur.
 *
 * Bu, "barkod cozumleme" (saf, core/barcode) ile "urun ve fiyat" (veritabani)
 * arasindaki koprudur. Fiyat kaynagi burada belirlenir ve kayda gecer.
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import { PosError } from '../../core/errors.ts';
import { money, type Money } from '../../core/money/money.ts';
import {
  ONE_UNIT, deriveQuantity, quantity, type Quantity,
} from '../../core/quantity/quantity.ts';
import { BarcodeParser } from '../../core/barcode/parser.ts';
import type { BarcodeParseResult } from '../../core/barcode/types.ts';
import type { BarcodeConfigFile } from '../../config/types.ts';
import type { PriceSource, ScanSource } from '../../core/sale/types.ts';
import type { Product, ProductService } from '../products/products.ts';

export interface ResolvedItem {
  readonly product: Product;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  /** Tutar gomulu barkodda satir tutari sabittir */
  readonly fixedGross?: Money;
  readonly priceSource: PriceSource;
  readonly scanSource: ScanSource;
  readonly rawBarcode: string;
  readonly ruleId?: string;
  readonly warnings: readonly string[];
}

export interface ScanContext {
  readonly terminalId?: number;
  readonly userId?: number;
  readonly saleId?: number;
}

export interface ResolveOptions {
  /** Adet birimli urune tartili etiket okutulursa ne yapilacagi */
  readonly weightedOnNonKgProduct: 'REJECT' | 'ALLOW_AS_EACH';
  readonly maxLineAmountKurus: number;
}

export class ScanResolver {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #products: ProductService;
  readonly #parser: BarcodeParser;
  readonly #barcodeConfig: BarcodeConfigFile;
  readonly #options: ResolveOptions;

  constructor(
    db: Db,
    clock: Clock,
    products: ProductService,
    barcodeConfig: BarcodeConfigFile,
    options: ResolveOptions,
  ) {
    this.#db = db;
    this.#clock = clock;
    this.#products = products;
    this.#barcodeConfig = barcodeConfig;
    this.#parser = new BarcodeParser(barcodeConfig);
    this.#options = options;
  }

  get parser(): BarcodeParser {
    return this.#parser;
  }

  resolve(raw: string, context: ScanContext = {}): ResolvedItem {
    const parsed = this.#parser.parse(raw);
    try {
      const item = this.#resolveParsed(parsed, raw);
      this.#log(parsed, context, item.product.id, null);
      return item;
    } catch (error) {
      this.#log(parsed, context, null, error instanceof PosError ? error.code : 'INTERNAL');
      throw error;
    }
  }

  #resolveParsed(parsed: BarcodeParseResult, raw: string): ResolvedItem {
    switch (parsed.kind) {
      case 'EMPTY':
        throw new PosError('BARCODE_EMPTY', 'Bos barkod okundu');

      case 'INVALID':
        throw new PosError('BARCODE_INVALID',
          `Barkod gecersiz (${parsed.reason}): ${parsed.normalized}`, {
            details: { reason: parsed.reason, ruleId: parsed.ruleId ?? null, detail: parsed.detail ?? null },
          });

      case 'WEIGHTED':
        return this.#resolveWeighted(parsed, raw);

      case 'PLAIN': {
        const hit = this.#products.findByBarcode(parsed.normalized);
        if (hit === undefined) return this.#unknownPlain(parsed.normalized);
        const { product, packSize } = hit;
        if (!product.active) {
          throw new PosError('PRODUCT_INACTIVE', `Urun satisa kapali: ${product.name}`);
        }
        return {
          product,
          quantity: packSize,
          unitPrice: product.unitPrice,
          priceSource: 'PRODUCT',
          scanSource: 'SCAN_PLAIN',
          rawBarcode: parsed.normalized,
          warnings: [],
        };
      }
    }
  }

  #unknownPlain(code: string): never {
    // Tartili etiket olma ihtimali varsa kasiyere DOGRU nedeni soyle
    const looksWeighted =
      /^\d{13}$/.test(code) &&
      this.#barcodeConfig.discoveryPrefixes.some((p) => code.startsWith(p));

    if (looksWeighted && !this.#barcodeConfig.weightedFormatConfirmed) {
      throw new PosError('WEIGHTED_FORMAT_NOT_CONFIGURED',
        `Tartili barkod formati tanimli degil, cozumlenemedi: ${code}`, {
          details: { barcode: code },
          userMessage:
            'Terazi barkodu formati henuz tanimlanmadi. Bu etiket kaydedildi; ' +
            'yonetici "pos barcode analyze" ile formati tanimlamali.',
        });
    }
    throw new PosError('BARCODE_UNKNOWN', `Barkod tanimli degil: ${code}`, {
      details: { barcode: code },
    });
  }

  #resolveWeighted(
    parsed: Extract<BarcodeParseResult, { kind: 'WEIGHTED' }>,
    _raw: string,
  ): ResolvedItem {
    const warnings: string[] = [];
    const codeNumber = Number(parsed.itemCode);

    let product: Product | undefined;
    if (parsed.lookup === 'PLU') {
      product = Number.isSafeInteger(codeNumber) ? this.#products.findByPlu(codeNumber) : undefined;
      if (product === undefined) product = this.#products.findByCode(parsed.itemCode);
    } else {
      product = this.#products.findByCode(parsed.itemCode);
      if (product === undefined && Number.isSafeInteger(codeNumber)) {
        product = this.#products.findByPlu(codeNumber);
      }
    }

    if (product === undefined) {
      throw new PosError('PLU_NOT_FOUND',
        `Tartili barkoddaki urun kodu bulunamadi: ${parsed.itemCode}`, {
          details: { itemCode: parsed.itemCode, barcode: parsed.normalized, ruleId: parsed.ruleId },
        });
    }
    if (!product.active) {
      throw new PosError('PRODUCT_INACTIVE', `Urun satisa kapali: ${product.name}`);
    }

    if (product.unit !== 'KG') {
      if (this.#options.weightedOnNonKgProduct === 'REJECT') {
        throw new PosError('PRODUCT_UNIT_MISMATCH',
          `Tartili etiket adet birimli urunde kullanilamaz: ${product.name}`, {
            details: { productId: product.id, unit: product.unit },
          });
      }
      warnings.push('Adet birimli urune tartili etiket okutuldu.');
    }

    if (parsed.valueKind === 'PRICE') {
      const gross = money(parsed.value);
      if (gross > this.#options.maxLineAmountKurus) {
        throw new PosError('VALUE_OUT_OF_RANGE',
          `Etiket tutari sinir disi: ${gross}`, { details: { gross } });
      }
      if (product.minPrice !== null && gross < product.minPrice) {
        warnings.push('Etiket tutari urun icin tanimli alt sinirin altinda.');
      }
      if (product.maxPrice !== null && gross > product.maxPrice) {
        warnings.push('Etiket tutari urun icin tanimli ust sinirin uzerinde.');
      }
      // Miktar yalnizca STOK icin turetilir; fiyatta kullanilmaz.
      const derived = deriveQuantity(gross, product.unitPrice);
      if (derived === null) {
        warnings.push('Urun birim fiyati tanimsiz, agirlik turetilemedi (stok dusumu yaklasik).');
      }
      return {
        product,
        quantity: derived ?? quantity(0),
        unitPrice: product.unitPrice,
        fixedGross: gross,
        priceSource: 'BARCODE_PRICE',
        scanSource: 'SCAN_WEIGHTED',
        rawBarcode: parsed.normalized,
        ruleId: parsed.ruleId,
        warnings,
      };
    }

    // WEIGHT_KG veya COUNT: fiyat URUN KARTINDAN gelir
    if (product.unitPrice <= 0) {
      throw new PosError('PRICE_UNAVAILABLE', `Urun fiyati tanimsiz: ${product.name}`, {
        userMessage: 'Bu urunun fiyati tanimli degil.',
      });
    }
    const qty = quantity(parsed.value);
    return {
      product,
      quantity: parsed.valueKind === 'COUNT' ? quantity(parsed.value) : qty,
      unitPrice: product.unitPrice,
      priceSource: 'BARCODE_WEIGHT',
      scanSource: 'SCAN_WEIGHTED',
      rawBarcode: parsed.normalized,
      ruleId: parsed.ruleId,
      warnings,
    };
  }

  /** Elle/arama ile urun ekleme (barkodsuz) */
  resolveProduct(productId: number, qty: Quantity = ONE_UNIT, source: ScanSource = 'SEARCH'): ResolvedItem {
    const product = this.#products.byId(productId);
    if (!product.active) {
      throw new PosError('PRODUCT_INACTIVE', `Urun satisa kapali: ${product.name}`);
    }
    if (product.unitPrice <= 0) {
      throw new PosError('PRICE_UNAVAILABLE', `Urun fiyati tanimsiz: ${product.name}`);
    }
    return {
      product,
      quantity: qty,
      unitPrice: product.unitPrice,
      priceSource: 'PRODUCT',
      scanSource: source,
      rawBarcode: '',
      warnings: [],
    };
  }

  /**
   * Her okuma kaydedilir. Cozumlenemeyen okumalar CAS format kesfinin ham verisidir
   * (`pos barcode analyze` bu tabloyu okur).
   */
  #log(
    parsed: BarcodeParseResult,
    context: ScanContext,
    productId: number | null,
    errorCode: string | null,
  ): void {
    const normalized = parsed.kind === 'EMPTY' ? '' : parsed.normalized;
    const result =
      parsed.kind === 'WEIGHTED' ? 'WEIGHTED'
        : parsed.kind === 'PLAIN' ? (productId === null ? 'UNKNOWN' : 'PLAIN')
          : 'INVALID';
    const detail: Record<string, unknown> = {};
    if (parsed.kind === 'INVALID') {
      detail.reason = parsed.reason;
      if (parsed.detail !== undefined) detail.detail = parsed.detail;
    }
    if (parsed.kind === 'WEIGHTED') {
      detail.itemCode = parsed.itemCode;
      detail.valueKind = parsed.valueKind;
      detail.value = parsed.value;
    }
    if (errorCode !== null) detail.error = errorCode;

    try {
      this.#db.run(
        `INSERT INTO scan_log
           (raw, raw_length, result, rule_id, product_id, sale_id, terminal_id, user_id, detail_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        normalized,
        normalized.length,
        result,
        parsed.kind === 'WEIGHTED' ? parsed.ruleId : (parsed.kind === 'INVALID' ? parsed.ruleId ?? null : null),
        productId,
        context.saleId ?? null,
        context.terminalId ?? null,
        context.userId ?? null,
        JSON.stringify(detail),
        this.#clock.now(),
      );
    } catch {
      // Log yazilamamasi satisi engellemez
    }
  }
}
