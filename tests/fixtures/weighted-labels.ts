/**
 * Sentetik tartili etiket ureteci.
 *
 * Gercek CAS CL3000 formati bilinmedigi icin testler, formati BILINEN sentetik
 * etiketlerle calisir: amac "su format dogru" demek degil, "format ne olursa olsun
 * config ile cozulebiliyor" oldugunu kanitlamaktir.
 */
import { appendCheckDigit, priceCheck4Gs1 } from '../../src/core/barcode/checkdigit.ts';

export interface LabelLayout {
  readonly prefix: string;
  readonly pluLength: number;
  readonly valueLength: number;
  /** Deger alanindaki ondalik hane sayisi */
  readonly valueScale: number;
  /** itemCode ile value arasina GS1 fiyat kontrol hanesi eklensin mi */
  readonly embeddedPriceCheck?: boolean;
}

/**
 * @param value WEIGHT icin milli-birim (750 = 0,750 kg), PRICE icin kurus (8990 = 89,90 TL)
 * @param valueIsPrice deger alani tutar mi tasiyor
 */
export function makeLabel(
  layout: LabelLayout,
  plu: number,
  value: number,
  valueIsPrice: boolean,
): string {
  const sourceScale = valueIsPrice ? 2 : 3;
  const diff = sourceScale - layout.valueScale;
  const fieldValue =
    diff === 0 ? value : diff > 0 ? Math.round(value / 10 ** diff) : value * 10 ** -diff;

  const pluField = String(plu).padStart(layout.pluLength, '0');
  const valueField = String(fieldValue).padStart(layout.valueLength, '0');
  if (pluField.length !== layout.pluLength) throw new Error(`PLU alana sigmiyor: ${plu}`);
  if (valueField.length !== layout.valueLength) {
    throw new Error(`Deger alana sigmiyor: ${value}`);
  }

  let body = layout.prefix + pluField;
  if (layout.embeddedPriceCheck === true) {
    const cd = priceCheck4Gs1(valueField);
    if (cd === null) throw new Error('Gomulu kontrol hanesi 4 haneli alan gerektirir');
    body += String(cd);
  }
  body += valueField;

  if (body.length !== 12) {
    throw new Error(`EAN-13 govdesi 12 hane olmali, ${body.length} hane uretildi: ${body}`);
  }
  return appendCheckDigit(body, 'EAN13');
}

/** Gercekci bir etiket seti uretir (tekrarli PLU, degisken agirlik) */
export function makeLabelSet(
  layout: LabelLayout,
  entries: readonly { plu: number; value: number }[],
  valueIsPrice: boolean,
): string[] {
  return entries.map((e) => makeLabel(layout, e.plu, e.value, valueIsPrice));
}
