/**
 * API v1 uc noktalari.
 *
 * Kural: KONTROLSUZ genel CRUD YOKTUR. Her uc nokta acikca yetki ve
 * organizasyon/magaza kapsami ister. Terminal token'i yonetim uclarina erisemez.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './db.ts';
import type { HttpServer, RequestContext } from './http.ts';
import type { ServerConfig } from './lib/config.ts';
import { badRequest, conflict, forbidden, notFound, unauthorized, validation } from './lib/errors.ts';
import { generateEnrollmentCode, generateToken, hashToken, hashPassword } from './lib/crypto.ts';
import {
  loginUser, logoutUser, requirePermission, requireStoreScope, requirePlatformAdmin,
  type Principal, type TerminalPrincipal, type UserPrincipal,
} from './auth.ts';
import { processEvents, validateEvent } from './sync.ts';

function asUser(principal: Principal | null): UserPrincipal {
  if (principal === null || principal.kind !== 'USER') {
    throw forbidden('Bu islem icin kullanici oturumu gerekir');
  }
  return principal;
}

function requirePlatformAdminUser(principal: Principal | null): UserPrincipal {
  const user = asUser(principal);
  requirePlatformAdmin(user);
  return user;
}

function asTerminal(principal: Principal | null): TerminalPrincipal {
  if (principal === null || principal.kind !== 'TERMINAL') {
    throw forbidden('Bu islem icin cihaz token gerekir');
  }
  return principal;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validation(`${field} zorunlu`, { field });
  }
  return value.trim();
}

function optional(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function intOf(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw validation(`${field} zorunlu`, { field });
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw validation(`${field} tam sayi olmali`, { field });
  return n;
}

function limitOf(context: RequestContext, fallback: number, max: number): number {
  const raw = context.query.get('limit');
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw validation('limit gecersiz');
  return Math.min(value, max);
}

export function registerRoutes(server: HttpServer, db: Database, config: ServerConfig): void {
  // ============================ saglik ============================

  server.route('GET', '/health', () => ({ status: 'ok', service: 'dagci-pos-platform' }),
    { auth: false, rateLimit: 6000 });

  server.route('GET', '/ready', async ({ res }) => {
    const dbOk = await db.healthy();
    const migration = dbOk
      ? await db.one<{ version: string }>(
          'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
      : undefined;
    if (!dbOk) {
      res.statusCode = 503;
      return { status: 'degraded', database: false };
    }
    return { status: 'ready', database: true, schemaVersion: migration?.version ?? null };
  }, { auth: false, rateLimit: 6000 });

  // ============================ /auth ============================

  server.route('POST', '/api/v1/auth/login', async (context) => {
    const result = await loginUser(db, {
      email: str(context.body.email, 'email'),
      password: str(context.body.password, 'password'),
      ttlHours: config.sessionTtlHours,
      ip: context.ip,
      ...(typeof context.req.headers['user-agent'] === 'string'
        ? { userAgent: context.req.headers['user-agent'] } : {}),
    });
    context.log.info('kullanici girisi', { email: result.user.email });
    return { token: result.token, expiresAt: result.expiresAt, user: result.user };
  }, { auth: false, rateLimit: 20 });

  server.route('POST', '/api/v1/auth/logout', async (context) => {
    await logoutUser(db, context.principal!);
    return { ok: true };
  });

  server.route('GET', '/api/v1/auth/me', (context) => {
    const principal = context.principal!;
    return principal.kind === 'USER'
      ? {
          kind: 'USER', id: principal.userId, email: principal.email,
          displayName: principal.displayName, roles: principal.roles,
          organizationId: principal.organizationId, storeIds: principal.storeIds,
          permissions: [...principal.permissions],
        }
      : {
          kind: 'TERMINAL', id: principal.terminalId, code: principal.terminalCode,
          storeId: principal.storeId, organizationId: principal.organizationId,
          permissions: [...principal.permissions],
        };
  });

  // ============================ /devices ============================

  /** Terminal kaydi olustur + tek kullanimlik aktivasyon kodu uret */
  server.route('POST', '/api/v1/devices', async (context) => {
    const user = asUser(context.principal);
    requirePermission(user, 'devices.manage');
    const storeId = str(context.body.storeId, 'storeId');
    requireStoreScope(user, storeId);

    const store = await db.one<{ organization_id: string }>(
      'SELECT organization_id FROM stores WHERE id = $1', [storeId]);
    if (store === undefined) throw notFound('Magaza bulunamadi');
    if (store.organization_id !== user.organizationId) throw forbidden('Kapsam disi magaza');

    const code = str(context.body.code, 'code');
    const enrollment = generateEnrollmentCode();
    const expiresAt = new Date(Date.now() + 24 * 3600_000);

    const result = await db.tx(async (tx) => {
      const terminal = await tx.one<{ id: string }>(
        `INSERT INTO terminals (store_id, code, name, activation_state)
         VALUES ($1,$2,$3,'PENDING')
         ON CONFLICT (store_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [storeId, code, str(context.body.name, 'name')],
      );
      await tx.exec(
        `INSERT INTO enrollment_codes (store_id, code_hash, code_prefix, terminal_code,
                                       expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [storeId, enrollment.hash, enrollment.prefix, code, expiresAt, user.userId],
      );
      await tx.exec(
        `INSERT INTO audit_log (organization_id, store_id, terminal_id, actor_type, actor_id,
                                actor_name, action, entity_type, entity_id, after_state, request_id)
         VALUES ($1,$2,$3,'USER',$4::text,$5,'terminal.enrollment_created','terminal',$6::text,$7,$8)`,
        [
          user.organizationId, storeId, terminal!.id, user.userId, user.displayName,
          terminal!.id, JSON.stringify({ code, expiresAt }), context.requestId,
        ],
      );
      return terminal!.id;
    });

    // Aktivasyon kodu YALNIZCA burada duz metin doner; veritabaninda ozeti saklanir.
    return { terminalId: result, enrollmentCode: enrollment.plaintext, expiresAt };
  });

  /** POS cihazi kendini kaydeder: kod -> kalici cihaz token'i */
  server.route('POST', '/api/v1/devices/enroll', async (context) => {
    const code = str(context.body.enrollmentCode, 'enrollmentCode').toUpperCase();
    const hash = hashToken(code);
    const row = await db.one<{
      id: string; store_id: string; terminal_code: string | null;
      expires_at: Date; used_at: Date | null;
    }>('SELECT * FROM enrollment_codes WHERE code_hash = $1', [hash]);

    if (row === undefined) throw unauthorized('Aktivasyon kodu gecersiz');
    if (row.used_at !== null) throw conflict('Aktivasyon kodu daha once kullanilmis');
    if (row.expires_at.getTime() < Date.now()) throw unauthorized('Aktivasyon kodunun suresi dolmus');

    const terminalCode = optional(context.body.terminalCode) ?? row.terminal_code;
    if (terminalCode === null) throw validation('terminalCode zorunlu');

    const token = generateToken('pos');
    const expiresAt = config.deviceTokenTtlDays === null
      ? null
      : new Date(Date.now() + config.deviceTokenTtlDays * 86_400_000);

    const result = await db.tx(async (tx) => {
      const terminal = await tx.one<{ id: string; activation_state: string }>(
        `INSERT INTO terminals (store_id, code, name, activation_state, activated_at, app_version, os_info)
         VALUES ($1,$2,$3,'ACTIVE',now(),$4,$5)
         ON CONFLICT (store_id, code) DO UPDATE SET
           activation_state = 'ACTIVE', activated_at = now(),
           revoked_at = NULL, revoked_reason = NULL,
           app_version = EXCLUDED.app_version, os_info = EXCLUDED.os_info
         RETURNING id, activation_state`,
        [
          row.store_id, terminalCode, optional(context.body.name) ?? terminalCode,
          optional(context.body.appVersion), optional(context.body.osInfo),
        ],
      );
      await tx.exec(
        `INSERT INTO terminal_tokens (terminal_id, token_prefix, token_hash, expires_at)
         VALUES ($1,$2,$3,$4)`,
        [terminal!.id, token.prefix, token.hash, expiresAt],
      );
      await tx.exec(
        'UPDATE enrollment_codes SET used_at = now(), used_by = $2 WHERE id = $1',
        [row.id, terminal!.id],
      );
      await tx.exec(
        `INSERT INTO device_sync_state (terminal_id) VALUES ($1)
         ON CONFLICT (terminal_id) DO NOTHING`, [terminal!.id]);
      const store = await tx.one<{ organization_id: string; name: string; code: string }>(
        'SELECT organization_id, name, code FROM stores WHERE id = $1', [row.store_id]);
      await tx.exec(
        `INSERT INTO audit_log (organization_id, store_id, terminal_id, actor_type, actor_id,
                                action, entity_type, entity_id, after_state, request_id, ip)
         VALUES ($1,$2,$3::uuid,'TERMINAL',$3,'terminal.activated','terminal',$3,$4,$5,$6)`,
        [
          store!.organization_id, row.store_id, terminal!.id,
          JSON.stringify({ terminalCode }), context.requestId, context.ip,
        ],
      );
      return { terminalId: terminal!.id, store };
    });

    context.log.info('terminal aktive edildi', { terminalId: result.terminalId });
    return {
      token: token.plaintext,
      terminalId: result.terminalId,
      storeId: row.store_id,
      storeName: result.store!.name,
      storeCode: result.store!.code,
      organizationId: result.store!.organization_id,
      expiresAt,
    };
  }, { auth: false, rateLimit: 30 });

  server.route('GET', '/api/v1/devices', async (context) => {
    const user = asUser(context.principal);
    requirePermission(user, 'devices.manage');
    return db.query(
      `SELECT t.id, t.code, t.name, t.activation_state, t.activated_at, t.revoked_at,
              t.last_seen_at, t.app_version, s.code AS store_code, s.id AS store_id,
              ds.last_local_sequence, ds.last_push_at, ds.last_pull_at, ds.last_pull_cursor
         FROM terminals t
         JOIN stores s ON s.id = t.store_id
         LEFT JOIN device_sync_state ds ON ds.terminal_id = t.id
        WHERE s.organization_id = $1
        ORDER BY s.code, t.code`,
      [user.organizationId],
    );
  });

  server.route('POST', '/api/v1/devices/:id/revoke', async (context) => {
    const user = asUser(context.principal);
    requirePermission(user, 'devices.manage');
    const id = str(context.params.id, 'id');
    const terminal = await db.one<{ store_id: string; organization_id: string }>(
      `SELECT t.store_id, s.organization_id FROM terminals t JOIN stores s ON s.id = t.store_id
        WHERE t.id = $1`, [id]);
    if (terminal === undefined) throw notFound('Terminal bulunamadi');
    requireStoreScope(user, terminal.store_id);

    await db.tx(async (tx) => {
      await tx.exec(
        `UPDATE terminals SET activation_state='REVOKED', revoked_at=now(), revoked_reason=$2
          WHERE id=$1`, [id, optional(context.body.reason)]);
      await tx.exec(
        'UPDATE terminal_tokens SET revoked_at = now() WHERE terminal_id = $1 AND revoked_at IS NULL',
        [id]);
      await tx.exec(
        `INSERT INTO audit_log (organization_id, store_id, terminal_id, actor_type, actor_id,
                                actor_name, action, entity_type, entity_id, after_state, request_id)
         VALUES ($1,$2,$3::uuid,'USER',$4,$5,'terminal.revoked','terminal',$3,$6,$7)`,
        [
          terminal.organization_id, terminal.store_id, id, user.userId, user.displayName,
          JSON.stringify({ reason: optional(context.body.reason) }), context.requestId,
        ]);
    });
    context.log.warn('terminal iptal edildi', { terminalId: id });
    return { ok: true };
  });


  // ============================ /platform ============================
  //
  // Bayi (satici) uc noktalari. HER MUSTERI KENDI ORGANIZASYONUDUR: urun
  // katalogu, fiyat, stok ve satis verisi organizasyon bazinda yalitilmistir,
  // bu yuzden musteriler birbirinin verisini goremez. Organizasyonlar arasi
  // islem yapan tek yer burasidir ve yalnizca is_platform_admin acar.

  /** Musteri listesi: organizasyon + magaza + terminal ozeti */
  server.route('GET', '/api/v1/platform/customers', async (context) => {
    requirePlatformAdmin(context.principal!);
    return db.query(
      `SELECT o.id AS organization_id, o.code, o.name, o.created_at,
              s.id AS store_id, s.code AS store_code, s.name AS store_name,
              (SELECT COUNT(*) FROM terminals t WHERE t.store_id = s.id)::int AS terminal_count,
              (SELECT COUNT(*) FROM terminals t
                WHERE t.store_id = s.id AND t.activation_state = 'ACTIVE')::int AS active_count,
              (SELECT MAX(t.last_seen_at) FROM terminals t WHERE t.store_id = s.id) AS last_seen_at,
              (SELECT COUNT(*) FROM products p WHERE p.organization_id = o.id)::int AS product_count,
              o.active
         FROM organizations o
         LEFT JOIN stores s ON s.organization_id = o.id
        ORDER BY o.created_at DESC, s.code`,
    );
  });

  /** Yeni musteri: organizasyon + magaza + stok lokasyonu (+ istege bagli yonetici) */
  server.route('POST', '/api/v1/platform/customers', async (context) => {
    const user = requirePlatformAdminUser(context.principal!);
    const code = str(context.body.code, 'code').toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) {
      throw validation('Musteri kodu 2-32 karakter olmali; harf, rakam, - ve _ kullanin', { field: 'code' });
    }
    const name = str(context.body.name, 'name');
    const storeName = optional(context.body.storeName) ?? name;
    const ownerEmail = optional(context.body.ownerEmail);
    const ownerPassword = optional(context.body.ownerPassword);
    if (ownerEmail !== null && (ownerPassword === null || ownerPassword.length < 12)) {
      throw validation('Yonetici parolasi en az 12 karakter olmali', { field: 'ownerPassword' });
    }

    const existing = await db.one<{ id: string }>(
      'SELECT id FROM organizations WHERE code = $1', [code]);
    if (existing !== undefined) throw conflict('Bu musteri kodu zaten kullaniliyor');

    const result = await db.tx(async (tx) => {
      const org = await tx.one<{ id: string }>(
        'INSERT INTO organizations (code, name) VALUES ($1,$2) RETURNING id', [code, name]);
      const store = await tx.one<{ id: string }>(
        `INSERT INTO stores (organization_id, code, name) VALUES ($1,'MERKEZ',$2) RETURNING id`,
        [org!.id, storeName]);
      await tx.exec(
        `INSERT INTO inventory_locations (store_id, code, name, kind)
         VALUES ($1,'MAGAZA','Magaza Rafi','STORE')
         ON CONFLICT (store_id, code) DO NOTHING`, [store!.id]);

      let ownerId: string | null = null;
      if (ownerEmail !== null && ownerPassword !== null) {
        const { hash, salt } = hashPassword(ownerPassword);
        const created = await tx.one<{ id: string }>(
          `INSERT INTO users (organization_id, email, display_name, password_hash, password_salt)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [org!.id, ownerEmail, storeName, hash, salt]);
        // Musteri yoneticisi 'admin' olur; 'owner' DEGIL. org.manage yetkisi
        // bayide kalir, boylece musteri baska magaza/organizasyon acamaz.
        await tx.exec(
          `INSERT INTO user_roles (user_id, role_code) VALUES ($1,'admin')`, [created!.id]);
        ownerId = created!.id;
      }

      await tx.exec(
        `INSERT INTO audit_log (organization_id, store_id, actor_type, actor_id, actor_name,
                                action, entity_type, entity_id, after_state, request_id, ip)
         VALUES ($1::uuid,$2,'USER',$3,$4,'platform.customer_created','organization',$1,$5,$6,$7)`,
        [
          org!.id, store!.id, user.userId, user.displayName,
          JSON.stringify({ code, name, storeName, ownerEmail }), context.requestId, context.ip,
        ]);
      return { organizationId: org!.id, storeId: store!.id, ownerId };
    });

    context.log.info('musteri olusturuldu', { code, organizationId: result.organizationId });
    return { ...result, code, name, storeCode: 'MERKEZ' };
  });

  /** Bu musteri icin tek kullanimlik aktivasyon kodu uret */
  server.route('POST', '/api/v1/platform/customers/:storeId/enrollment', async (context) => {
    const user = requirePlatformAdminUser(context.principal!);
    const storeId = str(context.params.storeId, 'storeId');
    const store = await db.one<{ organization_id: string; name: string; active: boolean }>(
      `SELECT s.organization_id, s.name, o.active
         FROM stores s JOIN organizations o ON o.id = s.organization_id
        WHERE s.id = $1`, [storeId]);
    if (store === undefined) throw notFound('Musteri magazasi bulunamadi');
    // Arsivlenmis musteriye kod uretilmez: uretilse bile kasa senkronize olamaz,
    // kurulum yapan kisiyi bosuna ugrastirmamak icin burada durdururuz.
    if (!store.active) throw conflict('Musteri arsivde. Once geri acin.');

    const terminalCode = (optional(context.body.terminalCode) ?? 'KASA-1').toUpperCase();
    const enrollment = generateEnrollmentCode();
    const hours = intOf(context.body.validHours, 'validHours', 24);
    if (hours < 1 || hours > 168) throw validation('validHours 1-168 arasinda olmali');
    const expiresAt = new Date(Date.now() + hours * 3600_000);

    const terminalId = await db.tx(async (tx) => {
      const terminal = await tx.one<{ id: string }>(
        `INSERT INTO terminals (store_id, code, name, activation_state)
         VALUES ($1,$2,$3,'PENDING')
         ON CONFLICT (store_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [storeId, terminalCode, optional(context.body.name) ?? terminalCode]);
      await tx.exec(
        `INSERT INTO enrollment_codes (store_id, code_hash, code_prefix, terminal_code,
                                       expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [storeId, enrollment.hash, enrollment.prefix, terminalCode, expiresAt, user.userId]);
      await tx.exec(
        `INSERT INTO audit_log (organization_id, store_id, terminal_id, actor_type, actor_id,
                                actor_name, action, entity_type, entity_id, after_state, request_id, ip)
         VALUES ($1,$2,$3::uuid,'USER',$4,$5,'platform.enrollment_created','terminal',$3,$6,$7,$8)`,
        [
          store.organization_id, storeId, terminal!.id, user.userId, user.displayName,
          JSON.stringify({ terminalCode, expiresAt }), context.requestId, context.ip,
        ]);
      return terminal!.id;
    });

    // Kod DUZ METIN olarak yalnizca burada doner; veritabaninda ozeti saklanir.
    return {
      terminalId, terminalCode, storeName: store.name,
      enrollmentCode: enrollment.plaintext, expiresAt,
    };
  });

  /**
   * Musteriyi arsivle / geri ac.
   *
   * SILME YOKTUR: denetim kaydi append-only oldugu icin organizasyon silinemez
   * ve silinmemelidir (gecmis satislarin izi kaybolur). Arsivlenen musterinin
   * kasalari merkeze SENKRONIZE OLAMAZ; ama kasa cevrimdisi calismaya devam
   * eder, yani magaza satis yapamaz hale GELMEZ.
   */
  server.route('POST', '/api/v1/platform/customers/:organizationId/archive', async (context) => {
    const user = requirePlatformAdminUser(context.principal!);
    const organizationId = str(context.params.organizationId, 'organizationId');
    const active = context.body.active === true;
    if (organizationId === user.organizationId) {
      throw validation('Kendi organizasyonunuzu arsivleyemezsiniz');
    }
    const org = await db.one<{ code: string }>(
      'SELECT code FROM organizations WHERE id = $1', [organizationId]);
    if (org === undefined) throw notFound('Musteri bulunamadi');

    await db.tx(async (tx) => {
      await tx.exec(
        'UPDATE organizations SET active = $2, updated_at = now() WHERE id = $1',
        [organizationId, active]);
      await tx.exec(
        `INSERT INTO audit_log (organization_id, actor_type, actor_id, actor_name,
                                action, entity_type, entity_id, after_state, request_id, ip)
         VALUES ($1::uuid,'USER',$2,$3,$4,'organization',$1,$5,$6,$7)`,
        [
          organizationId, user.userId, user.displayName,
          active ? 'platform.customer_restored' : 'platform.customer_archived',
          JSON.stringify({ active }), context.requestId, context.ip,
        ]);
    });
    context.log.warn('musteri durumu degisti', { code: org.code, active });
    return { ok: true, active };
  });

  /** Tum musterilerin terminalleri */
  server.route('GET', '/api/v1/platform/terminals', async (context) => {
    requirePlatformAdmin(context.principal!);
    return db.query(
      `SELECT t.id, t.code, t.name, t.activation_state, t.activated_at, t.revoked_at,
              t.last_seen_at, t.app_version, s.id AS store_id, s.name AS store_name,
              o.code AS customer_code, o.name AS customer_name,
              ds.last_push_at, ds.last_local_sequence
         FROM terminals t
         JOIN stores s ON s.id = t.store_id
         JOIN organizations o ON o.id = s.organization_id
         LEFT JOIN device_sync_state ds ON ds.terminal_id = t.id
        ORDER BY o.code, t.code`);
  });

  /** Terminali iptal et (calinan/degisen kasa) */
  server.route('POST', '/api/v1/platform/terminals/:id/revoke', async (context) => {
    const user = requirePlatformAdminUser(context.principal!);
    const id = str(context.params.id, 'id');
    const terminal = await db.one<{ store_id: string; organization_id: string }>(
      `SELECT t.store_id, s.organization_id FROM terminals t JOIN stores s ON s.id = t.store_id
        WHERE t.id = $1`, [id]);
    if (terminal === undefined) throw notFound('Terminal bulunamadi');

    await db.tx(async (tx) => {
      await tx.exec(
        `UPDATE terminals SET activation_state='REVOKED', revoked_at=now(), revoked_reason=$2
          WHERE id=$1`, [id, optional(context.body.reason)]);
      await tx.exec(
        'UPDATE terminal_tokens SET revoked_at = now() WHERE terminal_id = $1 AND revoked_at IS NULL',
        [id]);
      await tx.exec(
        `INSERT INTO audit_log (organization_id, store_id, terminal_id, actor_type, actor_id,
                                actor_name, action, entity_type, entity_id, after_state, request_id)
         VALUES ($1,$2,$3::uuid,'USER',$4,$5,'platform.terminal_revoked','terminal',$3,$6,$7)`,
        [
          terminal.organization_id, terminal.store_id, id, user.userId, user.displayName,
          JSON.stringify({ reason: optional(context.body.reason) }), context.requestId,
        ]);
    });
    context.log.warn('terminal iptal edildi (platform)', { terminalId: id });
    return { ok: true };
  });

  // ============================ /sync ============================

  server.route('POST', '/api/v1/sync/push', async (context) => {
    const terminal = asTerminal(context.principal);
    requirePermission(terminal, 'sync.push');

    const raw = context.body.events;
    if (!Array.isArray(raw)) throw badRequest('events dizisi bekleniyor');
    if (raw.length === 0) return { results: [] };
    if (raw.length > config.syncBatchMax) {
      throw badRequest(`Tek istekte en fazla ${config.syncBatchMax} olay gonderilebilir`);
    }

    const events = raw.map(validateEvent);
    const results = await processEvents(db, terminal, events, context.log);

    await db.exec(
      `UPDATE terminals SET last_seen_at = now(), app_version = COALESCE($2, app_version)
        WHERE id = $1`,
      [terminal.terminalId, optional(context.body.appVersion)],
    ).catch(() => undefined);

    return {
      results,
      accepted: results.filter((r) => r.status === 'PROCESSED').length,
      duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
    };
  }, { rateLimit: 600 });

  /** Ilk kurulum: merkezi katalogun sayfalanmis anlik goruntusu */
  server.route('GET', '/api/v1/sync/bootstrap', async (context) => {
    const terminal = asTerminal(context.principal);
    requirePermission(terminal, 'sync.pull');
    const limit = limitOf(context, 200, 500);
    const after = context.query.get('after') ?? '';

    const head = await db.one<{ id: number }>(
      'SELECT COALESCE(MAX(id), 0) AS id FROM change_log');

    const products = await db.query<Record<string, unknown>>(
      `SELECT p.id, p.code, p.name, p.unit, p.tax_rate_bp, p.track_stock, p.active,
              p.min_price, p.max_price, p.version,
              c.code AS category_code,
              COALESCE(pr_store.unit_price, pr_org.unit_price, 0) AS unit_price,
              COALESCE(
                (SELECT json_agg(json_build_object('barcode', b.barcode,
                                                   'packSize', b.pack_size_milli))
                   FROM product_barcodes b WHERE b.product_id = p.id), '[]'::json) AS barcodes,
              COALESCE(
                (SELECT json_agg(json_build_object('plu', pl.plu,
                                                   'department', pl.scale_department))
                   FROM product_plus pl
                  WHERE pl.product_id = p.id
                    AND (pl.store_id IS NULL OR pl.store_id = $2)), '[]'::json) AS plus
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN prices pr_org ON pr_org.product_id = p.id
              AND pr_org.store_id IS NULL AND pr_org.valid_to IS NULL
         LEFT JOIN prices pr_store ON pr_store.product_id = p.id
              AND pr_store.store_id = $2 AND pr_store.valid_to IS NULL
        WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.code > $3
        ORDER BY p.code
        LIMIT $4`,
      [terminal.organizationId, terminal.storeId, after, limit],
    );

    await db.exec('UPDATE terminals SET last_seen_at = now() WHERE id = $1',
      [terminal.terminalId]).catch(() => undefined);

    const last = products.at(-1);
    return {
      products,
      nextAfter: last === undefined ? null : (last.code as string),
      done: products.length < limit,
      cursor: head!.id,
    };
  }, { rateLimit: 600 });

  /** Artimli cekme: yalnizca cursor'dan sonraki degisiklikler */
  server.route('GET', '/api/v1/sync/pull', async (context) => {
    const terminal = asTerminal(context.principal);
    requirePermission(terminal, 'sync.pull');
    const cursor = Number(context.query.get('cursor') ?? '0');
    if (!Number.isInteger(cursor) || cursor < 0) throw validation('cursor gecersiz');
    const limit = limitOf(context, 200, 500);

    const changes = await db.query<{
      id: number; entity_type: string; entity_id: string; operation: string;
      payload: unknown; changed_at: Date;
    }>(
      `SELECT id, entity_type, entity_id, operation, payload, changed_at
         FROM change_log
        WHERE organization_id = $1 AND (store_id IS NULL OR store_id = $2) AND id > $3
        ORDER BY id LIMIT $4`,
      [terminal.organizationId, terminal.storeId, cursor, limit],
    );

    const nextCursor = changes.at(-1)?.id ?? cursor;
    await db.exec(
      `INSERT INTO device_sync_state (terminal_id, last_pull_cursor, last_pull_at)
       VALUES ($1,$2,now())
       ON CONFLICT (terminal_id) DO UPDATE SET
         last_pull_cursor = GREATEST(device_sync_state.last_pull_cursor, EXCLUDED.last_pull_cursor),
         last_pull_at = now(), updated_at = now()`,
      [terminal.terminalId, nextCursor],
    ).catch(() => undefined);

    return { changes, cursor: nextCursor, hasMore: changes.length === limit };
  }, { rateLimit: 1200 });

  /** Terminalin kendi magazasindaki merkezi bakiyeler (stok mutabakati icin) */
  server.route('GET', '/api/v1/sync/inventory', async (context) => {
    const terminal = asTerminal(context.principal);
    requirePermission(terminal, 'inventory.read');
    return db.query(
      `SELECT p.code, COALESCE(b.on_hand, 0) AS on_hand, COALESCE(b.reserved, 0) AS reserved
         FROM products p
         LEFT JOIN inventory_locations l
           ON l.store_id = $2 AND l.kind = 'STORE' AND l.active
         LEFT JOIN inventory_balances b
           ON b.product_id = p.id AND b.location_id = l.id
        WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.track_stock
        ORDER BY p.code`,
      [terminal.organizationId, terminal.storeId],
    );
  }, { rateLimit: 120 });

  server.route('GET', '/api/v1/sync/status', async (context) => {
    const principal = context.principal!;
    if (principal.kind === 'TERMINAL') {
      const state = await db.one(
        'SELECT * FROM device_sync_state WHERE terminal_id = $1', [principal.terminalId]);
      const failed = await db.one<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM sync_events WHERE terminal_id = $1 AND status IN ('FAILED','DEAD')",
        [principal.terminalId]);
      return { terminalId: principal.terminalId, state: state ?? null, failedEvents: failed!.n };
    }
    requirePermission(principal, 'reports.read');
    return db.query(
      `SELECT t.code, t.name, t.activation_state, t.last_seen_at,
              ds.last_push_at, ds.last_pull_at, ds.last_local_sequence,
              (SELECT COUNT(*) FROM sync_events e
                WHERE e.terminal_id = t.id AND e.status IN ('FAILED','DEAD')) AS failed_events
         FROM terminals t JOIN stores s ON s.id = t.store_id
         LEFT JOIN device_sync_state ds ON ds.terminal_id = t.id
        WHERE s.organization_id = $1 ORDER BY t.code`,
      [principal.organizationId],
    );
  });

  // ============================ /products & /prices ============================

  server.route('GET', '/api/v1/products', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'catalog.read');
    const limit = limitOf(context, 100, 500);
    const search = context.query.get('q');
    return db.query(
      `SELECT p.id, p.code, p.name, p.unit, p.tax_rate_bp, p.active, p.version,
              COALESCE(pr.unit_price, 0) AS unit_price
         FROM products p
         LEFT JOIN prices pr ON pr.product_id = p.id AND pr.store_id IS NULL AND pr.valid_to IS NULL
        WHERE p.organization_id = $1 AND p.deleted_at IS NULL
          AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.code ILIKE '%' || $2 || '%')
        ORDER BY p.name LIMIT $3`,
      [principal.organizationId, search, limit],
    );
  });

  server.route('POST', '/api/v1/products', async (context) => {
    const user = asUser(context.principal);
    requirePermission(user, 'catalog.write');
    const code = str(context.body.code, 'code');
    const unit = str(context.body.unit, 'unit');
    if (unit !== 'EACH' && unit !== 'KG') throw validation('unit EACH veya KG olmali');

    return db.tx(async (tx) => {
      const product = await tx.one<{ id: string }>(
        `INSERT INTO products (organization_id, code, name, unit, tax_rate_bp, track_stock)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id, code) DO UPDATE SET
           name = EXCLUDED.name, unit = EXCLUDED.unit, tax_rate_bp = EXCLUDED.tax_rate_bp,
           track_stock = EXCLUDED.track_stock, version = products.version + 1, updated_at = now()
         RETURNING id`,
        [
          user.organizationId, code, str(context.body.name, 'name'), unit,
          intOf(context.body.taxRateBp, 'taxRateBp', 0),
          context.body.trackStock !== false,
        ],
      );
      const unitPrice = intOf(context.body.unitPrice, 'unitPrice', 0);
      await tx.exec('UPDATE prices SET valid_to = now() WHERE product_id = $1 AND store_id IS NULL AND valid_to IS NULL',
        [product!.id]);
      await tx.exec('INSERT INTO prices (product_id, unit_price, created_by) VALUES ($1,$2,$3)',
        [product!.id, unitPrice, user.userId]);
      await tx.exec(
        'INSERT INTO price_history (product_id, new_price, source, changed_by) VALUES ($1,$2,$3,$4)',
        [product!.id, unitPrice, 'CENTRAL', user.userId]);

      for (const barcode of (Array.isArray(context.body.barcodes) ? context.body.barcodes : []) as string[]) {
        await tx.exec(
          `INSERT INTO product_barcodes (product_id, organization_id, barcode) VALUES ($1,$2,$3)
           ON CONFLICT (product_id, barcode) DO NOTHING`,
          [product!.id, user.organizationId, barcode]);
      }
      for (const plu of (Array.isArray(context.body.plus) ? context.body.plus : []) as number[]) {
        await tx.exec(
          `INSERT INTO product_plus (product_id, plu) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`, [product!.id, plu]);
      }

      await tx.exec(
        `INSERT INTO change_log (organization_id, entity_type, entity_id, operation, payload)
         VALUES ($1,'product',$2,'UPSERT',$3)`,
        [
          user.organizationId, product!.id,
          JSON.stringify({
            code, name: context.body.name, unit, unitPrice,
            taxRateBp: intOf(context.body.taxRateBp, 'taxRateBp', 0),
            // Bootstrap ile ayni bicim: istemcide tek uygulama yolu kalsin
            barcodes: (Array.isArray(context.body.barcodes) ? context.body.barcodes : [])
              .map((b) => (typeof b === 'string' ? { barcode: b, packSize: 1000 } : b)),
            plus: (Array.isArray(context.body.plus) ? context.body.plus : [])
              .map((p) => (typeof p === 'number' ? { plu: p, department: 1 } : p)),
            active: true,
          }),
        ],
      );
      await tx.exec(
        `INSERT INTO audit_log (organization_id, actor_type, actor_id, actor_name, action,
                                entity_type, entity_id, after_state, request_id)
         VALUES ($1,'USER',$2::text,$3,'product.upserted','product',$4::text,$5,$6)`,
        [
          user.organizationId, user.userId, user.displayName, product!.id,
          JSON.stringify({ code, unitPrice }), context.requestId,
        ]);
      return { id: product!.id, code };
    });
  });

  server.route('PUT', '/api/v1/prices/:productId', async (context) => {
    const user = asUser(context.principal);
    requirePermission(user, 'price.write');
    const productId = str(context.params.productId, 'productId');
    const unitPrice = intOf(context.body.unitPrice, 'unitPrice');
    if (unitPrice < 0) throw validation('unitPrice negatif olamaz');

    return db.tx(async (tx) => {
      const product = await tx.one<{ id: string; code: string; organization_id: string }>(
        'SELECT id, code, organization_id FROM products WHERE id = $1', [productId]);
      if (product === undefined) throw notFound('Urun bulunamadi');
      if (product.organization_id !== user.organizationId) throw forbidden('Kapsam disi urun');

      const current = await tx.one<{ id: string; unit_price: number }>(
        'SELECT id, unit_price FROM prices WHERE product_id=$1 AND store_id IS NULL AND valid_to IS NULL',
        [productId]);
      if (current !== undefined) {
        await tx.exec('UPDATE prices SET valid_to = now() WHERE id = $1', [current.id]);
      }
      await tx.exec('INSERT INTO prices (product_id, unit_price, created_by) VALUES ($1,$2,$3)',
        [productId, unitPrice, user.userId]);
      await tx.exec(
        `INSERT INTO price_history (product_id, old_price, new_price, reason, source, changed_by)
         VALUES ($1,$2,$3,$4,'CENTRAL',$5)`,
        [productId, current?.unit_price ?? null, unitPrice, optional(context.body.reason), user.userId]);
      await tx.exec('UPDATE products SET version = version + 1, updated_at = now() WHERE id = $1',
        [productId]);
      await tx.exec(
        `INSERT INTO change_log (organization_id, entity_type, entity_id, operation, payload)
         VALUES ($1,'price',$2,'UPSERT',$3)`,
        [user.organizationId, productId, JSON.stringify({ code: product.code, unitPrice })]);
      await tx.exec(
        `INSERT INTO audit_log (organization_id, actor_type, actor_id, actor_name, action,
                                entity_type, entity_id, before_state, after_state, request_id)
         VALUES ($1,'USER',$2::text,$3,'price.changed','product',$4::text,$5,$6,$7)`,
        [
          user.organizationId, user.userId, user.displayName, productId,
          JSON.stringify({ unitPrice: current?.unit_price ?? null }),
          JSON.stringify({ unitPrice }), context.requestId,
        ]);
      return { productId, unitPrice, previous: current?.unit_price ?? null };
    });
  });

  // ============================ /inventory ============================

  server.route('GET', '/api/v1/inventory', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'inventory.read');
    const storeId = context.query.get('storeId');
    if (storeId !== null) requireStoreScope(principal, storeId);
    return db.query(
      `SELECT p.code, p.name, p.unit, l.code AS location_code,
              b.on_hand, b.reserved, (b.on_hand - b.reserved) AS available, b.updated_at
         FROM inventory_balances b
         JOIN products p ON p.id = b.product_id
         JOIN inventory_locations l ON l.id = b.location_id
        WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR l.store_id = $2)
        ORDER BY p.name LIMIT $3`,
      [principal.organizationId, storeId, limitOf(context, 200, 1000)],
    );
  });

  server.route('GET', '/api/v1/inventory/ledger', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'inventory.read');
    return db.query(
      `SELECT g.id, p.code AS product_code, g.movement_type, g.quantity_delta,
              g.reference_type, g.reference_id, g.occurred_at, g.recorded_at
         FROM inventory_ledger g
         JOIN products p ON p.id = g.product_id
         JOIN inventory_locations l ON l.id = g.location_id
        WHERE p.organization_id = $1
          AND ($2::text IS NULL OR p.code = $2)
        ORDER BY g.id DESC LIMIT $3`,
      [principal.organizationId, context.query.get('productCode'), limitOf(context, 100, 500)],
    );
  });

  /** Gelecekteki online siparis icin stok rezervasyonu */
  server.route('POST', '/api/v1/inventory/reservations', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'inventory.reserve');
    const storeId = str(context.body.storeId, 'storeId');
    requireStoreScope(principal, storeId);
    const productCode = str(context.body.productCode, 'productCode');
    const quantity = intOf(context.body.quantity, 'quantity');
    if (quantity <= 0) throw validation('quantity pozitif olmali');

    return db.tx(async (tx) => {
      const product = await tx.one<{ id: string }>(
        'SELECT id FROM products WHERE organization_id=$1 AND code=$2 AND deleted_at IS NULL',
        [principal.organizationId, productCode]);
      if (product === undefined) throw notFound('Urun bulunamadi');

      const location = await tx.one<{ id: string }>(
        `SELECT id FROM inventory_locations WHERE store_id=$1 AND kind='STORE' AND active
         ORDER BY created_at LIMIT 1`, [storeId]);
      if (location === undefined) throw notFound('Stok lokasyonu bulunamadi');

      // Kilitleyerek oku: iki es zamanli rezervasyon ayni stogu iki kez ayiramaz
      const balance = await tx.one<{ on_hand: number; reserved: number }>(
        'SELECT on_hand, reserved FROM inventory_balances WHERE location_id=$1 AND product_id=$2 FOR UPDATE',
        [location.id, product.id]);
      const available = (balance?.on_hand ?? 0) - (balance?.reserved ?? 0);
      if (available < quantity) {
        throw conflict('Yeterli stok yok', { available, requested: quantity });
      }

      const reservation = await tx.one<{ id: string }>(
        `INSERT INTO stock_reservations (location_id, product_id, quantity, order_id, expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          location.id, product.id, quantity, optional(context.body.orderId),
          context.body.expiresInMinutes === undefined ? null
            : new Date(Date.now() + intOf(context.body.expiresInMinutes, 'expiresInMinutes') * 60_000),
        ]);
      await tx.exec(
        `INSERT INTO inventory_balances (location_id, product_id, on_hand, reserved)
         VALUES ($1,$2,0,$3)
         ON CONFLICT (location_id, product_id) DO UPDATE
           SET reserved = inventory_balances.reserved + EXCLUDED.reserved, updated_at = now()`,
        [location.id, product.id, quantity]);
      return { reservationId: reservation!.id, available: available - quantity };
    });
  });

  server.route('POST', '/api/v1/inventory/reservations/:id/release', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'inventory.reserve');
    return db.tx(async (tx) => {
      const reservation = await tx.one<{
        id: string; location_id: string; product_id: string; quantity: number; status: string;
      }>('SELECT * FROM stock_reservations WHERE id = $1 FOR UPDATE',
        [str(context.params.id, 'id')]);
      if (reservation === undefined) throw notFound('Rezervasyon bulunamadi');
      if (reservation.status !== 'ACTIVE') return { released: false, status: reservation.status };

      await tx.exec(
        "UPDATE stock_reservations SET status='RELEASED', resolved_at=now() WHERE id=$1",
        [reservation.id]);
      await tx.exec(
        `UPDATE inventory_balances SET reserved = GREATEST(0, reserved - $3), updated_at = now()
          WHERE location_id=$1 AND product_id=$2`,
        [reservation.location_id, reservation.product_id, reservation.quantity]);
      return { released: true };
    });
  });

  // ============================ /sales & /refunds & /cash-sessions ============================

  server.route('GET', '/api/v1/sales', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'sales.read');
    const storeId = context.query.get('storeId');
    if (storeId !== null) requireStoreScope(principal, storeId);
    return db.query(
      `SELECT s.id, s.doc_type, s.status, s.receipt_series, s.receipt_no, s.business_date,
              s.total, s.tax_total, s.item_count, s.completed_at, s.cashier_name,
              st.code AS store_code, t.code AS terminal_code
         FROM sales s
         JOIN stores st ON st.id = s.store_id
         LEFT JOIN terminals t ON t.id = s.terminal_id
        WHERE st.organization_id = $1
          AND ($2::uuid IS NULL OR s.store_id = $2)
          AND ($3::date IS NULL OR s.business_date = $3::date)
        ORDER BY s.completed_at DESC LIMIT $4`,
      [principal.organizationId, storeId, context.query.get('date'), limitOf(context, 100, 500)],
    );
  });

  server.route('GET', '/api/v1/sales/:id', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'sales.read');
    const id = str(context.params.id, 'id');
    const sale = await db.one<{ store_id: string }>(
      `SELECT s.*, st.organization_id FROM sales s JOIN stores st ON st.id = s.store_id
        WHERE s.id = $1`, [id]);
    if (sale === undefined) throw notFound('Satis bulunamadi');
    requireStoreScope(principal, sale.store_id);
    const [lines, payments] = await Promise.all([
      db.query('SELECT * FROM sale_lines WHERE sale_id = $1 ORDER BY line_no', [id]),
      db.query('SELECT * FROM payments WHERE sale_id = $1', [id]),
    ]);
    return { sale, lines, payments };
  });

  server.route('GET', '/api/v1/refunds', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'sales.read');
    return db.query(
      `SELECT r.id, r.reason, r.created_at, s.receipt_series, s.receipt_no, s.total,
              o.receipt_series AS original_series, o.receipt_no AS original_no
         FROM refunds r
         JOIN sales s ON s.id = r.refund_sale_id
         JOIN stores st ON st.id = s.store_id
         LEFT JOIN sales o ON o.id = r.original_sale_id
        WHERE st.organization_id = $1
        ORDER BY r.created_at DESC LIMIT $2`,
      [principal.organizationId, limitOf(context, 100, 500)],
    );
  });

  server.route('GET', '/api/v1/cash-sessions', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'cash.read');
    return db.query(
      `SELECT c.id, c.local_id, c.business_date, c.status, c.opened_at, c.closed_at,
              c.opening_float, c.counted_cash, c.expected_cash, c.variance,
              st.code AS store_code, t.code AS terminal_code
         FROM cash_sessions c
         JOIN stores st ON st.id = c.store_id
         LEFT JOIN terminals t ON t.id = c.terminal_id
        WHERE st.organization_id = $1
        ORDER BY c.opened_at DESC LIMIT $2`,
      [principal.organizationId, limitOf(context, 60, 200)],
    );
  });

  // ============================ /reports ============================

  server.route('GET', '/api/v1/reports/daily', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'reports.read');
    return db.query(
      `SELECT s.business_date, st.code AS store_code,
              (COUNT(*) FILTER (WHERE s.doc_type='SALE'))::int            AS sale_count,
              COALESCE(SUM(s.total) FILTER (WHERE s.doc_type='SALE'), 0)::bigint   AS sales_total,
              COALESCE(SUM(s.total) FILTER (WHERE s.doc_type='REFUND'), 0)::bigint AS refund_total,
              COALESCE(SUM(s.tax_total) FILTER (WHERE s.doc_type='SALE'), 0)::bigint AS tax_total
         FROM sales s JOIN stores st ON st.id = s.store_id
        WHERE st.organization_id = $1 AND s.status = 'COMPLETED'
          AND ($2::date IS NULL OR s.business_date >= $2::date)
          AND ($3::date IS NULL OR s.business_date <= $3::date)
        GROUP BY s.business_date, st.code
        ORDER BY s.business_date DESC LIMIT $4`,
      [
        principal.organizationId, context.query.get('from'), context.query.get('to'),
        limitOf(context, 60, 400),
      ],
    );
  });

  server.route('GET', '/api/v1/reports/top-products', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'reports.read');
    return db.query(
      `SELECT COALESCE(p.code, l.product_code) AS product_code, l.name_snapshot AS name,
              SUM(CASE WHEN s.doc_type='SALE' THEN l.quantity ELSE -l.quantity END)::bigint AS quantity,
              SUM(CASE WHEN s.doc_type='SALE' THEN l.net_amount ELSE -l.net_amount END)::bigint AS total
         FROM sale_lines l
         JOIN sales s ON s.id = l.sale_id
         JOIN stores st ON st.id = s.store_id
         LEFT JOIN products p ON p.id = l.product_id
        WHERE st.organization_id = $1 AND s.status='COMPLETED'
        GROUP BY 1, 2 ORDER BY total DESC LIMIT $2`,
      [principal.organizationId, limitOf(context, 25, 200)],
    );
  });

  server.route('GET', '/api/v1/audit', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'audit.read');
    return db.query(
      `SELECT id, at, actor_type, actor_name, action, entity_type, entity_id,
              before_state, after_state
         FROM audit_log WHERE organization_id = $1 ORDER BY id DESC LIMIT $2`,
      [principal.organizationId, limitOf(context, 100, 500)],
    );
  });

  // ============================ /orders (model hazir, arayuz yok) ============================

  server.route('GET', '/api/v1/orders', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'orders.read');
    return db.query(
      `SELECT id, order_no, channel, status, total, placed_at, created_at
         FROM orders WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [principal.organizationId, limitOf(context, 50, 200)],
    );
  });

  server.route('POST', '/api/v1/orders', async (context) => {
    const principal = context.principal!;
    requirePermission(principal, 'orders.write');
    const storeId = optional(context.body.storeId);
    if (storeId !== null) requireStoreScope(principal, storeId);

    return db.tx(async (tx) => {
      const order = await tx.one<{ id: string; order_no: string }>(
        `INSERT INTO orders (organization_id, store_id, channel, order_no, status, notes)
         VALUES ($1,$2,$3,$4,'DRAFT',$5) RETURNING id, order_no`,
        [
          principal.organizationId, storeId,
          optional(context.body.channel) ?? 'ONLINE',
          optional(context.body.orderNo) ?? `ORD-${randomUUID().slice(0, 8).toUpperCase()}`,
          optional(context.body.notes),
        ]);
      await tx.exec(
        `INSERT INTO order_status_history (order_id, to_status, actor_type, actor_id)
         VALUES ($1,'DRAFT',$2,$3)`,
        [
          order!.id, principal.kind,
          principal.kind === 'USER' ? principal.userId : principal.terminalId,
        ]);
      return order;
    });
  });
}
