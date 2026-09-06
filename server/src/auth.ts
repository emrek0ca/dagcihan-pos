/**
 * Kimlik dogrulama ve yetkilendirme.
 *
 * Iki ayri aktor turu vardir ve YETKILERI AYRIDIR:
 *   TERMINAL : POS cihazi. Yalnizca senkronizasyon yapabilir. Yonetim uc
 *              noktalarina erisemez; baska magazanin verisini goremez.
 *   USER     : Insan kullanici. Rolune gore organizasyon/magaza kapsaminda yetkili.
 */
import type { Database, Queryable } from './db.ts';
import { forbidden, unauthorized } from './lib/errors.ts';
import { generateToken, hashToken, verifyPassword } from './lib/crypto.ts';

export type Permission =
  | 'catalog.read' | 'catalog.write' | 'price.write'
  | 'inventory.read' | 'inventory.write' | 'inventory.reserve'
  | 'sales.read' | 'sales.write' | 'refund.write'
  | 'cash.read' | 'cash.write' | 'reports.read'
  | 'orders.read' | 'orders.write'
  | 'users.manage' | 'devices.manage' | 'org.manage' | 'audit.read'
  | 'sync.push' | 'sync.pull';

export interface TerminalPrincipal {
  readonly kind: 'TERMINAL';
  readonly terminalId: string;
  readonly terminalCode: string;
  readonly storeId: string;
  readonly organizationId: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly tokenId: string;
}

export interface UserPrincipal {
  readonly kind: 'USER';
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
  /** Bos ise organizasyon genelinde yetkili */
  readonly storeIds: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
  readonly sessionId: string;
}

export type Principal = TerminalPrincipal | UserPrincipal;

// ------------------------------ token cozumleme ------------------------------

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!.trim();
}

async function permissionsFor(db: Queryable, roleCodes: readonly string[]): Promise<Set<Permission>> {
  if (roleCodes.length === 0) return new Set();
  const rows = await db.query<{ permission_code: Permission }>(
    'SELECT DISTINCT permission_code FROM role_permissions WHERE role_code = ANY($1)',
    [roleCodes as unknown as object],
  );
  return new Set(rows.map((r) => r.permission_code));
}

export async function authenticate(db: Database, token: string): Promise<Principal> {
  if (token.startsWith('pos_')) return authenticateTerminal(db, token);
  if (token.startsWith('usr_')) return authenticateUser(db, token);
  throw unauthorized('Tanimsiz token turu');
}

async function authenticateTerminal(db: Database, token: string): Promise<TerminalPrincipal> {
  const hash = hashToken(token);
  const row = await db.one<{
    token_id: string; terminal_id: string; terminal_code: string; store_id: string;
    organization_id: string; activation_state: string; revoked_at: Date | null;
    token_revoked_at: Date | null; expires_at: Date | null;
  }>(
    `SELECT tt.id AS token_id, t.id AS terminal_id, t.code AS terminal_code,
            t.store_id, s.organization_id, t.activation_state, t.revoked_at,
            tt.revoked_at AS token_revoked_at, tt.expires_at
       FROM terminal_tokens tt
       JOIN terminals t ON t.id = tt.terminal_id
       JOIN stores s ON s.id = t.store_id
      WHERE tt.token_hash = $1`,
    [hash],
  );
  if (row === undefined) throw unauthorized('Gecersiz cihaz token');
  if (row.token_revoked_at !== null) throw unauthorized('Cihaz token iptal edilmis');
  if (row.expires_at !== null && row.expires_at.getTime() < Date.now()) {
    throw unauthorized('Cihaz token suresi dolmus');
  }
  if (row.activation_state === 'REVOKED' || row.revoked_at !== null) {
    throw new (await import('./lib/errors.ts')).ApiError(
      'TERMINAL_REVOKED', 'Bu terminal iptal edilmis',
    );
  }
  if (row.activation_state !== 'ACTIVE') {
    throw new (await import('./lib/errors.ts')).ApiError(
      'TERMINAL_NOT_ACTIVE', 'Terminal aktif degil',
    );
  }

  const permissions = await permissionsFor(db, ['terminal']);
  // Son gorulme bilgisi kritik yolda degil; hata olsa bile istek surer.
  void db.exec('UPDATE terminal_tokens SET last_used_at = now() WHERE id = $1', [row.token_id])
    .catch(() => undefined);

  return {
    kind: 'TERMINAL',
    terminalId: row.terminal_id,
    terminalCode: row.terminal_code,
    storeId: row.store_id,
    organizationId: row.organization_id,
    permissions,
    tokenId: row.token_id,
  };
}

async function authenticateUser(db: Database, token: string): Promise<UserPrincipal> {
  const hash = hashToken(token);
  const row = await db.one<{
    session_id: string; user_id: string; email: string; display_name: string;
    organization_id: string; status: string; expires_at: Date; revoked_at: Date | null;
  }>(
    `SELECT us.id AS session_id, u.id AS user_id, u.email, u.display_name,
            u.organization_id, u.status, us.expires_at, us.revoked_at
       FROM user_sessions us JOIN users u ON u.id = us.user_id
      WHERE us.token_hash = $1`,
    [hash],
  );
  if (row === undefined) throw unauthorized('Gecersiz oturum');
  if (row.revoked_at !== null) throw unauthorized('Oturum sonlandirilmis');
  if (row.expires_at.getTime() < Date.now()) throw unauthorized('Oturum suresi dolmus');
  if (row.status !== 'ACTIVE') throw unauthorized('Kullanici pasif');

  const roleRows = await db.query<{ role_code: string; store_id: string | null }>(
    'SELECT role_code, store_id FROM user_roles WHERE user_id = $1', [row.user_id],
  );
  const roles = [...new Set(roleRows.map((r) => r.role_code))];
  const storeIds = roleRows.map((r) => r.store_id).filter((s): s is string => s !== null);
  const permissions = await permissionsFor(db, roles);

  return {
    kind: 'USER',
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    organizationId: row.organization_id,
    roles,
    // Herhangi bir rol organizasyon genelindeyse magaza kisiti yoktur
    storeIds: roleRows.some((r) => r.store_id === null) ? [] : [...new Set(storeIds)],
    permissions,
    sessionId: row.session_id,
  };
}

// ------------------------------ yetki kontrolleri ------------------------------

export function requirePermission(principal: Principal, permission: Permission): void {
  if (!principal.permissions.has(permission)) {
    throw forbidden(`Yetki gerekli: ${permission}`);
  }
}

/** Kapsam kontrolu: aktor bu magazaya erisebilir mi */
export function requireStoreScope(principal: Principal, storeId: string): void {
  if (principal.kind === 'TERMINAL') {
    if (principal.storeId !== storeId) {
      throw forbidden('Terminal yalnizca kendi magazasinin verisine erisebilir');
    }
    return;
  }
  if (principal.storeIds.length > 0 && !principal.storeIds.includes(storeId)) {
    throw forbidden('Bu magaza icin yetkiniz yok');
  }
}

export function requireOrganizationScope(principal: Principal, organizationId: string): void {
  if (principal.organizationId !== organizationId) {
    throw forbidden('Bu organizasyon icin yetkiniz yok');
  }
}

// ------------------------------ oturum acma ------------------------------

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: Date;
  readonly user: { id: string; email: string; displayName: string; roles: string[] };
}

export async function loginUser(
  db: Database,
  input: { email: string; password: string; ttlHours: number; ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const user = await db.one<{
    id: string; email: string; display_name: string; password_hash: string;
    password_salt: string; status: string;
  }>('SELECT * FROM users WHERE lower(email) = lower($1)', [input.email]);

  // Kullanici yoksa da ayni maliyette dogrulama yapilir (kullanici sayimi zorlastirilir)
  const ok = user !== undefined
    && user.status === 'ACTIVE'
    && verifyPassword(input.password, user.password_hash, user.password_salt);
  if (!ok || user === undefined) throw unauthorized('E-posta veya parola hatali');

  const token = generateToken('usr');
  const expiresAt = new Date(Date.now() + input.ttlHours * 3600_000);
  await db.exec(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, token.hash, expiresAt, input.ip ?? null, input.userAgent ?? null],
  );
  await db.exec('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  const roles = await db.query<{ role_code: string }>(
    'SELECT DISTINCT role_code FROM user_roles WHERE user_id = $1', [user.id],
  );
  return {
    token: token.plaintext,
    expiresAt,
    user: {
      id: user.id, email: user.email, displayName: user.display_name,
      roles: roles.map((r) => r.role_code),
    },
  };
}

export async function logoutUser(db: Database, principal: Principal): Promise<void> {
  if (principal.kind !== 'USER') return;
  await db.exec('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [principal.sessionId]);
}
