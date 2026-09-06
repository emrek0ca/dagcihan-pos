/**
 * Tartili barkod format kesif motoru.
 *
 * Amac: CAS CL3000'in gercek etiket formatini TAHMIN ETMEK yerine, magazadan
 * toplanan GERCEK etiketlerden CIKARMAK. Cikan aday kural dogrudan
 * config/barcode-rules.json icine yazilabilecek bicimdedir.
 *
 * Kanit gucu siralamasi:
 *  1. Bilinen gercek deger (etiket uzerinde yazan kg / TL) ile birebir eslesme  -> kesin
 *  2. itemCode alaninin sistemdeki mevcut PLU'lara denk gelmesi                 -> cok guclu
 *  3. Deger alaninin makul araliga dusmesi + kontrol hanesi tutarliligi         -> zayif
 */
import { verifyCheckDigit, verifyEmbeddedCheck } from './checkdigit.ts';
import type { EmbeddedCheckAlgorithm } from './checkdigit.ts';
import type { WeightedBarcodeRule, WeightedValueKind } from './types.ts';
import { normalizeRaw } from './parser.ts';

export interface BarcodeSample {
  readonly raw: string;
  /** Etikette yazan / bilinen PLU (varsa) */
  readonly knownPlu?: number;
  /** Etikette yazan agirlik, milli-birim (0,750 kg -> 750) */
  readonly knownWeightMilli?: number;
  /** Etikette yazan tutar, kurus (89,90 TL -> 8990) */
  readonly knownPriceKurus?: number;
  readonly note?: string;
}

export interface AnalyzeOptions {
  /** Sistemdeki mevcut PLU listesi - eslesme en guclu ikinci kanittir */
  readonly knownPlus?: readonly number[];
  /** Makul agirlik araligi (milli-birim) */
  readonly weightRange?: readonly [number, number];
  /** Makul tutar araligi (kurus) */
  readonly priceRange?: readonly [number, number];
  readonly maxCandidates?: number;
}

export interface CandidateEvidence {
  readonly samplesMatched: number;
  readonly samplesTotal: number;
  readonly checkDigitOk: number;
  readonly pluMatches: number;
  readonly exactValueMatches: number;
  readonly exactPluMatches: number;
  readonly valueInRange: number;
  readonly embeddedCheckOk: number;
  readonly distinctItemCodes: number;
  readonly notes: readonly string[];
}

export interface Candidate {
  readonly rule: WeightedBarcodeRule;
  readonly score: number;
  readonly confidence: 'KESIN' | 'YUKSEK' | 'ORTA' | 'DUSUK';
  readonly evidence: CandidateEvidence;
  readonly decoded: readonly {
    readonly raw: string;
    readonly itemCode: string;
    readonly value: number;
    readonly valueKind: WeightedValueKind;
  }[];
}

const DEFAULT_WEIGHT_RANGE: readonly [number, number] = [5, 30_000];      // 5 g - 30 kg
const DEFAULT_PRICE_RANGE: readonly [number, number] = [50, 300_000];     // 0,50 - 3000 TL

interface Layout {
  readonly prefixLen: number;
  readonly itemOffset: number;
  readonly itemLen: number;
  readonly valueOffset: number;
  readonly valueLen: number;
  readonly embeddedCheckOffset?: number;
}

/** EAN-13 (ve 8/12) icin olasi alan yerlesimlerini uretir */
function enumerateLayouts(totalLen: number): Layout[] {
  const layouts: Layout[] = [];
  const hasTrailingCheck = totalLen === 13 || totalLen === 8 || totalLen === 12;
  const body = hasTrailingCheck ? totalLen - 1 : totalLen;

  for (let prefixLen = 1; prefixLen <= 4; prefixLen++) {
    for (let itemLen = 3; itemLen <= 7; itemLen++) {
      // (a) gomulu kontrol hanesi yok
      const valueLenA = body - prefixLen - itemLen;
      if (valueLenA >= 3 && valueLenA <= 6) {
        layouts.push({
          prefixLen,
          itemOffset: prefixLen,
          itemLen,
          valueOffset: prefixLen + itemLen,
          valueLen: valueLenA,
        });
      }
      // (b) itemCode ile value arasinda 1 hane gomulu kontrol hanesi
      const valueLenB = body - prefixLen - itemLen - 1;
      if (valueLenB >= 3 && valueLenB <= 6) {
        layouts.push({
          prefixLen,
          itemOffset: prefixLen,
          itemLen,
          valueOffset: prefixLen + itemLen + 1,
          valueLen: valueLenB,
          embeddedCheckOffset: prefixLen + itemLen,
        });
      }
    }
  }
  return layouts;
}

function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

function scaleTo(fieldValue: number, fieldScale: number, kind: WeightedValueKind): number {
  const target = kind === 'PRICE' ? 2 : 3;
  const diff = target - fieldScale;
  if (diff === 0) return fieldValue;
  if (diff > 0) return fieldValue * 10 ** diff;
  const div = 10 ** -diff;
  const q = Math.floor(fieldValue / div);
  const r = fieldValue - q * div;
  return r * 2 >= div ? q + 1 : q;
}

export function analyzeSamples(
  samples: readonly BarcodeSample[],
  options: AnalyzeOptions = {},
): Candidate[] {
  const normalized = samples
    .map((s) => ({ ...s, code: normalizeRaw(s.raw) }))
    .filter((s) => isDigits(s.code));
  if (normalized.length === 0) return [];

  const knownPlus = new Set(options.knownPlus ?? []);
  const [wMin, wMax] = options.weightRange ?? DEFAULT_WEIGHT_RANGE;
  const [pMin, pMax] = options.priceRange ?? DEFAULT_PRICE_RANGE;

  // Uzunluga gore grupla - farkli uzunluklar farkli formatlardir
  const byLength = new Map<number, typeof normalized>();
  for (const s of normalized) {
    const list = byLength.get(s.code.length) ?? [];
    list.push(s);
    byLength.set(s.code.length, list);
  }

  const candidates: Candidate[] = [];

  for (const [len, group] of byLength) {
    const checkAlg = len === 13 ? 'EAN13' : len === 8 ? 'EAN8' : len === 12 ? 'UPCA' : 'NONE';
    const checkOkCount = group.filter((s) => verifyCheckDigit(s.code, checkAlg)).length;

    for (const layout of enumerateLayouts(len)) {
      const prefixes = new Set(group.map((s) => s.code.slice(0, layout.prefixLen)));
      // Cok farkli on ek varsa bu yerlesim muhtemelen yanlis (on ek sabit olmali)
      if (prefixes.size > Math.max(3, Math.ceil(group.length / 2))) continue;

      for (const kind of ['WEIGHT_KG', 'PRICE'] as const) {
        for (const fieldScale of kind === 'PRICE' ? [2, 1, 0] : [3, 2]) {
          for (const embAlg of layout.embeddedCheckOffset === undefined
            ? (['NONE'] as const)
            : (['PRICE_CHECK_4_GS1', 'MOD10', 'NONE'] as const)) {
            const ev = {
              samplesTotal: group.length,
              checkDigitOk: checkOkCount,
              pluMatches: 0,
              exactValueMatches: 0,
              exactPluMatches: 0,
              valueInRange: 0,
              embeddedCheckOk: 0,
            };
            const itemCodes = new Set<string>();
            const decoded: { raw: string; itemCode: string; value: number; valueKind: WeightedValueKind }[] = [];
            let usable = true;

            for (const s of group) {
              const itemRaw = s.code.slice(layout.itemOffset, layout.itemOffset + layout.itemLen);
              const valueRaw = s.code.slice(
                layout.valueOffset,
                layout.valueOffset + layout.valueLen,
              );
              if (!isDigits(itemRaw) || !isDigits(valueRaw)) {
                usable = false;
                break;
              }
              itemCodes.add(itemRaw);
              const value = scaleTo(Number(valueRaw), fieldScale, kind);
              decoded.push({ raw: s.code, itemCode: itemRaw, value, valueKind: kind });

              const plu = Number(itemRaw.replace(/^0+/, '') || '0');
              if (knownPlus.has(plu)) ev.pluMatches++;
              if (s.knownPlu !== undefined && s.knownPlu === plu) ev.exactPluMatches++;

              if (kind === 'WEIGHT_KG') {
                if (value >= wMin && value <= wMax) ev.valueInRange++;
                if (s.knownWeightMilli !== undefined && s.knownWeightMilli === value) {
                  ev.exactValueMatches++;
                }
              } else {
                if (value >= pMin && value <= pMax) ev.valueInRange++;
                if (s.knownPriceKurus !== undefined && s.knownPriceKurus === value) {
                  ev.exactValueMatches++;
                }
              }

              if (embAlg !== 'NONE' && layout.embeddedCheckOffset !== undefined) {
                const cd = s.code.slice(
                  layout.embeddedCheckOffset,
                  layout.embeddedCheckOffset + 1,
                );
                if (verifyEmbeddedCheck(valueRaw, cd, embAlg as EmbeddedCheckAlgorithm)) {
                  ev.embeddedCheckOk++;
                }
              }
            }
            if (!usable) continue;
            if (embAlg === 'PRICE_CHECK_4_GS1' && layout.valueLen !== 4) continue;
            // Gomulu kontrol iddiasi varsa tum orneklerde tutmali
            if (embAlg !== 'NONE' && ev.embeddedCheckOk !== group.length) continue;

            const n = group.length;
            const hasGroundTruth = group.some(
              (s) =>
                s.knownWeightMilli !== undefined ||
                s.knownPriceKurus !== undefined ||
                s.knownPlu !== undefined,
            );
            const groundTruthCount = group.filter(
              (s) => s.knownWeightMilli !== undefined || s.knownPriceKurus !== undefined,
            ).length;

            let score = 0;
            score += (ev.checkDigitOk / n) * 10;
            score += (ev.valueInRange / n) * 25;
            score += (ev.pluMatches / n) * 40;
            if (groundTruthCount > 0) score += (ev.exactValueMatches / groundTruthCount) * 100;
            if (ev.exactPluMatches > 0) score += 40;
            if (embAlg !== 'NONE') score += 15;
            // Deger alani cesitlilik gostermeli, itemCode ise gruplanmali
            const distinctValues = new Set(decoded.map((d) => d.value)).size;
            if (distinctValues === 1 && n > 2) score -= 20;
            if (itemCodes.size === n && n > 3) score -= 10;

            // Esitlik bozucu: bastaki sifirlar yuzunden dar alanli adaylar da orneklere
            // uyar (ornegin 4 haneli agirlik alani 2 kg'da calisir, 12 kg'da TASAR).
            // Ayni kaniti veren adaylardan GENIS alanlisi tercih edilir - dar olan
            // magazada buyuk bir tartimda sessizce yanlis deger uretir.
            score += layout.valueLen * 0.6 + layout.itemLen * 0.4;

            const notes: string[] = [];
            if (!hasGroundTruth) {
              notes.push('Etiket uzerindeki gercek kg/TL girilmedi - kanit zayif.');
            }
            if (ev.pluMatches === 0 && knownPlus.size > 0) {
              notes.push('Hicbir itemCode sistemdeki PLU listesiyle eslesmedi.');
            }
            if (kind === 'PRICE') {
              notes.push('Tutar gomulu format: fiyat etiketten alinir, urun kartindan degil.');
            }

            const confidence: Candidate['confidence'] =
              groundTruthCount > 0 && ev.exactValueMatches === groundTruthCount &&
              (knownPlus.size === 0 || ev.pluMatches === n)
                ? 'KESIN'
                : ev.pluMatches === n && ev.valueInRange === n
                  ? 'YUKSEK'
                  : ev.valueInRange === n
                    ? 'ORTA'
                    : 'DUSUK';

            const idParts = [
              'cas',
              `len${len}`,
              `p${layout.prefixLen}`,
              `i${layout.itemLen}`,
              `v${layout.valueLen}s${fieldScale}`,
              kind === 'PRICE' ? 'price' : 'weight',
            ];
            if (embAlg !== 'NONE') idParts.push(embAlg.toLowerCase());

            const prefixList = [...prefixes].sort();
            const rule: WeightedBarcodeRule = {
              id: idParts.join('-'),
              description:
                `Otomatik kesif: uzunluk ${len}, on ek ${prefixList.join('/')}, ` +
                `itemCode@${layout.itemOffset}+${layout.itemLen}, ` +
                `value@${layout.valueOffset}+${layout.valueLen} (${kind}, olcek ${fieldScale})`,
              enabled: false,
              priority: 10,
              length: len,
              match:
                prefixList.length === 1
                  ? { type: 'prefix', value: prefixList[0]! }
                  : {
                      type: 'prefixRange',
                      from: prefixList[0]!,
                      to: prefixList[prefixList.length - 1]!,
                    },
              checkDigit: { algorithm: checkAlg },
              fields: {
                itemCode: {
                  offset: layout.itemOffset,
                  length: layout.itemLen,
                  lookup: 'PLU',
                  stripLeadingZeros: true,
                },
                value: {
                  offset: layout.valueOffset,
                  length: layout.valueLen,
                  scale: fieldScale,
                  kind,
                  ...(embAlg !== 'NONE' && layout.embeddedCheckOffset !== undefined
                    ? {
                        embeddedCheck: {
                          algorithm: embAlg as EmbeddedCheckAlgorithm,
                          offset: layout.embeddedCheckOffset,
                        },
                      }
                    : {}),
                },
              },
            };

            candidates.push({
              rule,
              score: Math.round(score * 100) / 100,
              confidence,
              evidence: {
                ...ev,
                samplesMatched: n,
                distinctItemCodes: itemCodes.size,
                notes,
              },
              decoded,
            });
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, options.maxCandidates ?? 10);
}
