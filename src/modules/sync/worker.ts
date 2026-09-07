/**
 * Arka plan senkronizasyon worker'i.
 *
 * KRITIK KURAL: Bu worker satis akisini HICBIR SEKILDE bloke etmez.
 * Kendi zamanlayicisinda calisir, tum hatalari yutar ve durumu raporlar.
 * Sunucu erisilemezse olaylar outbox'ta bekler; POS normal calismaya devam eder.
 */
import type { Db } from '../../data/db.ts';
import { OnlineOrders, type RemoteOrder } from '../orders/online-orders.ts';
import type { Clock } from '../../core/clock.ts';
import type { AuditLog } from '../audit/audit.ts';
import { Outbox, SyncStateStore } from './outbox.ts';
import { SyncClient, SyncHttpError } from './client.ts';
import { SyncApplier } from './apply.ts';
import type { CredentialStore } from './credentials.ts';

export type SyncConnectionState = 'DISABLED' | 'OFFLINE' | 'ONLINE' | 'SYNCING' | 'ERROR';

export interface SyncStatus {
  readonly enabled: boolean;
  readonly state: SyncConnectionState;
  readonly serverUrl: string | null;
  readonly terminalCode: string | null;
  readonly storeName: string | null;
  readonly pending: number;
  readonly failed: number;
  readonly dead: number;
  readonly lastPushAt: number | null;
  readonly lastPullAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly pullCursor: number;
  readonly bootstrapDone: boolean;
}

export interface SyncWorkerOptions {
  readonly pushBatchSize?: number;
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const KEY = {
  pullCursor: 'pull_cursor',
  bootstrapDone: 'bootstrap_done',
  bootstrapAfter: 'bootstrap_after',
  lastPushAt: 'last_push_at',
  lastPullAt: 'last_pull_at',
  lastSuccessAt: 'last_success_at',
  lastError: 'last_error',
} as const;

export class SyncWorker {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly outbox: Outbox;
  readonly #state: SyncStateStore;
  readonly #applier: SyncApplier;
  readonly #onlineOrders: OnlineOrders;
  /** Son siparis cekme hatasi. Senkronu durdurmaz, yalnizca bildirilir. */
  #lastOrderError: string | null = null;
  readonly #credentials: CredentialStore;
  readonly #options: Required<SyncWorkerOptions>;
  readonly #listeners: ((status: SyncStatus) => void)[] = [];

  #client: SyncClient | null = null;
  #connection: SyncConnectionState = 'DISABLED';
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #busy = false;

  constructor(deps: {
    db: Db; clock: Clock; audit: AuditLog; credentials: CredentialStore;
    options?: SyncWorkerOptions; appVersion?: string;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.outbox = new Outbox(deps.db, deps.clock);
    this.#state = new SyncStateStore(deps.db, deps.clock);
    this.#applier = new SyncApplier(deps.db, deps.clock, deps.audit);
    // Saat kaynagi tek noktadan gelir; online_orders zaman damgalari ISO metindir.
    this.#onlineOrders = new OnlineOrders(deps.db, () => new Date(deps.clock.now()).toISOString());
    this.#credentials = deps.credentials;
    this.#options = {
      pushBatchSize: deps.options?.pushBatchSize ?? 50,
      intervalMs: deps.options?.intervalMs ?? 20_000,
      maxAttempts: deps.options?.maxAttempts ?? 25,
      baseDelayMs: deps.options?.baseDelayMs ?? 2_000,
      maxDelayMs: deps.options?.maxDelayMs ?? 300_000,
    };

    const credentials = this.#credentials.read();
    if (credentials !== null) {
      this.#client = new SyncClient({
        baseUrl: credentials.serverUrl,
        ...(deps.appVersion !== undefined ? { appVersion: deps.appVersion } : {}),
      });
      this.#client.setToken(credentials.token);
      this.#connection = 'OFFLINE';
    }
  }

  get enrolled(): boolean {
    return this.#client !== null;
  }

  onStatus(listener: (status: SyncStatus) => void): void {
    this.#listeners.push(listener);
  }

  status(): SyncStatus {
    const credentials = this.#credentials.read();
    const counts = this.outbox.counts();
    const lastError = this.#state.get(KEY.lastError);
    return {
      enabled: this.#client !== null,
      state: this.#connection,
      serverUrl: credentials?.serverUrl ?? null,
      terminalCode: credentials?.terminalCode ?? null,
      storeName: credentials?.storeName ?? null,
      pending: counts.pending + counts.failed,
      failed: counts.failed,
      dead: counts.dead,
      lastPushAt: this.#state.getNumber(KEY.lastPushAt) || null,
      lastPullAt: this.#state.getNumber(KEY.lastPullAt) || null,
      lastSuccessAt: this.#state.getNumber(KEY.lastSuccessAt) || null,
      lastError,
      pullCursor: this.#state.getNumber(KEY.pullCursor),
      bootstrapDone: this.#state.get(KEY.bootstrapDone) === '1',
    };
  }

  #emit(): void {
    const status = this.status();
    for (const listener of this.#listeners) {
      try {
        listener(status);
      } catch {
        /* dinleyici hatasi worker'i durdurmaz */
      }
    }
  }

  #setState(state: SyncConnectionState, error?: string): void {
    this.#connection = state;
    // Veritabani kapandiysa (uygulama kapaniyorsa) durum yazmayi atla
    if (!this.#db.closed) {
      try {
        if (error === undefined) {
          if (state === 'ONLINE') this.#state.set(KEY.lastError, '');
        } else {
          this.#state.set(KEY.lastError, error.slice(0, 300));
        }
      } catch {
        /* durum yazilamamasi senkronizasyonu durdurmaz */
      }
    }
    this.#emit();
  }

  // ------------------------------ kayit ------------------------------

  /** Cihazi merkezi sunucuya kaydeder (tek seferlik aktivasyon) */
  async enroll(input: {
    serverUrl: string; enrollmentCode: string; terminalCode: string; name?: string;
    appVersion?: string;
  }): Promise<{ storeName: string; terminalId: string }> {
    const client = new SyncClient({
      baseUrl: input.serverUrl,
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    });
    const result = await client.enroll({
      enrollmentCode: input.enrollmentCode,
      terminalCode: input.terminalCode,
      ...(input.name !== undefined ? { name: input.name } : {}),
      osInfo: `${process.platform} ${process.arch}`,
    });

    this.#credentials.write({
      serverUrl: input.serverUrl.replace(/\/+$/, ''),
      token: result.token,
      terminalId: result.terminalId,
      terminalCode: input.terminalCode,
      storeId: result.storeId,
      storeCode: result.storeCode,
      storeName: result.storeName,
      organizationId: result.organizationId,
      enrolledAt: new Date(this.#clock.now()).toISOString(),
    });

    client.setToken(result.token);
    this.#client = client;
    this.#state.set(KEY.bootstrapDone, '0');
    this.#state.set(KEY.pullCursor, 0);
    this.#setState('OFFLINE');
    return { storeName: result.storeName, terminalId: result.terminalId };
  }

  /** Cihaz kaydini yerelde siler (sunucu tarafinda iptal ayrica yapilmalidir) */
  unenroll(): void {
    this.#credentials.clear();
    this.#client = null;
    this.#setState('DISABLED');
  }

  // ------------------------------ dongu ------------------------------

  start(): void {
    if (this.#running || this.#client === null) return;
    this.#running = true;
    this.#timer = setInterval(() => void this.runOnce(), this.#options.intervalMs);
    this.#timer.unref?.();
    void this.runOnce();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Bir tur: once gonder (satis kaybi riski), sonra cek */
  async runOnce(): Promise<SyncStatus> {
    if (this.#client === null || this.#busy) return this.status();
    this.#busy = true;
    try {
      this.#setState('SYNCING');
      await this.pushPending();
      await this.pullChanges();
      // Web siparisleri katalogdan AYRI cekilir ve hatasi YUTULUR: siparis
      // ucu erisilemez olsa bile satis, stok ve fiyat senkronu calismaya
      // devam eder. Kasanin asil isi satistir; siparis ekrani ikincildir.
      try {
        await this.pullOnlineOrders();
      } catch (error) {
        this.#lastOrderError = error instanceof Error ? error.message : String(error);
      }
      this.#state.set(KEY.lastSuccessAt, this.#clock.now());
      this.#setState('ONLINE');
    } catch (error) {
      this.#handleError(error);
    } finally {
      this.#busy = false;
    }
    return this.status();
  }

  #handleError(error: unknown): void {
    if (error instanceof SyncHttpError) {
      if (error.code === 'TERMINAL_REVOKED') {
        // Terminal iptal edilmis: yeniden denemek anlamsiz, insan mudahalesi gerekir.
        this.#setState('ERROR', 'Bu kasa merkezi sistemde iptal edilmis. Yonetici ile gorusun.');
        this.stop();
        return;
      }
      if (error.code === 'CUSTOMER_INACTIVE') {
        // Musteri hesabi merkezde pasife alinmis. SATIS DURMAZ: kasa cevrimdisi
        // calismaya devam eder, olaylar outbox'ta birikir ve hesap yeniden
        // acildiginda hicbir kayip olmadan gonderilir.
        this.#setState('ERROR', 'Merkezi hesabiniz pasif durumda. Satis devam eder, '
          + 'veriler kasada birikir. Tedarikcinizle gorusun.');
        return;
      }
      if (error.status === 401) {
        this.#setState('ERROR', 'Cihaz token gecersiz. Kasanin yeniden kaydedilmesi gerekiyor.');
        return;
      }
      if (!error.retryable && error.status >= 400 && error.status < 500) {
        this.#setState('ERROR', `Sunucu istegi reddetti: ${error.message}`);
        return;
      }
      this.#setState('OFFLINE', error.message);
      return;
    }
    this.#setState('OFFLINE', error instanceof Error ? error.message : String(error));
  }

  // ------------------------------ gonderme ------------------------------

  async pushPending(): Promise<number> {
    if (this.#client === null) return 0;
    let sentTotal = 0;

    for (let round = 0; round < 20; round++) {
      const batch = this.outbox.pending(this.#options.pushBatchSize);
      if (batch.length === 0) break;

      const response = await this.#client.push(batch);
      const sent: string[] = [];
      for (const result of response.results) {
        // DUPLICATE = sunucu zaten islemis; bizim icin BASARILIdir.
        if (result.status === 'PROCESSED' || result.status === 'DUPLICATE'
            || result.status === 'IGNORED') {
          sent.push(result.eventId);
        } else {
          this.outbox.markFailed(result.eventId, result.error ?? 'sunucu isleyemedi', {
            maxAttempts: this.#options.maxAttempts,
            baseDelayMs: this.#options.baseDelayMs,
            maxDelayMs: this.#options.maxDelayMs,
          });
        }
      }
      this.outbox.markSent(sent);
      sentTotal += sent.length;
      this.#state.set(KEY.lastPushAt, this.#clock.now());
      if (batch.length < this.#options.pushBatchSize) break;
    }
    return sentTotal;
  }

  // ------------------------------ cekme ------------------------------

  async pullChanges(): Promise<number> {
    if (this.#client === null) return 0;

    if (this.#state.get(KEY.bootstrapDone) !== '1') {
      await this.#bootstrap();
    }

    let applied = 0;
    for (let round = 0; round < 50; round++) {
      const cursor = this.#state.getNumber(KEY.pullCursor);
      const page = await this.#client.pull(cursor, 200);
      if (page.changes.length === 0) break;
      const result = this.#applier.applyChanges(page.changes);
      applied += result.created + result.updated;
      this.#state.set(KEY.pullCursor, page.cursor);
      this.#state.set(KEY.lastPullAt, this.#clock.now());
      if (!page.hasMore) break;
    }
    return applied;
  }

  /**
   * Web siparislerini ceker. Yalnizca son cekilmeden sonra DEGISENLER alinir.
   * Hata halinde senkronun geri kalani bozulmaz; bir sonraki turda tekrar denenir.
   */
  async pullOnlineOrders(): Promise<number> {
    if (this.#client === null) return 0;

    const since = this.#onlineOrders.lastRemoteUpdatedAt();
    const rows = (await this.#client.orders(since, 100)) as RemoteOrder[];
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    const result = this.#onlineOrders.upsertMany(rows);
    this.#lastOrderError = null;
    return result.created + result.updated;
  }

  /** Kasadan siparis durumu degistirir: ONCE merkeze yazilir, sonra yerele. */
  async changeOrderStatus(orderId: string, status: string, reason?: string): Promise<void> {
    if (this.#client === null) {
      throw new Error('Merkezi sunucuya bagli degil. Siparis durumu degistirilemez.');
    }
    await this.#client.changeOrderStatus(orderId, status, reason);
    this.#onlineOrders.applyStatus(orderId, status);
  }

  get onlineOrders(): OnlineOrders {
    return this.#onlineOrders;
  }

  get lastOrderError(): string | null {
    return this.#lastOrderError;
  }

  /** Ilk kurulum: merkezi katalogun sayfa sayfa indirilmesi */
  async #bootstrap(): Promise<void> {
    if (this.#client === null) return;
    let after: string | null = this.#state.get(KEY.bootstrapAfter);
    let cursorAtStart = this.#state.getNumber(KEY.pullCursor);

    for (let page = 0; page < 500; page++) {
      const response = await this.#client.bootstrap(after, 200);
      if (page === 0 && cursorAtStart === 0) {
        // Bootstrap SIRASINDA olusan degisiklikler kacmasin diye baslangic
        // imleci bootstrap'in BASINDA alinir.
        cursorAtStart = response.cursor;
      }
      if (response.products.length > 0) {
        this.#applier.applyProducts(
          response.products as never, response.cursor,
        );
      }
      after = response.nextAfter;
      if (after !== null) this.#state.set(KEY.bootstrapAfter, after);
      if (response.done) break;
    }

    this.#state.set(KEY.pullCursor, cursorAtStart);
    this.#state.set(KEY.bootstrapDone, '1');
    this.#state.set(KEY.lastPullAt, this.#clock.now());
  }

  /**
   * Merkezi stok bakiyesini yerel bakiye ile hizalar.
   *
   * MUTLAK deger degil FARK gonderilir: merkeze daha once senkronize olmus
   * satislar ikinci kez dusulmez. Islem tekrarlanabilir - ikinci calistirmada
   * fark sifir olur ve hicbir hareket uretilmez.
   */
  async reconcileStock(
    localBalances: readonly { code: string; quantity: number }[],
  ): Promise<{ adjusted: number; alreadyInSync: number }> {
    if (this.#client === null) throw new Error('Kasa merkezi sunucuya kayitli degil');
    const central = await this.#client.inventory();
    const centralMap = new Map(central.map((row) => [row.code, Number(row.on_hand)]));

    let adjusted = 0;
    let alreadyInSync = 0;
    this.#db.tx(() => {
      for (const local of localBalances) {
        const delta = local.quantity - (centralMap.get(local.code) ?? 0);
        if (delta === 0) {
          alreadyInSync++;
          continue;
        }
        this.outbox.record({
          type: 'inventory.adjusted',
          entityType: 'product',
          entityId: local.code,
          payload: {
            productCode: local.code,
            movementType: 'COUNT',
            delta,
            reference: `reconcile-${local.code}-${this.#clock.now()}`,
            note: 'POS stok mutabakati',
          },
        });
        adjusted++;
      }
    });
    return { adjusted, alreadyInSync };
  }

  /**
   * Basarisiz olaylari yeniden kuyruga alir.
   * Senkronizasyonu KENDISI tetiklemez: cagiran `runOnce()` ile devam eder.
   * (Arka planda tetiklemek, CLI gibi kisa omurlu suureclerde veritabani
   *  kapandiktan sonra yazma denemesine yol aciyordu.)
   */
  retryFailed(): number {
    return this.outbox.retryFailed();
  }
}
