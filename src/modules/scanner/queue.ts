/**
 * Okuma kuyrugu.
 *
 * Magaza gercegi: barkodlar art arda cok hizli okutulur. Bu kuyruk
 *  - okumalari SIRAYLA isler (veritabani yarisi olmaz, satir sirasi bozulmaz),
 *  - cok kisa surede gelen BIREBIR AYNI ham diziyi (cift okuma sicramasi) eler,
 *  - bir okumadaki hatanin sonrakileri engellemesini onler.
 */
import type { ScanEvent, ScannerPort } from '../../hardware/ports.ts';
import type { Clock } from '../../core/clock.ts';
import { PosError, isPosError } from '../../core/errors.ts';
import type { ScanResolver } from './resolve.ts';
import type { SalesService } from '../sales/sales.ts';
import type { SaleView } from '../sales/types.ts';

export interface ScanOutcome {
  readonly ok: boolean;
  readonly raw: string;
  readonly at: number;
  readonly sale?: SaleView;
  readonly productName?: string;
  readonly amount?: number;
  readonly warnings?: readonly string[];
  readonly error?: { code: string; message: string; userMessage: string };
  readonly duplicateIgnored?: boolean;
}

export interface ScanQueueContext {
  readonly terminalId: number;
  getUserId(): number | null;
  getSaleId(): number | null;
  /** Acik fis yoksa yenisini acar (kasiyer ekstra islem yapmasin) */
  ensureSaleId(): number;
}

export class ScanQueue {
  readonly #resolver: ScanResolver;
  readonly #sales: SalesService;
  readonly #clock: Clock;
  readonly #context: ScanQueueContext;
  readonly #dedupeWindowMs: number;
  readonly #listeners: ((outcome: ScanOutcome) => void)[] = [];
  #chain: Promise<void> = Promise.resolve();
  #lastRaw = '';
  #lastAt = 0;
  #depth = 0;

  constructor(deps: {
    resolver: ScanResolver;
    sales: SalesService;
    clock: Clock;
    context: ScanQueueContext;
    dedupeWindowMs?: number;
  }) {
    this.#resolver = deps.resolver;
    this.#sales = deps.sales;
    this.#clock = deps.clock;
    this.#context = deps.context;
    this.#dedupeWindowMs = deps.dedupeWindowMs ?? 120;
  }

  get queueDepth(): number {
    return this.#depth;
  }

  onOutcome(listener: (outcome: ScanOutcome) => void): void {
    this.#listeners.push(listener);
  }

  attach(scanner: ScannerPort): void {
    scanner.onScan((event) => {
      void this.submit(event.raw, event.at);
    });
  }

  /** Okumayi kuyruga alir; sonuc sirayla isleniyor olsa da hemen doner */
  submit(raw: string, at: number = this.#clock.now()): Promise<ScanOutcome> {
    this.#depth++;
    const task = this.#chain.then(() => this.#process(raw, at));
    this.#chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task.finally(() => {
      this.#depth--;
    });
  }

  #process(raw: string, at: number): ScanOutcome {
    // Cift okuma sicramasi: cok kisa surede birebir ayni dizi
    if (raw === this.#lastRaw && at - this.#lastAt < this.#dedupeWindowMs) {
      const outcome: ScanOutcome = { ok: true, raw, at, duplicateIgnored: true };
      this.#emit(outcome);
      return outcome;
    }
    this.#lastRaw = raw;
    this.#lastAt = at;

    const userId = this.#context.getUserId();
    if (userId === null) {
      return this.#fail(raw, at, new PosError('UNAUTHORIZED', 'Kasiyer girisi yapilmadi', {
        userMessage: 'Once kasiyer girisi yapin.',
      }));
    }

    try {
      const saleId = this.#context.ensureSaleId();
      const item = this.#resolver.resolve(raw, {
        terminalId: this.#context.terminalId,
        userId,
        saleId,
      });
      const sale = this.#sales.addItem(saleId, item, userId);
      const line = sale.items.filter((i) => !i.voided).at(-1);
      const outcome: ScanOutcome = {
        ok: true,
        raw,
        at,
        sale,
        productName: item.product.name,
        ...(line !== undefined ? { amount: line.net } : {}),
        ...(item.warnings.length > 0 ? { warnings: item.warnings } : {}),
      };
      this.#emit(outcome);
      return outcome;
    } catch (error) {
      return this.#fail(raw, at, error);
    }
  }

  #fail(raw: string, at: number, error: unknown): ScanOutcome {
    const posError = isPosError(error)
      ? error
      : new PosError('INTERNAL', (error as Error).message, { cause: error });
    const outcome: ScanOutcome = {
      ok: false,
      raw,
      at,
      error: {
        code: posError.code,
        message: posError.message,
        userMessage: posError.userMessage,
      },
    };
    this.#emit(outcome);
    return outcome;
  }

  #emit(outcome: ScanOutcome): void {
    for (const listener of this.#listeners) {
      try {
        listener(outcome);
      } catch {
        /* dinleyici hatasi kuyrugu durdurmaz */
      }
    }
  }
}
