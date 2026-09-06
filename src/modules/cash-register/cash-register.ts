/**
 * Kasa oturumu: acilis devri, gun ici hareketler, sayim ve kapanis (Z).
 * Bir terminalde ayni anda tek acik oturum olur (DB'de partial unique index).
 */
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import { PosError } from '../../core/errors.ts';
import { money, type Money } from '../../core/money/money.ts';
import type { AuditLog } from '../audit/audit.ts';
import { NULL_OUTBOX, type OutboxPort } from '../sync/outbox.ts';

export type CashMovementType = 'OPENING' | 'SALE' | 'REFUND' | 'PAID_IN' | 'PAID_OUT' | 'CLOSING';

export interface CashSession {
  readonly id: number;
  readonly terminalId: number;
  readonly status: 'OPEN' | 'CLOSED';
  readonly businessDate: string;
  readonly openedBy: number;
  readonly openedAt: number;
  readonly openingFloat: Money;
  readonly closedBy: number | null;
  readonly closedAt: number | null;
  readonly countedCash: Money | null;
  readonly expectedCash: Money | null;
  readonly variance: Money | null;
}

export interface SessionSummary {
  readonly session: CashSession;
  readonly salesCount: number;
  readonly salesTotal: Money;
  readonly refundCount: number;
  readonly refundTotal: Money;
  readonly cashSales: Money;
  readonly cardSales: Money;
  readonly cashRefunds: Money;
  readonly paidIn: Money;
  readonly paidOut: Money;
  readonly expectedCash: Money;
  readonly taxBreakdown: readonly { rateBp: number; net: Money; tax: Money }[];
  readonly discountTotal: Money;
  readonly voidedSales: number;
}

interface SessionRow {
  id: number; terminal_id: number; status: 'OPEN' | 'CLOSED'; business_date: string;
  opened_by: number; opened_at: number; opening_float: number;
  closed_by: number | null; closed_at: number | null;
  counted_cash: number | null; expected_cash: number | null; variance: number | null;
}

function toSession(row: SessionRow): CashSession {
  return {
    id: row.id,
    terminalId: row.terminal_id,
    status: row.status,
    businessDate: row.business_date,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    openingFloat: money(row.opening_float),
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    countedCash: row.counted_cash === null ? null : money(row.counted_cash),
    expectedCash: row.expected_cash === null ? null : money(row.expected_cash),
    variance: row.variance === null ? null : money(row.variance),
  };
}

export class CashRegisterService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #audit: AuditLog;
  readonly #outbox: OutboxPort;

  constructor(db: Db, clock: Clock, audit: AuditLog, outbox: OutboxPort = NULL_OUTBOX) {
    this.#db = db;
    this.#clock = clock;
    this.#audit = audit;
    this.#outbox = outbox;
  }

  current(terminalId: number): CashSession | undefined {
    const row = this.#db.get<SessionRow>(
      "SELECT * FROM cash_sessions WHERE terminal_id = ? AND status = 'OPEN'", terminalId,
    );
    return row === undefined ? undefined : toSession(row);
  }

  requireOpen(terminalId: number): CashSession {
    const session = this.current(terminalId);
    if (session === undefined) {
      throw new PosError('CASH_SESSION_NOT_OPEN', `Terminal ${terminalId} icin acik kasa yok`);
    }
    return session;
  }

  open(input: { terminalId: number; userId: number; openingFloat: Money; note?: string }): CashSession {
    return this.#db.tx(() => {
      if (this.current(input.terminalId) !== undefined) {
        throw new PosError('CASH_SESSION_ALREADY_OPEN', 'Bu kasada zaten acik oturum var', {
          userMessage: 'Kasa zaten acik.',
        });
      }
      const now = this.#clock.now();
      const { lastInsertRowid: id } = this.#db.run(
        `INSERT INTO cash_sessions
           (terminal_id, status, business_date, opened_by, opened_at, opening_float, note)
         VALUES (?, 'OPEN', ?, ?, ?, ?, ?)`,
        input.terminalId, this.#clock.businessDate(now), input.userId, now,
        input.openingFloat, input.note ?? null,
      );
      this.#db.run(
        `INSERT INTO cash_movements (cash_session_id, type, amount, user_id, note, at)
         VALUES (?, 'OPENING', ?, ?, ?, ?)`,
        id, input.openingFloat, input.userId, 'Kasa acilis devri', now,
      );
      this.#audit.record({
        type: 'CASH_SESSION_OPENED', entity: 'cash_session', entityId: id,
        userId: input.userId, terminalId: input.terminalId,
        data: { openingFloat: input.openingFloat },
      });
      this.#outbox.record({
        type: 'cash_session.opened',
        entityType: 'cash_session',
        entityId: id,
        payload: {
          localId: id,
          businessDate: this.#clock.businessDate(now),
          openedAt: new Date(now).toISOString(),
          openingFloat: input.openingFloat,
          openedBy: this.#db.get<{ display_name: string }>(
            'SELECT display_name FROM users WHERE id = ?', input.userId,
          )?.display_name ?? null,
        },
      });
      return toSession(this.#db.get<SessionRow>('SELECT * FROM cash_sessions WHERE id = ?', id)!);
    });
  }

  /** Elle kasa girisi/cikisi (tedarikci odemesi, bozuk para takviyesi vb.) */
  movement(input: {
    sessionId: number; type: 'PAID_IN' | 'PAID_OUT'; amount: Money; userId: number; note: string;
  }): void {
    if (input.amount <= 0) {
      throw new PosError('PAYMENT_INVALID', 'Kasa hareketi tutari pozitif olmali');
    }
    this.#db.tx(() => {
      const session = this.#db.get<SessionRow>(
        'SELECT * FROM cash_sessions WHERE id = ?', input.sessionId,
      );
      if (session === undefined || session.status !== 'OPEN') {
        throw new PosError('CASH_SESSION_NOT_OPEN', 'Kasa oturumu acik degil');
      }
      const signed = input.type === 'PAID_IN' ? input.amount : -input.amount;
      this.#db.run(
        `INSERT INTO cash_movements (cash_session_id, type, amount, user_id, note, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.sessionId, input.type, signed, input.userId, input.note, this.#clock.now(),
      );
      this.#audit.record({
        type: input.type === 'PAID_IN' ? 'CASH_PAID_IN' : 'CASH_PAID_OUT',
        entity: 'cash_session', entityId: input.sessionId, userId: input.userId,
        data: { amount: input.amount, note: input.note },
      });
      this.#outbox.record({
        type: 'cash.movement',
        entityType: 'cash_session',
        entityId: input.sessionId,
        payload: {
          localSessionId: input.sessionId, type: input.type,
          amount: signed, note: input.note,
        },
      });
    });
  }

  summary(sessionId: number): SessionSummary {
    const row = this.#db.get<SessionRow>('SELECT * FROM cash_sessions WHERE id = ?', sessionId);
    if (row === undefined) {
      throw new PosError('CASH_SESSION_NOT_OPEN', `Kasa oturumu bulunamadi: ${sessionId}`);
    }

    const totals = this.#db.get<{
      sales_count: number; sales_total: number; refund_count: number; refund_total: number;
      discount_total: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN doc_type = 'SALE' THEN 1 ELSE 0 END), 0)      AS sales_count,
         COALESCE(SUM(CASE WHEN doc_type = 'SALE' THEN total ELSE 0 END), 0)  AS sales_total,
         COALESCE(SUM(CASE WHEN doc_type = 'REFUND' THEN 1 ELSE 0 END), 0)    AS refund_count,
         COALESCE(SUM(CASE WHEN doc_type = 'REFUND' THEN total ELSE 0 END), 0) AS refund_total,
         COALESCE(SUM(discount_total), 0)                                     AS discount_total
       FROM sales WHERE cash_session_id = ? AND status = 'COMPLETED'`,
      sessionId,
    )!;

    const byMethod = this.#db.all<{ method: string; doc_type: string; total: number }>(
      `SELECT p.method, s.doc_type, COALESCE(SUM(p.amount), 0) AS total
         FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.cash_session_id = ? AND s.status = 'COMPLETED'
        GROUP BY p.method, s.doc_type`,
      sessionId,
    );
    const pick = (method: string, docType: string): Money =>
      money(byMethod.find((m) => m.method === method && m.doc_type === docType)?.total ?? 0);

    const manual = this.#db.get<{ paid_in: number; paid_out: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'PAID_IN' THEN amount ELSE 0 END), 0) AS paid_in,
         COALESCE(SUM(CASE WHEN type = 'PAID_OUT' THEN amount ELSE 0 END), 0) AS paid_out
       FROM cash_movements WHERE cash_session_id = ?`,
      sessionId,
    )!;

    const taxRows = this.#db.all<{ tax_rate_bp: number; net: number; tax: number }>(
      `SELECT i.tax_rate_bp,
              COALESCE(SUM(CASE WHEN s.doc_type = 'SALE' THEN i.net_amount ELSE -i.net_amount END), 0) AS net,
              COALESCE(SUM(CASE WHEN s.doc_type = 'SALE' THEN i.tax_amount ELSE -i.tax_amount END), 0) AS tax
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.cash_session_id = ? AND s.status = 'COMPLETED' AND i.voided_at IS NULL
        GROUP BY i.tax_rate_bp ORDER BY i.tax_rate_bp`,
      sessionId,
    );

    const voided = this.#db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sales WHERE cash_session_id = ? AND status = 'VOIDED'",
      sessionId,
    )!.n;

    const cashSales = pick('CASH', 'SALE');
    const cashRefunds = pick('CASH', 'REFUND');
    const expectedCash = money(
      row.opening_float + cashSales - cashRefunds + manual.paid_in + manual.paid_out,
    );

    return {
      session: toSession(row),
      salesCount: totals.sales_count,
      salesTotal: money(totals.sales_total),
      refundCount: totals.refund_count,
      refundTotal: money(totals.refund_total),
      cashSales,
      cardSales: pick('CARD', 'SALE'),
      cashRefunds,
      paidIn: money(manual.paid_in),
      paidOut: money(manual.paid_out),
      expectedCash,
      taxBreakdown: taxRows.map((t) => ({
        rateBp: t.tax_rate_bp, net: money(t.net), tax: money(t.tax),
      })),
      discountTotal: money(totals.discount_total),
      voidedSales: voided,
    };
  }

  close(input: {
    sessionId: number; userId: number; countedCash: Money; note?: string;
  }): SessionSummary {
    return this.#db.tx(() => {
      const summary = this.summary(input.sessionId);
      if (summary.session.status !== 'OPEN') {
        throw new PosError('CASH_SESSION_NOT_OPEN', 'Kasa zaten kapali');
      }
      const open = this.#db.get<{ id: number }>(
        "SELECT id FROM sales WHERE cash_session_id = ? AND status IN ('OPEN','PARKED')",
        input.sessionId,
      );
      if (open !== undefined) {
        throw new PosError('SALE_NOT_OPEN',
          'Kasa kapatilamaz: acik veya askida fis var', {
            userMessage: 'Once acik/askidaki fisleri tamamlayin veya iptal edin.',
          });
      }

      const now = this.#clock.now();
      const variance = money(input.countedCash - summary.expectedCash);
      this.#db.run(
        `UPDATE cash_sessions
            SET status = 'CLOSED', closed_by = ?, closed_at = ?, counted_cash = ?,
                expected_cash = ?, variance = ?, note = COALESCE(?, note)
          WHERE id = ?`,
        input.userId, now, input.countedCash, summary.expectedCash, variance,
        input.note ?? null, input.sessionId,
      );
      this.#db.run(
        `INSERT INTO cash_movements (cash_session_id, type, amount, user_id, note, at)
         VALUES (?, 'CLOSING', ?, ?, ?, ?)`,
        input.sessionId, 0, input.userId, `Sayim: ${input.countedCash}, fark: ${variance}`, now,
      );
      this.#audit.record({
        type: 'CASH_SESSION_CLOSED', entity: 'cash_session', entityId: input.sessionId,
        userId: input.userId, terminalId: summary.session.terminalId,
        data: {
          countedCash: input.countedCash, expectedCash: summary.expectedCash, variance,
          salesTotal: summary.salesTotal, salesCount: summary.salesCount,
        },
      });
      this.#outbox.record({
        type: 'cash_session.closed',
        entityType: 'cash_session',
        entityId: input.sessionId,
        payload: {
          localId: input.sessionId,
          businessDate: summary.session.businessDate,
          openedAt: new Date(summary.session.openedAt).toISOString(),
          openingFloat: summary.session.openingFloat,
          closedAt: new Date(now).toISOString(),
          closedBy: this.#db.get<{ display_name: string }>(
            'SELECT display_name FROM users WHERE id = ?', input.userId,
          )?.display_name ?? null,
          countedCash: input.countedCash,
          expectedCash: summary.expectedCash,
          variance,
        },
      });
      return this.summary(input.sessionId);
    });
  }

  history(terminalId: number, limit = 30): CashSession[] {
    return this.#db
      .all<SessionRow>(
        'SELECT * FROM cash_sessions WHERE terminal_id = ? ORDER BY opened_at DESC LIMIT ?',
        terminalId, limit,
      )
      .map(toSession);
  }
}
