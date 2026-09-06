import { randomUUID, createHash } from 'node:crypto';

/** Surecler/yeniden baslatmalar arasi kararli kimlik */
export function newUid(): string {
  return randomUUID();
}

/** Idempotency anahtari - istemci yeniden denese de ayni kalir */
export function newIdempotencyKey(): string {
  return randomUUID();
}

/** Istek govdesinin kararli ozeti (ayni anahtar + farkli istek = hata) */
export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Anahtar sirasindan bagimsiz, deterministik JSON - hash zinciri icin sart */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
