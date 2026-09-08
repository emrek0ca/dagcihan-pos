/**
 * Merkezi sunucu HTTP istemcisi (sifir bagimlilik: node:http/https).
 *
 * Bu istemci SATISIN KRITIK YOLUNDA DEGILDIR. Yalnizca arka plan worker'i
 * tarafindan cagrilir; her cagri kisa zaman asimlidir ve hata firlatir,
 * yeniden deneme worker'in isidir.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type { PendingEvent } from './outbox.ts';

export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
    this.code = code;
    // 4xx istemci hatasidir: ayni istekle tekrar denemek anlamsizdir.
    // 401/403 ozel ele alinir (token/terminal sorunu), 408/429 tekrar denenir.
    this.retryable = status === 0 || status >= 500 || status === 408 || status === 429;
  }
}

export interface SyncClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly appVersion?: string;
  /** Sertifika dogrulamasini kapatmaz; yalnizca test sunuculari icin ozel CA */
  readonly insecureTls?: boolean;
}

export interface PushResult {
  readonly results: { eventId: string; status: string; error?: string }[];
  readonly accepted: number;
  readonly duplicates: number;
  readonly failed: number;
}

export interface BootstrapPage {
  readonly products: Record<string, unknown>[];
  readonly nextAfter: string | null;
  readonly done: boolean;
  readonly cursor: number;
}

export interface PullPage {
  readonly changes: {
    id: number; entity_type: string; entity_id: string;
    operation: string; payload: Record<string, unknown>;
  }[];
  readonly cursor: number;
  readonly hasMore: boolean;
}

export class SyncClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #appVersion: string;
  readonly #insecureTls: boolean;
  #token: string | null = null;

  constructor(options: SyncClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#appVersion = options.appVersion ?? '1.0.0';
    this.#insecureTls = options.insecureTls ?? false;
  }

  setToken(token: string | null): void {
    this.#token = token;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async #call<T>(
    method: string, path: string, body?: unknown, options: { auth?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const isHttps = url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;

    return new Promise<T>((resolve, reject) => {
      const req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? (isHttps ? 443 : 80) : url.port,
          path: `${url.pathname}${url.search}`,
          method,
          timeout: this.#timeoutMs,
          // Keep-alive KAPALI: sunucu yeniden baslatildiginda havuzdaki olu
          // soket yeniden kullanilip "socket hang up" alinmasini onler.
          // 20 saniyede bir senkronizasyon icin baglanti yeniden kurma maliyeti
          // ihmal edilebilir; dayaniklilik daha onemlidir.
          agent: false,
          headers: {
            Accept: 'application/json',
            'User-Agent': `dagcihan-pos/${this.#appVersion}`,
            ...(payload === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': payload.length }),
            ...(options.auth !== false && this.#token !== null
              ? { Authorization: `Bearer ${this.#token}` }
              : {}),
          },
          ...(isHttps && this.#insecureTls ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            // Sunucudan asiri buyuk yanit gelirse belleği doldurmasin
            if (size > 16 * 1024 * 1024) {
              req.destroy();
              reject(new SyncHttpError(0, 'RESPONSE_TOO_LARGE', 'Yanit cok buyuk'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            let json: unknown = {};
            if (text.trim() !== '') {
              try {
                json = JSON.parse(text);
              } catch {
                reject(new SyncHttpError(status, 'BAD_JSON', 'Sunucu yaniti cozumlenemedi'));
                return;
              }
            }
            if (status >= 200 && status < 300) {
              resolve(json as T);
              return;
            }
            const error = (json as { error?: { code?: string; message?: string } }).error;
            reject(new SyncHttpError(
              status,
              error?.code ?? `HTTP_${status}`,
              error?.message ?? `Sunucu hatasi (${status})`,
            ));
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new SyncHttpError(0, 'TIMEOUT', 'Sunucuya baglanti zaman asimina ugradi'));
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        reject(new SyncHttpError(0, error.code ?? 'NETWORK', error.message));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  health(): Promise<{ status: string }> {
    return this.#call('GET', '/health', undefined, { auth: false });
  }

  enroll(input: {
    enrollmentCode: string; terminalCode: string; name?: string; osInfo?: string;
  }): Promise<{
    token: string; terminalId: string; storeId: string; storeName: string;
    storeCode: string; organizationId: string;
  }> {
    return this.#call('POST', '/api/v1/devices/enroll', {
      ...input, appVersion: this.#appVersion,
    }, { auth: false });
  }

  push(events: readonly PendingEvent[]): Promise<PushResult> {
    return this.#call('POST', '/api/v1/sync/push', {
      appVersion: this.#appVersion,
      events: events.map((event) => ({
        eventId: event.eventId,
        type: event.type,
        ...(event.entityType !== null ? { entityType: event.entityType } : {}),
        ...(event.entityId !== null ? { entityId: event.entityId } : {}),
        sequence: event.sequence,
        occurredAt: new Date(event.occurredAt).toISOString(),
        payload: event.payload,
      })),
    });
  }

  bootstrap(after: string | null, limit = 200): Promise<BootstrapPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after !== null) query.set('after', after);
    return this.#call('GET', `/api/v1/sync/bootstrap?${query}`);
  }

  pull(cursor: number, limit = 200): Promise<PullPage> {
    return this.#call('GET', `/api/v1/sync/pull?cursor=${cursor}&limit=${limit}`);
  }

  /** Merkezi stok bakiyeleri (yerelle karsilastirip FARKI gondermek icin) */
  inventory(): Promise<{ code: string; on_hand: number; reserved: number }[]> {
    return this.#call('GET', '/api/v1/sync/inventory');
  }

  status(): Promise<Record<string, unknown>> {
    return this.#call('GET', '/api/v1/sync/status');
  }

  /**
   * Insan kullanici girisi. YALNIZCA ilk katalog aktariminda kullanilir;
   * gunluk senkronizasyon cihaz token'i ile yapilir ve kullanici parolasi
   * POS'ta HICBIR ZAMAN saklanmaz.
   */
  loginUser(email: string, password: string): Promise<{ token: string }> {
    return this.#call('POST', '/api/v1/auth/login', { email, password }, { auth: false });
  }

  upsertProduct(product: {
    code: string; name: string; unit: 'EACH' | 'KG'; unitPrice: number;
    taxRateBp: number; trackStock: boolean; barcodes: string[]; plus: number[];
  }): Promise<{ id: string; code: string }> {
    return this.#call('POST', '/api/v1/products', product);
  }
}
