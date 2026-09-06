/**
 * Yonetim komutlari (deploy ve ilk kurulum).
 *   node dist/cli.js <komut> [...]
 */
import { loadConfig } from './lib/config.ts';
import { Logger } from './lib/log.ts';
import { Database, migrate } from './db.ts';
import { hashPassword, generateEnrollmentCode } from './lib/crypto.ts';

function usage(): void {
  console.log(`
Merkezi POS platform komutlari

  migrate                       Bekleyen migration'lari uygula
  migrate:status                Sema surumu ve uygulanan migration'lar

  org:create <kod> <ad>         Organizasyon olustur
  store:create <orgKod> <kod> <ad>
  user:create <orgKod> <eposta> <ad> <parola> <rol>
  platform:admin <eposta> [true|false]          Bayi yetkisi ver/al
  device:create <magazaKod> <terminalKod> <ad>   Aktivasyon kodu uretir
  device:list
  status                        Genel durum ozeti
`);
}

async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const logger = new Logger(config.logLevel, { service: 'cli' });
  const db = new Database({ connectionString: config.databaseUrl, max: 4, logger });

  try {
    switch (command) {
      case 'migrate': {
        const result = await migrate(db, logger);
        console.log(JSON.stringify({
          applied: result.applied, alreadyApplied: result.alreadyApplied.length,
          version: result.version,
        }, null, 2));
        break;
      }

      case 'migrate:status': {
        const rows = await db.query('SELECT version, applied_at, duration_ms FROM schema_migrations ORDER BY version')
          .catch(() => []);
        console.log(JSON.stringify(rows, null, 2));
        break;
      }

      case 'org:create': {
        const [code, name] = args;
        if (!code || !name) { usage(); process.exitCode = 1; break; }
        const row = await db.one<{ id: string }>(
          `INSERT INTO organizations (code, name) VALUES ($1,$2)
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code, name]);
        console.log(JSON.stringify({ organizationId: row!.id, code }));
        break;
      }

      case 'store:create': {
        const [orgCode, code, name] = args;
        if (!orgCode || !code || !name) { usage(); process.exitCode = 1; break; }
        const org = await db.one<{ id: string }>('SELECT id FROM organizations WHERE code=$1', [orgCode]);
        if (org === undefined) throw new Error(`Organizasyon yok: ${orgCode}`);
        const result = await db.tx(async (tx) => {
          const store = await tx.one<{ id: string }>(
            `INSERT INTO stores (organization_id, code, name) VALUES ($1,$2,$3)
             ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`, [org.id, code, name]);
          await tx.exec(
            `INSERT INTO inventory_locations (store_id, code, name, kind)
             VALUES ($1,'MAGAZA','Magaza Rafi','STORE')
             ON CONFLICT (store_id, code) DO NOTHING`, [store!.id]);
          return store!.id;
        });
        console.log(JSON.stringify({ storeId: result, code }));
        break;
      }

      case 'user:create': {
        const [orgCode, email, name, password, role] = args;
        if (!orgCode || !email || !name || !password || !role) { usage(); process.exitCode = 1; break; }
        if (password.length < 12) throw new Error('Parola en az 12 karakter olmali');
        const org = await db.one<{ id: string }>('SELECT id FROM organizations WHERE code=$1', [orgCode]);
        if (org === undefined) throw new Error(`Organizasyon yok: ${orgCode}`);
        const { hash, salt } = hashPassword(password);
        const result = await db.tx(async (tx) => {
          const user = await tx.one<{ id: string }>(
            `INSERT INTO users (organization_id, email, display_name, password_hash, password_salt)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (organization_id, email) DO UPDATE SET
               display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash,
               password_salt = EXCLUDED.password_salt, updated_at = now()
             RETURNING id`, [org.id, email, name, hash, salt]);
          await tx.exec(
            `INSERT INTO user_roles (user_id, role_code) VALUES ($1,$2)
             ON CONFLICT DO NOTHING`, [user!.id, role]);
          return user!.id;
        });
        console.log(JSON.stringify({ userId: result, email, role }));
        break;
      }

      case 'platform:admin': {
        const [email, flag] = args;
        if (!email) { usage(); process.exitCode = 1; break; }
        const value = flag === undefined ? true : flag === 'true';
        const row = await db.one<{ email: string; is_platform_admin: boolean }>(
          `UPDATE users SET is_platform_admin = $2, updated_at = now()
            WHERE lower(email) = lower($1) RETURNING email, is_platform_admin`, [email, value]);
        if (row === undefined) throw new Error(`Kullanici yok: ${email}`);
        console.log(JSON.stringify(row));
        break;
      }

      case 'device:create': {
        const [storeCode, terminalCode, name] = args;
        if (!storeCode || !terminalCode) { usage(); process.exitCode = 1; break; }
        const store = await db.one<{ id: string }>('SELECT id FROM stores WHERE code=$1', [storeCode]);
        if (store === undefined) throw new Error(`Magaza yok: ${storeCode}`);
        const enrollment = generateEnrollmentCode();
        const expiresAt = new Date(Date.now() + 24 * 3600_000);
        await db.tx(async (tx) => {
          await tx.exec(
            `INSERT INTO terminals (store_id, code, name, activation_state)
             VALUES ($1,$2,$3,'PENDING')
             ON CONFLICT (store_id, code) DO UPDATE SET name = EXCLUDED.name`,
            [store.id, terminalCode, name ?? terminalCode]);
          await tx.exec(
            `INSERT INTO enrollment_codes (store_id, code_hash, code_prefix, terminal_code, expires_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [store.id, enrollment.hash, enrollment.prefix, terminalCode, expiresAt]);
        });
        console.log(JSON.stringify({
          terminalCode, enrollmentCode: enrollment.plaintext, expiresAt,
        }, null, 2));
        console.log('\nBu kodu POS uygulamasina girin. Kod tek kullanimliktir ve 24 saat gecerlidir.');
        break;
      }

      case 'device:list': {
        const rows = await db.query(
          `SELECT t.code, t.name, t.activation_state, t.last_seen_at, s.code AS store,
                  ds.last_push_at, ds.last_local_sequence
             FROM terminals t JOIN stores s ON s.id=t.store_id
             LEFT JOIN device_sync_state ds ON ds.terminal_id=t.id ORDER BY s.code, t.code`);
        console.log(JSON.stringify(rows, null, 2));
        break;
      }

      case 'status': {
        const [schema, counts] = await Promise.all([
          db.one<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'),
          db.one(`SELECT
                    (SELECT COUNT(*) FROM organizations) AS organizations,
                    (SELECT COUNT(*) FROM stores) AS stores,
                    (SELECT COUNT(*) FROM terminals) AS terminals,
                    (SELECT COUNT(*) FROM products) AS products,
                    (SELECT COUNT(*) FROM sales) AS sales,
                    (SELECT COUNT(*) FROM sync_events) AS sync_events,
                    (SELECT COUNT(*) FROM sync_events WHERE status='FAILED') AS failed_events`),
        ]);
        console.log(JSON.stringify({ schemaVersion: schema?.version ?? null, ...counts }, null, 2));
        break;
      }

      default:
        usage();
        if (command !== undefined) process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

await run();
