/**
 * Yerel HTTP + SSE sunucusu.
 *
 * YALNIZCA 127.0.0.1'e baglanir - disaridan erisim yoktur.
 * Arayuz (Asama 7) bu API'yi kullanir; ayni API ileride baska bir istemciye de
 * hizmet verebilir. Is mantigi burada DEGILDIR, yalnizca tasima katmanidir.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PosApplication } from './pos.ts';
import { PosError, isPosError } from '../core/errors.ts';
import { money, type Money } from '../core/money/money.ts';
import { quantity } from '../core/quantity/quantity.ts';
import { ScanQueue, type ScanOutcome } from '../modules/scanner/queue.ts';
import { requirePermission, type User } from '../modules/users/users.ts';
import { registerAdminRoutes } from './admin-routes.ts';
import { CASHIER_TRANSITIONS, STATUS_LABELS } from '../modules/orders/online-orders.ts';
import { PROJECT_ROOT } from '../config/load.ts';
import type { HidWedgeScanner } from '../hardware/scanner/adapters.ts';

interface Session {
  readonly token: string;
  readonly user: User;
  readonly since: number;
}

type Handler = (context: RequestContext) => Promise<unknown> | unknown;

interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly session: Session | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export class PosServer {
  readonly #app: PosApplication;
  readonly #uiRoot: string;
  readonly #sessions = new Map<string, Session>();
  readonly #clients = new Set<ServerResponse>();
  readonly #routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  #scanQueue: ScanQueue | null = null;
  #server: ReturnType<typeof createServer> | null = null;
  #activeToken: string | null = null;

  constructor(
    app: PosApplication,
    options: {
      uiRoot: string;
      /** Yonetim ekranlarindan yazilacak ayar dosyalari (paketli uygulamada
       *  kullanici veri klasorundedir; salt-okunur program klasorunde degil) */
      configFiles?: { posConfigFile: string; barcodeConfigFile: string };
    },
  ) {
    this.#app = app;
    this.#uiRoot = options.uiRoot;
    this.#registerRoutes();
    registerAdminRoutes({
      app,
      route: (method, path, handler) =>
        this.#route(method, path, (context) => handler(context)),
      requireUser: (context) => this.#requireUser(context as RequestContext),
      pushState: () => this.#pushState(),
      configFiles: options.configFiles ?? {
        posConfigFile: join(PROJECT_ROOT, 'config', 'pos.config.json'),
        barcodeConfigFile: join(PROJECT_ROOT, 'config', 'barcode-rules.json'),
      },
    });
  }

  // ------------------------------ Yasam dongusu ------------------------------

  /**
   * @param options.port 0 verilirse isletim sistemi bos bir port secer.
   *   Yapilandirilmis port bir baska program tarafindan kullaniliyorsa
   *   otomatik olarak bos porta dusulur - kasa acilmama riski olmaz.
   */
  async listen(options: { port?: number; host?: string } = {}): Promise<number> {
    const host = options.host ?? this.#app.config.server.host;
    const port = options.port ?? this.#app.config.server.port;
    this.#server = createServer((req, res) => void this.#handle(req, res));

    const bind = (target: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          this.#server?.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          this.#server?.removeListener('error', onError);
          resolve();
        };
        this.#server!.once('error', onError);
        this.#server!.once('listening', onListening);
        this.#server!.listen(target, host);
      });

    try {
      await bind(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await bind(0);
    }

    const address = this.#server.address();
    return typeof address === 'object' && address !== null ? address.port : port;
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    await new Promise<void>((resolve) => {
      if (this.#server === null) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
  }

  // ------------------------------ Oturum ------------------------------

  #currentUser(): User | null {
    if (this.#activeToken === null) return null;
    return this.#sessions.get(this.#activeToken)?.user ?? null;
  }

  #requireUser(context: RequestContext): User {
    if (context.session === null) {
      throw new PosError('UNAUTHORIZED', 'Oturum yok', { userMessage: 'Once giris yapin.' });
    }
    return context.session.user;
  }

  #queue(): ScanQueue {
    if (this.#scanQueue === null) {
      this.#scanQueue = new ScanQueue({
        resolver: this.#app.resolver,
        sales: this.#app.sales,
        clock: this.#app.clock,
        dedupeWindowMs: this.#app.config.sales.scanDedupeWindowMs,
        context: {
          terminalId: this.#app.terminalId,
          getUserId: () => this.#currentUser()?.id ?? null,
          getSaleId: () =>
            this.#app.sales.currentOpenSale(this.#app.terminalId)?.id ?? null,
          ensureSaleId: () => {
            const user = this.#currentUser();
            if (user === null) throw new PosError('UNAUTHORIZED', 'Kasiyer girisi yok');
            return this.#app.ensureOpenSale(user.id);
          },
        },
      });
      this.#scanQueue.onOutcome((outcome) => this.broadcast('scan', outcome));
      this.#scanQueue.attach(this.#app.devices.scanner);
    }
    return this.#scanQueue;
  }

  // ------------------------------ SSE ------------------------------

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#clients) {
      try {
        client.write(payload);
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  // ------------------------------ Yonlendirme ------------------------------

  #route(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    this.#routes.push({ method, pattern, keys, handler });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/events') {
      this.#openEventStream(res);
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      await this.#serveStatic(url.pathname, res);
      return;
    }

    let body: Record<string, unknown> = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        body = await readJsonBody(req);
      } catch {
        this.#send(res, 400, { error: { code: 'BAD_REQUEST', userMessage: 'Gecersiz istek.' } });
        return;
      }
    }

    const token = (req.headers['x-pos-token'] as string | undefined) ?? '';
    const session = this.#sessions.get(token) ?? null;

    for (const route of this.#routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (match === null) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '');
      });
      try {
        const result = await route.handler({ req, res, url, params, body, session });
        if (!res.writableEnded) this.#send(res, 200, result ?? { ok: true });
      } catch (error) {
        this.#sendError(res, error);
      }
      return;
    }
    this.#send(res, 404, { error: { code: 'NOT_FOUND', userMessage: 'Bulunamadi.' } });
  }

  #openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': baglandi\n\n');
    this.#clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 20000);
    ping.unref?.();
    res.on('close', () => {
      clearInterval(ping);
      this.#clients.delete(res);
    });
  }

  async #serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const relative = pathname === '/' ? '/index.html' : pathname;
    const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
    const file = join(this.#uiRoot, safe);
    if (!file.startsWith(this.#uiRoot)) {
      res.writeHead(403).end('Yasak');
      return;
    }
    try {
      const content = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sayfa bulunamadi');
    }
  }

  #send(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  #sendError(res: ServerResponse, error: unknown): void {
    if (isPosError(error)) {
      const status =
        error.code === 'UNAUTHORIZED' || error.code === 'INVALID_CREDENTIALS' ? 401
          : error.code === 'APPROVAL_REQUIRED' ? 403
            : error.code === 'SALE_NOT_FOUND' || error.code === 'PRODUCT_NOT_FOUND' ? 404
              : 400;
      this.#send(res, status, { error: error.toJSON() });
      return;
    }
    const message = (error as Error).message;
    this.#send(res, 500, {
      error: { code: 'INTERNAL', message, userMessage: 'Beklenmeyen hata olustu.' },
    });
  }

  // ------------------------------ Uc noktalar ------------------------------

  #state(): Record<string, unknown> {
    const user = this.#currentUser();
    const sale = this.#app.sales.currentOpenSale(this.#app.terminalId);
    const session = this.#app.cashRegister.current(this.#app.terminalId);
    return {
      user: user === null ? null : { id: user.id, name: user.displayName, role: user.role },
      terminal: {
        id: this.#app.terminalId,
        code: this.#app.config.terminal.code,
        name: this.#app.config.terminal.name,
      },
      cashSession: session ?? null,
      sale: sale ?? null,
      parkedCount: this.#app.sales.listParked(this.#app.terminalId).length,
      devices: {
        scanner: this.#app.devices.scanner.status(),
        printerPending: this.#app.printQueue.pendingCount(),
        printerFailed: this.#app.printQueue.failedCount(),
        simulated: this.#app.devices.simulated,
      },
      weightedFormatConfirmed: this.#app.barcodeConfig.weightedFormatConfirmed,
      hardwareSetupCompleted: this.#app.config.hardware.setupCompletedAt !== null,
      sync: (() => {
        const status = this.#app.sync.status();
        return {
          enabled: status.enabled,
          state: status.state,
          pending: status.pending,
          dead: status.dead,
          lastSuccessAt: status.lastSuccessAt,
          storeName: status.storeName,
        };
      })(),
      store: { name: this.#app.config.store.name },
      // Kasiyerin henuz gormedigi web siparisi sayisi. Rozet ve sesli uyari
      // bunun uzerinden calisir; her durum guncellemesinde tasinir ki
      // kasiyer siparisi kacirmasin.
      onlineOrders: (() => {
        try {
          return { unseen: this.#app.sync.onlineOrders.unseenCount() };
        } catch {
          return { unseen: 0 };
        }
      })(),
    };
  }

  #pushState(): void {
    this.broadcast('state', this.#state());
  }

  #registerRoutes(): void {
    const num = (value: unknown, field: string): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PosError('INTERNAL', `${field} sayi olmali`);
      }
      return value;
    };

    this.#route('POST', '/api/login', ({ body }) => {
      const user = this.#app.users.login(
        String(body.username ?? ''), String(body.pin ?? ''), this.#app.terminalId,
      );
      const token = randomUUID();
      this.#sessions.set(token, { token, user, since: this.#app.clock.now() });
      this.#activeToken = token;
      this.#queue();
      this.#pushState();
      return { token, user: { id: user.id, name: user.displayName, role: user.role } };
    });

    this.#route('POST', '/api/logout', ({ session }) => {
      if (session !== null) this.#sessions.delete(session.token);
      if (this.#activeToken === session?.token) this.#activeToken = null;
      this.#pushState();
      return { ok: true };
    });

    this.#route('GET', '/api/state', () => this.#state());

    this.#route('POST', '/api/scan', async (context) => {
      this.#requireUser(context);
      const raw = String(context.body.raw ?? '');
      const outcome: ScanOutcome = await this.#queue().submit(raw);
      this.#pushState();
      if (!outcome.ok && outcome.error !== undefined) {
        throw new PosError(
          outcome.error.code as never, outcome.error.message,
          { userMessage: outcome.error.userMessage },
        );
      }
      return outcome;
    });

    /** Klavye-emulasyonlu okuyucudan gelen tek tus (odak gerektirmeyen yakalama) */
    this.#route('POST', '/api/scan/char', (context) => {
      this.#requireUser(context);
      const scanner = this.#app.devices.scanner as HidWedgeScanner;
      if (typeof scanner.submitChar === 'function') {
        scanner.submitChar(String(context.body.char ?? ''));
      }
      return { ok: true };
    });

    this.#route('POST', '/api/items', (context) => {
      const user = this.#requireUser(context);
      const saleId = this.#app.ensureOpenSale(user.id);
      const item = this.#app.resolver.resolveProduct(
        num(context.body.productId, 'productId'),
        quantity(num(context.body.quantity ?? 1000, 'quantity')),
      );
      const sale = this.#app.sales.addItem(saleId, item, user.id);
      this.#pushState();
      return sale;
    });

    this.#route('POST', '/api/items/:lineNo/quantity', (context) => {
      const user = this.#requireUser(context);
      const saleId = this.#app.ensureOpenSale(user.id);
      const sale = this.#app.sales.changeQuantity(
        saleId, Number(context.params.lineNo),
        quantity(num(context.body.quantity, 'quantity')), user.id,
      );
      this.#pushState();
      return sale;
    });

    this.#route('POST', '/api/items/:lineNo/void', (context) => {
      const user = this.#requireUser(context);
      requirePermission(user, 'LINE_VOID');
      const saleId = this.#app.ensureOpenSale(user.id);
      const sale = this.#app.sales.voidLine(
        saleId, Number(context.params.lineNo), user.id,
        String(context.body.reason ?? 'kasiyer iptali'),
      );
      this.#pushState();
      return sale;
    });

    this.#route('POST', '/api/items/:lineNo/discount', (context) => {
      const user = this.#requireUser(context);
      requirePermission(user, 'DISCOUNT_APPLY');
      const saleId = this.#app.ensureOpenSale(user.id);
      const approver = this.#approver(context.body);
      const sale = this.#app.sales.applyLineDiscount(
        saleId, Number(context.params.lineNo), this.#discount(context.body), user.id,
        approver?.id,
      );
      this.#pushState();
      return sale;
    });

    this.#route('POST', '/api/sale/discount', (context) => {
      const user = this.#requireUser(context);
      requirePermission(user, 'DISCOUNT_APPLY');
      const saleId = this.#app.ensureOpenSale(user.id);
      const approver = this.#approver(context.body);
      const sale = this.#app.sales.applySaleDiscount(
        saleId, this.#discount(context.body), user.id, approver?.id,
      );
      this.#pushState();
      return sale;
    });

    this.#route('POST', '/api/sale/complete', (context) => {
      const user = this.#requireUser(context);
      const saleId = num(context.body.saleId, 'saleId');
      const payments = (context.body.payments as { method: string; tendered: number }[] | undefined)
        ?? [];
      const result = this.#app.sales.complete({
        saleId,
        userId: user.id,
        idempotencyKey: String(context.body.idempotencyKey ?? randomUUID()),
        payments: payments.map((p) => ({
          method: p.method === 'CARD' ? 'CARD' : 'CASH',
          tendered: money(p.tendered),
        })),
        ...(typeof context.body.expectedTotal === 'number'
          ? { expectedTotal: money(context.body.expectedTotal) }
          : {}),
      });
      this.#pushState();
      void this.#app.printQueue.processDue();
      return result;
    });

    this.#route('POST', '/api/sale/void', (context) => {
      const user = this.#requireUser(context);
      const approver = this.#approver(context.body);
      const actor = approver ?? user;
      requirePermission(actor, 'SALE_VOID');
      const saleId = num(context.body.saleId, 'saleId');
      const sale = this.#app.sales.voidSale(
        saleId, user.id, String(context.body.reason ?? 'fis iptali'), approver?.id,
      );
      this.#pushState();
      return sale;
    });

    this.#route('POST', '/api/sale/park', (context) => {
      const user = this.#requireUser(context);
      const sale = this.#app.sales.park(num(context.body.saleId, 'saleId'), user.id);
      this.#pushState();
      return sale;
    });

    this.#route('POST', '/api/sale/resume', (context) => {
      const user = this.#requireUser(context);
      const sale = this.#app.sales.resume(num(context.body.saleId, 'saleId'), user.id);
      this.#pushState();
      return sale;
    });

    this.#route('GET', '/api/sale/parked', () =>
      this.#app.sales.listParked(this.#app.terminalId));

    this.#route('GET', '/api/sales/recent', () =>
      this.#app.sales.recent(this.#app.terminalId, 20));

    this.#route('GET', '/api/sales/:id', ({ params }) =>
      this.#app.sales.view(Number(params.id)));

    this.#route('POST', '/api/refund', (context) => {
      const user = this.#requireUser(context);
      const approver = this.#approver(context.body);
      requirePermission(approver ?? user, 'REFUND');
      const session = this.#app.cashRegister.requireOpen(this.#app.terminalId);
      const lines = (context.body.lines as { lineNo: number; quantity?: number }[] | undefined)
        ?? [];
      const refund = this.#app.sales.createRefund({
        originalSaleId: num(context.body.originalSaleId, 'originalSaleId'),
        lines: lines.map((l) => ({
          lineNo: l.lineNo,
          ...(l.quantity !== undefined ? { quantity: quantity(l.quantity) } : {}),
        })),
        terminalId: this.#app.terminalId,
        userId: user.id,
        cashSessionId: session.id,
        ...(approver !== null ? { approvedBy: approver.id } : {}),
      });
      this.#pushState();
      return refund;
    });

    this.#route('GET', '/api/products/search', ({ url }) =>
      this.#app.products.search(url.searchParams.get('q') ?? '', 40));

    this.#route('POST', '/api/cash/open', (context) => {
      const user = this.#requireUser(context);
      requirePermission(user, 'CASH_SESSION_OPEN');
      const session = this.#app.cashRegister.open({
        terminalId: this.#app.terminalId,
        userId: user.id,
        openingFloat: money(num(context.body.openingFloat ?? 0, 'openingFloat')),
      });
      this.#pushState();
      return session;
    });

    this.#route('POST', '/api/cash/close', (context) => {
      const user = this.#requireUser(context);
      const approver = this.#approver(context.body);
      requirePermission(approver ?? user, 'CASH_SESSION_CLOSE');
      const session = this.#app.cashRegister.requireOpen(this.#app.terminalId);
      const summary = this.#app.cashRegister.close({
        sessionId: session.id,
        userId: user.id,
        countedCash: money(num(context.body.countedCash, 'countedCash')),
      });
      this.#app.printQueue.enqueueDocument(
        this.#app.buildSessionReportDocument(session.id, 'Z_REPORT'),
        { requestedBy: user.id },
      );
      void this.#app.printQueue.processDue();
      this.#pushState();
      return summary;
    });

    this.#route('GET', '/api/cash/summary', (context) => {
      this.#requireUser(context);
      const session = this.#app.cashRegister.requireOpen(this.#app.terminalId);
      return this.#app.cashRegister.summary(session.id);
    });

    this.#route('POST', '/api/cash/movement', (context) => {
      const user = this.#requireUser(context);
      requirePermission(user, 'CASH_PAID_IN_OUT');
      const session = this.#app.cashRegister.requireOpen(this.#app.terminalId);
      this.#app.cashRegister.movement({
        sessionId: session.id,
        type: context.body.type === 'PAID_IN' ? 'PAID_IN' : 'PAID_OUT',
        amount: money(num(context.body.amount, 'amount')),
        userId: user.id,
        note: String(context.body.note ?? ''),
      });
      this.#pushState();
      return this.#app.cashRegister.summary(session.id);
    });

    this.#route('POST', '/api/print/reprint', (context) => {
      const user = this.#requireUser(context);
      requirePermission(user, 'RECEIPT_REPRINT');
      const jobId = this.#app.printQueue.reprint(num(context.body.saleId, 'saleId'), user.id);
      void this.#app.printQueue.processDue();
      this.#pushState();
      return { jobId };
    });

    this.#route('POST', '/api/print/retry', (context) => {
      this.#requireUser(context);
      const count = this.#app.printQueue.retryFailed();
      void this.#app.printQueue.processDue();
      this.#pushState();
      return { retried: count };
    });

    this.#route('GET', '/api/print/jobs', () => this.#app.printQueue.pending());

    // ---------------------------- web siparisleri ----------------------------

    this.#route('GET', '/api/orders/online', (context) => {
      this.#requireUser(context);
      const statusParam = context.url.searchParams.get('status');
      const statuses = statusParam === null
        ? ['PAID', 'PREPARING', 'READY']
        : statusParam.split(',').map((value: string) => value.trim().toUpperCase()).filter(Boolean);
      return {
        orders: this.#app.sync.onlineOrders.list(statuses),
        unseen: this.#app.sync.onlineOrders.unseenCount(),
        lastError: this.#app.sync.lastOrderError,
      };
    });

    this.#route('GET', '/api/orders/online/:id', ({ params }) => {
      const order = this.#app.sync.onlineOrders.get(String(params.id));
      if (order === null) throw new PosError('ONLINE_ORDER_NOT_FOUND', 'Siparis bulunamadi');
      return order;
    });

    this.#route('POST', '/api/orders/online/seen', (context) => {
      const ids = Array.isArray(context.body.ids) ? context.body.ids.map(String) : [];
      return { marked: this.#app.sync.onlineOrders.markSeen(ids) };
    });

    /**
     * Durum degisikligi ONCE merkeze yazilir. Merkez reddederse yerelde de
     * degismez; kasiyer yaniltici bir durum gormez.
     */
    this.#route('POST', '/api/orders/online/:id/status', async (context) => {
      const user = this.#requireUser(context);
      const id = String(context.params.id);
      const status = String(context.body.status ?? '').toUpperCase();
      const order = this.#app.sync.onlineOrders.get(id);
      if (order === null) throw new PosError('ONLINE_ORDER_NOT_FOUND', 'Siparis bulunamadi');

      const allowed = CASHIER_TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(status)) {
        throw new PosError('ONLINE_ORDER_INVALID_TRANSITION',
          `${order.status} -> ${status} gecisi yapilamaz`, {
            userMessage: `${STATUS_LABELS[order.status] ?? order.status} durumundaki siparis bu duruma gecirilemez.`,
          });
      }

      await this.#app.sync.changeOrderStatus(id, status,
        typeof context.body.reason === 'string' ? context.body.reason : undefined);
      this.#app.audit.record({
        type: 'ONLINE_ORDER_STATUS',
        entity: 'ONLINE_ORDER',
        entityId: id,
        userId: user.id,
        data: { from: order.status, to: status },
      });
      this.#pushState();
      return { ok: true, status };
    });
  }

  #discount(body: Record<string, unknown>): { type: 'PERCENT' | 'AMOUNT'; value: number } | null {
    if (body.discount === null || body.discount === undefined) return null;
    const d = body.discount as { type?: string; value?: number };
    if (typeof d.value !== 'number') return null;
    return { type: d.type === 'AMOUNT' ? 'AMOUNT' : 'PERCENT', value: d.value };
  }

  #approver(body: Record<string, unknown>): User | null {
    const approval = body.approval as { username?: string; pin?: string } | undefined;
    if (approval?.username === undefined || approval.pin === undefined) return null;
    return this.#app.users.login(approval.username, approval.pin, this.#app.terminalId);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('Istek govdesi cok buyuk');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

export type { Money };
