/**
 * Dayanikli fis kuyrugu.
 *
 * Ilke: YAZICI SATISI BLOKLAMAZ. Satis tamamlama transaction'i kuyruga bir kayit
 * yazar ve biter. Baski ayri bir worker tarafindan denenir; yazici kapali/kagitsizsa
 * is kuyrukta bekler ve yazici geldiginde otomatik basilir.
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import type { PrinterPort } from '../../hardware/ports.ts';
import type { EscPosOptions } from '../../hardware/printer/escpos.ts';
import type { ReceiptDocument, ReceiptKind } from './document.ts';
import { renderReceipt } from './render.ts';
import type { PrintQueuePort } from '../sales/sales.ts';
import type { AuditLog } from '../audit/audit.ts';

export type DocumentFactory = (saleId: number, kind: ReceiptKind) => ReceiptDocument;

export interface PrintQueueOptions {
  readonly retryDelaysMs: readonly number[];
  readonly maxAttempts: number;
  readonly pollIntervalMs?: number;
  readonly escPos: EscPosOptions;
}

export interface PrintJobSummary {
  readonly id: number;
  readonly kind: ReceiptKind;
  readonly saleId: number | null;
  readonly status: 'PENDING' | 'PRINTING' | 'DONE' | 'FAILED';
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
}

interface JobRow {
  id: number; kind: ReceiptKind; sale_id: number | null; document_json: string;
  status: 'PENDING' | 'PRINTING' | 'DONE' | 'FAILED'; attempts: number;
  next_attempt_at: number; last_error: string | null; created_at: number;
}

export class PrintQueue implements PrintQueuePort {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #printer: PrinterPort;
  readonly #options: PrintQueueOptions;
  readonly #audit: AuditLog | null;
  #documentFactory: DocumentFactory | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #processing = false;

  constructor(deps: {
    db: Db; clock: Clock; printer: PrinterPort; options: PrintQueueOptions; audit?: AuditLog;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#printer = deps.printer;
    this.#options = deps.options;
    this.#audit = deps.audit ?? null;
  }

  /** Dairesel bagimliligi kirmak icin belge ureteci sonradan baglanir */
  setDocumentFactory(factory: DocumentFactory): void {
    this.#documentFactory = factory;
  }

  // ------------------------------ Kuyruga alma ------------------------------

  enqueueReceipt(saleId: number, kind: 'RECEIPT' | 'REPRINT', requestedBy?: number): void {
    if (this.#documentFactory === null) {
      throw new Error('PrintQueue.setDocumentFactory cagrilmadi');
    }
    const doc = this.#documentFactory(saleId, kind);
    this.enqueueDocument(doc, { saleId, requestedBy });
  }

  enqueueDocument(
    doc: ReceiptDocument,
    context: { saleId?: number | null; requestedBy?: number | undefined } = {},
  ): number {
    const now = this.#clock.now();
    const { lastInsertRowid } = this.#db.run(
      `INSERT INTO print_jobs
         (kind, sale_id, document_json, status, attempts, next_attempt_at, requested_by, created_at)
       VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
      doc.kind, context.saleId ?? null, JSON.stringify(doc), now,
      context.requestedBy ?? null, now,
    );
    // Kuyruk calisiyorsa hemen bir tur tetikle (fis aninda ciksin)
    if (this.#running) queueMicrotask(() => void this.processDue());
    return lastInsertRowid;
  }

  // ------------------------------ Worker ------------------------------

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.recoverStuckJobs();
    const interval = this.#options.pollIntervalMs ?? 2000;
    this.#timer = setInterval(() => void this.processDue(), interval);
    this.#timer.unref?.();
    void this.processDue();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Cokme sonrasi PRINTING'de kalmis isler yeniden kuyruga alinir.
   * Fisin iki kez basilmasi, hic basilmamasindan iyidir.
   */
  recoverStuckJobs(): number {
    const changes = this.#db.run(
      `UPDATE print_jobs SET status = 'PENDING', next_attempt_at = ?,
              last_error = COALESCE(last_error, '') || ' [kurtarildi: surec kapanmis]'
        WHERE status = 'PRINTING'`,
      this.#clock.now(),
    ).changes;
    return changes;
  }

  async processDue(limit = 5): Promise<number> {
    if (this.#processing) return 0;
    this.#processing = true;
    let printed = 0;
    try {
      for (let i = 0; i < limit; i++) {
        const job = this.#claimNext();
        if (job === null) break;
        const ok = await this.#print(job);
        if (ok) printed++;
      }
    } finally {
      this.#processing = false;
    }
    return printed;
  }

  #claimNext(): JobRow | null {
    return this.#db.tx(() => {
      const job = this.#db.get<JobRow>(
        `SELECT * FROM print_jobs
          WHERE status = 'PENDING' AND next_attempt_at <= ?
          ORDER BY id LIMIT 1`,
        this.#clock.now(),
      );
      if (job === undefined) return null;
      this.#db.run("UPDATE print_jobs SET status = 'PRINTING' WHERE id = ?", job.id);
      return job;
    });
  }

  async #print(job: JobRow): Promise<boolean> {
    try {
      const doc = JSON.parse(job.document_json) as ReceiptDocument;
      const bytes = renderReceipt(doc, this.#options.escPos);
      await this.#printer.write(bytes);
      this.#db.run(
        "UPDATE print_jobs SET status = 'DONE', printed_at = ?, last_error = NULL WHERE id = ?",
        this.#clock.now(), job.id,
      );
      return true;
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = (error as Error).message.slice(0, 500);
      const delays = this.#options.retryDelaysMs;
      const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 60000;
      const failed = attempts >= this.#options.maxAttempts;
      this.#db.run(
        `UPDATE print_jobs SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
          WHERE id = ?`,
        failed ? 'FAILED' : 'PENDING', attempts, this.#clock.now() + delay, message, job.id,
      );
      if (failed && this.#audit !== null) {
        this.#db.tx(() => {
          this.#audit!.record({
            type: 'DEVICE_ERROR', entity: 'print_job', entityId: job.id,
            data: { error: message, attempts, saleId: job.sale_id },
          });
        });
      }
      return false;
    }
  }

  // ------------------------------ Sorgular ------------------------------

  pending(): PrintJobSummary[] {
    return this.#db
      .all<JobRow>(
        "SELECT * FROM print_jobs WHERE status IN ('PENDING','PRINTING','FAILED') ORDER BY id",
      )
      .map((j) => ({
        id: j.id, kind: j.kind, saleId: j.sale_id, status: j.status,
        attempts: j.attempts, lastError: j.last_error, createdAt: j.created_at,
      }));
  }

  pendingCount(): number {
    return this.#db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM print_jobs WHERE status IN ('PENDING','PRINTING')",
    )!.n;
  }

  failedCount(): number {
    return this.#db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'FAILED'",
    )!.n;
  }

  /** Basarisiz isleri yeniden dener (yazici duzeltildikten sonra) */
  retryFailed(): number {
    return this.#db.run(
      `UPDATE print_jobs SET status = 'PENDING', attempts = 0, next_attempt_at = ?
        WHERE status = 'FAILED'`,
      this.#clock.now(),
    ).changes;
  }

  /** Fisi yeniden bas (kopya damgali) */
  reprint(saleId: number, requestedBy: number): number {
    if (this.#documentFactory === null) throw new Error('Belge ureteci baglanmadi');
    const doc = this.#documentFactory(saleId, 'REPRINT');
    const id = this.#db.tx(() => {
      const jobId = this.enqueueDocument(doc, { saleId, requestedBy });
      this.#audit?.record({
        type: 'RECEIPT_REPRINTED', entity: 'sale', entityId: saleId, userId: requestedBy,
        data: { printJobId: jobId },
      });
      return jobId;
    });
    if (this.#running) void this.processDue();
    return id;
  }
}
