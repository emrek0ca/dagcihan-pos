/**
 * HTTP katmani: yonlendirme + guvenlik ara katmanlari.
 * Framework kullanilmaz (POS ile ayni yaklasim, bagimlilik yuzeyi kucuk).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError } from './lib/errors.ts';
import type { Logger } from './lib/log.ts';
import type { Principal } from './auth.ts';

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown>;
  readonly requestId: string;
  readonly ip: string;
  readonly log: Logger;
  /** Kimlik dogrulanmis aktor; `auth: false` olan uc noktalarda null */
  readonly principal: Principal | null;
}

export type Handler = (context: RequestContext) => Promise<unknown> | unknown;

export interface RouteOptions {
  /** false ise kimlik dogrulama istenmez (health, login, enroll) */
  readonly auth?: boolean;
  /** Bu uc nokta icin ozel hiz siniri (istek/dakika) */
  readonly rateLimit?: number;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  options: RouteOptions;
  path: string;
}

// ------------------------------ hiz siniri ------------------------------

/**
 * Bellek ici sabit pencereli sayac. Tek surec icin yeterlidir; daglitik
 * kurulumda Redis'e tasinmalidir (su an tek instance).
 */
class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #windowMs: number;
  readonly #max: number;

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs;
    this.#max = max;
    const timer = setInterval(() => this.#sweep(), Math.max(windowMs, 30_000));
    timer.unref?.();
  }

  check(key: string, max = this.#max): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.#hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    entry.count++;
    if (entry.count > max) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.#hits) if (entry.resetAt <= now) this.#hits.delete(key);
  }
}

// ------------------------------ sunucu ------------------------------

export interface HttpServerOptions {
  readonly logger: Logger;
  readonly maxBodyBytes: number;
  readonly rateLimit: { windowMs: number; max: number };
  readonly trustProxy: boolean;
  readonly authenticate: (token: string) => Promise<Principal>;
  /** Tarayicidan cagri yapmasina izin verilen kaynaklar. Bos ise CORS kapalidir. */
  readonly corsOrigins?: readonly string[];
}

export class HttpServer {
  readonly #routes: Route[] = [];
  readonly #options: HttpServerOptions;
  readonly #limiter: RateLimiter;
  #server: Server | null = null;

  constructor(options: HttpServerOptions) {
    this.#options = options;
    this.#limiter = new RateLimiter(options.rateLimit.windowMs, options.rateLimit.max);
  }

  route(method: string, path: string, handler: Handler, options: RouteOptions = {}): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}/?$`,
    );
    this.#routes.push({ method, pattern, keys, handler, options, path });
  }

  get routes(): readonly { method: string; path: string }[] {
    return this.#routes.map((r) => ({ method: r.method, path: r.path }));
  }

  async listen(host: string, port: number): Promise<number> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.headersTimeout = 20_000;
    this.#server.requestTimeout = 60_000;
    await new Promise<void>((resolve) => this.#server!.listen(port, host, resolve));
    const address = this.#server.address();
    return typeof address === 'object' && address !== null ? address.port : port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.#server === null) { resolve(); return; }
      this.#server.close(() => resolve());
      this.#server.closeIdleConnections?.();
    });
  }

  #clientIp(req: IncomingMessage): string {
    if (this.#options.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (value !== undefined && value.trim() !== '') return value.split(',')[0]!.trim();
    }
    return req.socket.remoteAddress ?? 'bilinmiyor';
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    const started = Date.now();
    const ip = this.#clientIp(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const log = this.#options.logger.child({ requestId, method: req.method, path: url.pathname });

    // Guvenlik basliklari (API-only; CSP tarayici icerigi sunmadigimiz icin sikidir)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // CORS: yalnizca acikca izin verilen kaynaklar. Kimlik dogrulama Bearer
    // token ile yapildigi (cerez KULLANILMADIGI) icin kaynak izni tek basina
    // yetki vermez; token bilmeyen bir sayfa hicbir korumali veriye ulasamaz.
    // Bu nedenle Allow-Credentials ASLA acilmaz.
    const origin = req.headers.origin;
    const allowed = this.#options.corsOrigins ?? [];
    if (origin !== undefined && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      // Izin verilmeyen kaynakta da 204 doneriz; basliklar olmadigi icin
      // tarayici istegi zaten engeller, ama uc nokta varligi sizdirilmaz.
      res.writeHead(204).end();
      return;
    }

    try {
      const route = this.#match(req.method ?? 'GET', url.pathname);
      if (route === null) {
        this.#send(res, 404, { error: { code: 'NOT_FOUND', message: 'Uc nokta bulunamadi' } });
        return;
      }

      const limit = this.#limiter.check(`${ip}:${route.route.path}`, route.route.options.rateLimit);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfter));
        log.warn('Hiz siniri asildi', { ip });
        this.#send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Cok fazla istek' } });
        return;
      }

      const body = await this.#readBody(req);

      let principal: Principal | null = null;
      if (route.route.options.auth !== false) {
        const header = req.headers.authorization;
        const token = header === undefined ? null
          : (/^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim() ?? null);
        if (token === null) {
          log.warn('Kimlik dogrulama basarisiz', { reason: 'token yok', ip });
          this.#send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Token gerekli' } });
          return;
        }
        principal = await this.#options.authenticate(token);
      }

      const context: RequestContext = {
        req, res, url, params: route.params, query: url.searchParams, body, requestId, ip,
        log: principal === null ? log : log.child(
          principal.kind === 'TERMINAL'
            ? { terminalId: principal.terminalId, storeId: principal.storeId }
            : { userId: principal.userId },
        ),
        principal,
      };

      const result = await route.route.handler(context);
      if (!res.writableEnded) this.#send(res, 200, result ?? { ok: true });
      context.log.info('istek', { status: res.statusCode, durationMs: Date.now() - started });
    } catch (error) {
      this.#sendError(res, error, log, started);
    }
  }

  #match(method: string, pathname: string):
    { route: Route; params: Record<string, string> } | null {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (match === null) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] ?? '');
      });
      return { route, params };
    }
    return null;
  }

  async #readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return {};
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.#options.maxBodyBytes) {
        throw new ApiError('PAYLOAD_TOO_LARGE', 'Istek govdesi cok buyuk');
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError('BAD_REQUEST', 'Govde gecerli JSON degil');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ApiError('BAD_REQUEST', 'Govde JSON nesnesi olmali');
    }
    return parsed as Record<string, unknown>;
  }

  #send(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  #sendError(res: ServerResponse, error: unknown, log: Logger, started: number): void {
    if (error instanceof ApiError) {
      if (error.status >= 500) log.error('Sunucu hatasi', error);
      else if (error.status === 401 || error.status === 403) {
        log.warn('Yetkilendirme reddi', { code: error.code, message: error.message });
      }
      this.#send(res, error.status, error.toJSON());
      return;
    }
    log.error('Beklenmeyen hata', error, { durationMs: Date.now() - started });
    this.#send(res, 500, {
      error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata olustu' },
    });
  }
}
