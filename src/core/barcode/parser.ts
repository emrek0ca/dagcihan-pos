/**
 * Barkod cozumleme motoru.
 *
 * Bu dosya CAS CL3000'in gercek formatini BILMEZ ve bilmemelidir.
 * Format tamamen konfigurasyondan (WeightedBarcodeRule[]) gelir.
 * Gercek etiket ogrenildiginde yalnizca config degisir, bu kod degismez.
 */
import { verifyCheckDigit, verifyEmbeddedCheck } from './checkdigit.ts';
import type {
  BarcodeParseResult,
  BarcodeParserConfig,
  InvalidReason,
  InvalidScan,
  ValueSpec,
  WeightedBarcodeRule,
  WeightedScan,
} from './types.ts';

/** Okuyucudan gelen ham diziyi temizler: CR/LF, sekme, bosluk, yazdirilamayan karakterler */
export function normalizeRaw(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue; // kontrol karakterleri
    if (ch === ' ') continue;
    out += ch;
  }
  return out.trim();
}

function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function lengthMatches(rule: WeightedBarcodeRule, len: number): boolean {
  return typeof rule.length === 'number' ? rule.length === len : rule.length.includes(len);
}

function prefixMatches(rule: WeightedBarcodeRule, code: string): boolean {
  const m = rule.match;
  switch (m.type) {
    case 'any':
      return true;
    case 'prefix':
      return code.startsWith(m.value);
    case 'prefixRange': {
      const n = m.from.length;
      if (m.to.length !== n || code.length < n) return false;
      const head = code.slice(0, n);
      if (!isDigits(head) || !isDigits(m.from) || !isDigits(m.to)) return false;
      const v = Number(head);
      return v >= Number(m.from) && v <= Number(m.to);
    }
    case 'regex':
      return new RegExp(m.pattern).test(code);
  }
}

/** Alan degerini olcekleyerek tam sayiya cevirir (scale=3, "01234" -> 1234 milli) */
function scaleValue(field: string, spec: ValueSpec): number {
  const digitsValue = Number(field);
  // scale, alanin kac ondalik hane tasidigini soyler.
  // WEIGHT_KG/COUNT hedefi milli-birim (10^3), PRICE hedefi kurus (10^2)
  const targetScale = spec.kind === 'PRICE' ? 2 : 3;
  const diff = targetScale - spec.scale;
  if (diff === 0) return digitsValue;
  if (diff > 0) return digitsValue * 10 ** diff;
  const divisor = 10 ** -diff;
  // asagi degil ticari yuvarlama
  const neg = digitsValue < 0;
  const abs = Math.abs(digitsValue);
  const q = Math.floor(abs / divisor);
  const r = abs - q * divisor;
  const rounded = r * 2 >= divisor ? q + 1 : q;
  return neg ? -rounded : rounded;
}

export class BarcodeParser {
  readonly #rules: WeightedBarcodeRule[];
  readonly #config: BarcodeParserConfig;

  constructor(config: BarcodeParserConfig) {
    validateConfig(config);
    this.#config = config;
    this.#rules = [...config.rules]
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  get rules(): readonly WeightedBarcodeRule[] {
    return this.#rules;
  }

  parse(raw: string): BarcodeParseResult {
    const normalized = normalizeRaw(raw);
    if (normalized.length === 0) return { kind: 'EMPTY', raw };

    // 1) Tartili kurallar - oncelik sirasiyla
    let lastRuleFailure: { reason: InvalidReason; ruleId: string; detail?: string } | undefined;

    for (const rule of this.#rules) {
      if (!lengthMatches(rule, normalized.length)) continue;
      if (!prefixMatches(rule, normalized)) continue;

      const outcome = this.#applyRule(rule, normalized, raw);
      if (outcome.kind === 'WEIGHTED') return outcome;
      // Kural eslesti ama gecersiz: bir sonraki kurali dene, hatayi sakla
      lastRuleFailure = {
        reason: outcome.reason,
        ruleId: rule.id,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      };
    }

    // 2) Duz barkod
    if (normalized.length < this.#config.minPlainLength) {
      return lastRuleFailure !== undefined
        ? { kind: 'INVALID', raw, normalized, ...lastRuleFailure }
        : { kind: 'INVALID', raw, normalized, reason: 'TOO_SHORT' };
    }
    if (normalized.length > this.#config.maxPlainLength) {
      return { kind: 'INVALID', raw, normalized, reason: 'TOO_LONG' };
    }

    // Tartili kural eslesip checksum'da patladiysa bunu duz barkod diye ele almak
    // tehlikelidir (yanlis urun satilabilir) - hatayi geri dondur.
    if (lastRuleFailure !== undefined && lastRuleFailure.reason !== 'VALUE_OUT_OF_RANGE') {
      return { kind: 'INVALID', raw, normalized, ...lastRuleFailure };
    }

    const checkDigitValid = isDigits(normalized)
      ? normalized.length === 13
        ? verifyCheckDigit(normalized, 'EAN13')
        : normalized.length === 8
          ? verifyCheckDigit(normalized, 'EAN8')
          : normalized.length === 12
            ? verifyCheckDigit(normalized, 'UPCA')
            : null
      : null;

    return { kind: 'PLAIN', raw, normalized, checkDigitValid };
  }

  #applyRule(rule: WeightedBarcodeRule, code: string, raw: string): WeightedScan | InvalidScan {
    const fail = (reason: InvalidReason, detail?: string): InvalidScan =>
      ({
        kind: 'INVALID' as const,
        raw,
        normalized: code,
        reason,
        ruleId: rule.id,
        ...(detail !== undefined ? { detail } : {}),
      });

    if (!verifyCheckDigit(code, rule.checkDigit.algorithm)) {
      return fail('CHECK_DIGIT', `algoritma=${rule.checkDigit.algorithm}`);
    }

    const ic = rule.fields.itemCode;
    const vs = rule.fields.value;
    const itemCodeRaw = code.slice(ic.offset, ic.offset + ic.length);
    const valueField = code.slice(vs.offset, vs.offset + vs.length);

    if (!isDigits(itemCodeRaw)) return fail('NON_NUMERIC_FIELD', `itemCode=${itemCodeRaw}`);
    if (!isDigits(valueField)) return fail('NON_NUMERIC_FIELD', `value=${valueField}`);

    if (vs.embeddedCheck !== undefined && vs.embeddedCheck.algorithm !== 'NONE') {
      const cd = code.slice(vs.embeddedCheck.offset, vs.embeddedCheck.offset + 1);
      if (!verifyEmbeddedCheck(valueField, cd, vs.embeddedCheck.algorithm)) {
        return fail('EMBEDDED_CHECK_DIGIT', `alan=${valueField} hane=${cd}`);
      }
    }

    const value = scaleValue(valueField, vs);
    if (value <= 0) return fail('ZERO_VALUE', `alan=${valueField}`);

    const limits = { ...this.#config.limits, ...rule.limits };
    if (vs.kind === 'PRICE') {
      if (value > limits.maxPriceKurus) {
        return fail('VALUE_OUT_OF_RANGE', `fiyat=${value} > ${limits.maxPriceKurus}`);
      }
      if (value < limits.minPriceKurus) {
        return fail('VALUE_OUT_OF_RANGE', `fiyat=${value} < ${limits.minPriceKurus}`);
      }
    } else if (value > limits.maxWeightMilli) {
      return fail('VALUE_OUT_OF_RANGE', `miktar=${value} > ${limits.maxWeightMilli}`);
    }

    const itemCode = ic.stripLeadingZeros === true
      ? (itemCodeRaw.replace(/^0+/, '') || '0')
      : itemCodeRaw;

    return {
      kind: 'WEIGHTED',
      raw,
      normalized: code,
      ruleId: rule.id,
      itemCode,
      lookup: ic.lookup,
      valueKind: vs.kind,
      value,
      rawValueField: valueField,
    };
  }
}

/** Konfigurasyon hatalarini erken yakalar - mağazada calisirken degil, acilista patlasin */
export function validateConfig(config: BarcodeParserConfig): void {
  const seen = new Set<string>();
  for (const rule of config.rules) {
    if (seen.has(rule.id)) throw new Error(`Yinelenen barkod kural id: ${rule.id}`);
    seen.add(rule.id);

    const lengths = typeof rule.length === 'number' ? [rule.length] : [...rule.length];
    if (lengths.length === 0) throw new Error(`${rule.id}: uzunluk tanimsiz`);
    const minLen = Math.min(...lengths);

    const check = (name: string, offset: number, length: number) => {
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`${rule.id}: ${name}.offset gecersiz (${offset})`);
      }
      if (!Number.isInteger(length) || length <= 0) {
        throw new Error(`${rule.id}: ${name}.length gecersiz (${length})`);
      }
      if (offset + length > minLen) {
        throw new Error(
          `${rule.id}: ${name} alani barkod disina tasiyor (${offset}+${length} > ${minLen})`,
        );
      }
    };
    check('itemCode', rule.fields.itemCode.offset, rule.fields.itemCode.length);
    check('value', rule.fields.value.offset, rule.fields.value.length);

    const ic = rule.fields.itemCode;
    const vs = rule.fields.value;
    const icEnd = ic.offset + ic.length;
    const vsEnd = vs.offset + vs.length;
    if (ic.offset < vsEnd && vs.offset < icEnd) {
      throw new Error(`${rule.id}: itemCode ve value alanlari cakisiyor`);
    }
    if (!Number.isInteger(vs.scale) || vs.scale < 0 || vs.scale > 6) {
      throw new Error(`${rule.id}: value.scale gecersiz (${vs.scale})`);
    }
    if (vs.embeddedCheck !== undefined && vs.embeddedCheck.algorithm !== 'NONE') {
      const o = vs.embeddedCheck.offset;
      if (o < 0 || o >= minLen) {
        throw new Error(`${rule.id}: embeddedCheck.offset barkod disinda (${o})`);
      }
      if (o >= vs.offset && o < vsEnd) {
        throw new Error(`${rule.id}: embeddedCheck.offset value alaninin icinde (${o})`);
      }
      if (vs.embeddedCheck.algorithm === 'PRICE_CHECK_4_GS1' && vs.length !== 4) {
        throw new Error(`${rule.id}: PRICE_CHECK_4_GS1 yalnizca 4 haneli alanda kullanilir`);
      }
    }
    if (rule.match.type === 'regex') {
      try {
        new RegExp(rule.match.pattern);
      } catch {
        throw new Error(`${rule.id}: gecersiz regex: ${rule.match.pattern}`);
      }
    }
  }
  if (config.minPlainLength < 1 || config.maxPlainLength < config.minPlainLength) {
    throw new Error('Gecersiz duz barkod uzunluk sinirlari');
  }
}
