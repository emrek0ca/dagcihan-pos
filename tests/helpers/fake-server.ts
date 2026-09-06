import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Merkezi sunucunun test ikizi.
 *
 * GERCEK sunucunun sozlesmesini taklit eder: eventId'ye gore idempotency,
 * hata enjeksiyonu, kesinti simulasyonu. POS tarafinin sunucuya BAGIMLI
 * OLMADIGINI kanitlamak icin kullanilir.
 */
export interface FakeServerState {
  /** eventId -> islenme sayisi (gercekte 1 kez ISLENMELI) */
  readonly processed: Map<string, number>;
  /** Islenmis benzersiz satislar: localUid -> toplam */
  readonly sales: Map<string, number>;
  readonly received: string[];
  pushCalls: number;
  pullCalls: number;
}

export interface FakeServer {
  readonly url: string;
  readonly state: FakeServerState;
  /** Sonraki N istekte HTTP hatasi dondur */
  failNext(count: number, status?: number, code?: string): void;
  /** Sunucuyu kapat (internet kesintisi) */
  goOffline(): Promise<void>;
  /** Ayni portta yeniden ac */
  goOnline(): Promise<void>;
  /** Terminali iptal et */
  revoke(): void;
  /** Cihaza cekilecek degisiklik ekle */
  publish(change: { entity_type: string; entity_id: string; operation: string; payload: unknown }): void;
  close(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const state: FakeServerState = {
    processed: new Map(),
    sales: new Map(),
    received: [],
    pushCalls: 0,
    pullCalls: 0,
  };
  const changes: { id: number; entity_type: string; entity_id: string; operation: string; payload: unknown }[] = [];
  let failCount = 0;
  let failStatus = 500;
  let failCode = 'INTERNAL';
  let revoked = false;
  let port = 0;
  let server: Server | null = null;

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body = chunks.length > 0
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {};

      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      };

      if (url.pathname === '/health') { send(200, { status: 'ok' }); return; }

      if (revoked) {
        send(403, { error: { code: 'TERMINAL_REVOKED', message: 'Terminal iptal edilmis' } });
        return;
      }
      if (failCount > 0) {
        failCount--;
        send(failStatus, { error: { code: failCode, message: 'test hatasi' } });
        return;
      }

      if (url.pathname === '/api/v1/devices/enroll') {
        send(200, {
          token: 'pos_test_token', terminalId: 'terminal-1', storeId: 'store-1',
          storeName: 'Test Magaza', storeCode: 'TEST', organizationId: 'org-1',
        });
        return;
      }

      if (url.pathname === '/api/v1/sync/push') {
        state.pushCalls++;
        const events = (body.events ?? []) as { eventId: string; type: string; payload: Record<string, unknown> }[];
        const results = events.map((event) => {
          state.received.push(event.eventId);
          if (state.processed.has(event.eventId)) {
            return { eventId: event.eventId, status: 'DUPLICATE' };
          }
          state.processed.set(event.eventId, 1);
          if (event.type === 'sale.completed' || event.type === 'sale.refunded') {
            const uid = String(event.payload.localUid);
            state.sales.set(uid, Number(event.payload.total));
          }
          return { eventId: event.eventId, status: 'PROCESSED' };
        });
        send(200, {
          results,
          accepted: results.filter((r) => r.status === 'PROCESSED').length,
          duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
          failed: 0,
        });
        return;
      }

      if (url.pathname === '/api/v1/sync/bootstrap') {
        send(200, { products: [], nextAfter: null, done: true, cursor: changes.at(-1)?.id ?? 0 });
        return;
      }

      if (url.pathname === '/api/v1/sync/pull') {
        state.pullCalls++;
        const cursor = Number(url.searchParams.get('cursor') ?? '0');
        const page = changes.filter((c) => c.id > cursor);
        send(200, { changes: page, cursor: page.at(-1)?.id ?? cursor, hasMore: false });
        return;
      }

      send(404, { error: { code: 'NOT_FOUND', message: 'yok' } });
    });
  };

  const listen = (): Promise<void> =>
    new Promise((resolve) => {
      server = createServer(handler);
      server.listen(port, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port;
        resolve();
      });
    });

  await listen();

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (server === null) { resolve(); return; }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    server = null;
  };

  const fake: FakeServer = {
    get url() { return `http://127.0.0.1:${port}`; },
    state,
    failNext(count, status = 500, code = 'INTERNAL') {
      failCount = count; failStatus = status; failCode = code;
    },
    goOffline: stop,
    async goOnline() { if (server === null) await listen(); },
    revoke() { revoked = true; },
    publish(change) {
      changes.push({ id: changes.length + 1, ...change });
    },
    async close() {
      revoked = false;
      await stop();
    },
  };
  return fake;
}
