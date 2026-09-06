/**
 * Token ve parola isleri.
 * Token'lar veritabaninda YALNIZCA SHA-256 ozetiyle saklanir; duz metin
 * bir kez uretilir ve yalnizca o an istemciye verilir.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface GeneratedToken {
  readonly plaintext: string;
  readonly hash: string;
  readonly prefix: string;
}

/** Yuksek entropili token: <prefix>_<32 bayt base64url> */
export function generateToken(prefix: string): GeneratedToken {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${prefix}_${secret}`;
  return { plaintext, hash: hashToken(plaintext), prefix: plaintext.slice(0, 12) };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Insan tarafindan girilen kisa kayit kodu (karisikligi onlemek icin sinirli alfabe) */
export function generateEnrollmentCode(): GeneratedToken {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i < 11) code += '-';
  }
  return { plaintext: code, hash: hashToken(code), prefix: code.slice(0, 4) };
}

const KEY_LENGTH = 64;

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? randomBytes(16).toString('hex');
  return { hash: scryptSync(password, s, KEY_LENGTH).toString('hex'), salt: s };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const computed = scryptSync(password, salt, KEY_LENGTH);
  const stored = Buffer.from(hash, 'hex');
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(computed, stored);
}

/** Istek govdesinin kararli ozeti (idempotency dogrulamasi icin) */
export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
