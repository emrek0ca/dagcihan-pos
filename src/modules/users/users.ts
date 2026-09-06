/**
 * Kasiyer/kullanici yonetimi ve yetkilendirme.
 * PIN'ler scrypt ile tuzlanarak saklanir; duz metin PIN hicbir yerde tutulmaz.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../data/db.ts';
import type { Clock } from '../../core/clock.ts';
import { PosError } from '../../core/errors.ts';
import type { AuditLog } from '../audit/audit.ts';
import { NULL_OUTBOX, type OutboxPort } from '../sync/outbox.ts';

export type Role = 'CASHIER' | 'MANAGER' | 'ADMIN';

export interface User {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly active: boolean;
}

export type Permission =
  | 'SALE_CREATE'
  | 'LINE_VOID'
  | 'SALE_VOID'
  | 'DISCOUNT_APPLY'
  | 'DISCOUNT_OVER_LIMIT'
  | 'PRICE_OVERRIDE'
  | 'REFUND'
  | 'CASH_SESSION_OPEN'
  | 'CASH_SESSION_CLOSE'
  | 'CASH_PAID_IN_OUT'
  | 'PRODUCT_MANAGE'
  | 'STOCK_ADJUST'
  | 'REPORT_VIEW'
  | 'REPORT_Z'
  | 'USER_MANAGE'
  | 'SETTINGS_MANAGE'
  | 'RECEIPT_REPRINT';

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  CASHIER: [
    'SALE_CREATE', 'LINE_VOID', 'DISCOUNT_APPLY', 'CASH_SESSION_OPEN',
    'RECEIPT_REPRINT', 'REPORT_VIEW',
  ],
  MANAGER: [
    'SALE_CREATE', 'LINE_VOID', 'SALE_VOID', 'DISCOUNT_APPLY', 'DISCOUNT_OVER_LIMIT',
    'PRICE_OVERRIDE', 'REFUND', 'CASH_SESSION_OPEN', 'CASH_SESSION_CLOSE',
    'CASH_PAID_IN_OUT', 'PRODUCT_MANAGE', 'STOCK_ADJUST', 'REPORT_VIEW', 'REPORT_Z',
    'RECEIPT_REPRINT',
  ],
  ADMIN: [
    'SALE_CREATE', 'LINE_VOID', 'SALE_VOID', 'DISCOUNT_APPLY', 'DISCOUNT_OVER_LIMIT',
    'PRICE_OVERRIDE', 'REFUND', 'CASH_SESSION_OPEN', 'CASH_SESSION_CLOSE',
    'CASH_PAID_IN_OUT', 'PRODUCT_MANAGE', 'STOCK_ADJUST', 'REPORT_VIEW', 'REPORT_Z',
    'USER_MANAGE', 'SETTINGS_MANAGE', 'RECEIPT_REPRINT',
  ],
};

export function permissionsOf(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function requirePermission(user: User, permission: Permission): void {
  if (!user.active) {
    throw new PosError('UNAUTHORIZED', `Kullanici pasif: ${user.username}`);
  }
  if (!hasPermission(user.role, permission)) {
    throw new PosError('UNAUTHORIZED', `${user.username} icin yetki yok: ${permission}`, {
      details: { permission, role: user.role },
    });
  }
}

const SCRYPT_KEYLEN = 64;

export function hashPin(pin: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? randomBytes(16).toString('hex');
  const hash = scryptSync(pin, s, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt: s };
}

export function verifyPin(pin: string, hash: string, salt: string): boolean {
  const computed = scryptSync(pin, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(computed, stored);
}

interface UserRow {
  id: number; username: string; display_name: string;
  pin_hash: string; pin_salt: string; role: Role; active: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: row.active === 1,
  };
}

export class UserService {
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

  create(input: {
    username: string; displayName: string; pin: string; role: Role;
  }): User {
    if (input.pin.length < 4) {
      throw new PosError('INVALID_CREDENTIALS', 'PIN en az 4 haneli olmali', {
        userMessage: 'PIN en az 4 haneli olmali.',
      });
    }
    const { hash, salt } = hashPin(input.pin);
    const now = this.#clock.now();
    return this.#db.tx(() => {
      const existing = this.#db.get<UserRow>(
        'SELECT * FROM users WHERE username = ?', input.username,
      );
      if (existing !== undefined) {
        throw new PosError('INVALID_CREDENTIALS', `Kullanici zaten var: ${input.username}`, {
          userMessage: 'Bu kullanici adi kullaniliyor.',
        });
      }
      const { lastInsertRowid } = this.#db.run(
        `INSERT INTO users (username, display_name, pin_hash, pin_salt, role, active,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        input.username, input.displayName, hash, salt, input.role, now, now,
      );
      this.#audit.record({
        type: 'USER_CREATED',
        entity: 'user',
        entityId: lastInsertRowid,
        data: { username: input.username, role: input.role },
      });
      this.#outbox.record({
        type: 'cashier.upserted',
        entityType: 'user',
        entityId: lastInsertRowid,
        payload: {
          localUserId: lastInsertRowid, username: input.username,
          displayName: input.displayName, role: input.role, active: true,
        },
      });
      return {
        id: lastInsertRowid,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        active: true,
      };
    });
  }

  login(username: string, pin: string, terminalId?: number): User {
    const row = this.#db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    const ok = row !== undefined && row.active === 1 && verifyPin(pin, row.pin_hash, row.pin_salt);
    if (!ok) {
      this.#db.tx(() => {
        this.#audit.record({
          type: 'USER_LOGIN_FAILED',
          ...(terminalId !== undefined ? { terminalId } : {}),
          entity: 'user',
          data: { username },
        });
      });
      throw new PosError('INVALID_CREDENTIALS', `Giris basarisiz: ${username}`);
    }
    const user = toUser(row);
    this.#db.tx(() => {
      this.#audit.record({
        type: 'USER_LOGIN',
        userId: user.id,
        ...(terminalId !== undefined ? { terminalId } : {}),
        entity: 'user',
        entityId: user.id,
        data: { username },
      });
    });
    return user;
  }

  byId(id: number): User {
    const row = this.#db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (row === undefined) throw new PosError('UNAUTHORIZED', `Kullanici bulunamadi: ${id}`);
    return toUser(row);
  }

  byUsername(username: string): User | undefined {
    const row = this.#db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    return row === undefined ? undefined : toUser(row);
  }

  list(): User[] {
    return this.#db
      .all<UserRow>('SELECT * FROM users ORDER BY username')
      .map(toUser);
  }

  setActive(id: number, active: boolean): void {
    this.#db.tx(() => {
      this.#db.run(
        'UPDATE users SET active = ?, updated_at = ? WHERE id = ?',
        active ? 1 : 0, this.#clock.now(), id,
      );
      this.#audit.record({
        type: 'USER_UPDATED', entity: 'user', entityId: id, data: { active },
      });
    });
  }

  changePin(id: number, newPin: string): void {
    if (newPin.length < 4) {
      throw new PosError('INVALID_CREDENTIALS', 'PIN en az 4 haneli olmali');
    }
    const { hash, salt } = hashPin(newPin);
    this.#db.tx(() => {
      this.#db.run(
        'UPDATE users SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = ?',
        hash, salt, this.#clock.now(), id,
      );
      this.#audit.record({ type: 'USER_UPDATED', entity: 'user', entityId: id, data: { pin: 'changed' } });
    });
  }

  /**
   * Yonetici onayi. Kasiyerin yetkisi yetmeyen islemlerde yonetici PIN'i ile
   * anlik yetkilendirme saglar; onay veren kullanici denetime yazilir.
   */
  approve(username: string, pin: string, permission: Permission): User {
    const approver = this.login(username, pin);
    requirePermission(approver, permission);
    return approver;
  }
}
