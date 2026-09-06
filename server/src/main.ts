/**
 * Merkezi POS control-plane sunucusu.
 *
 * Migration'lar BURADA calistirilmaz; deploy sirasinda `cli.js migrate` ile
 * ayri adimda uygulanir (systemd ExecStartPre). Sunucu yalnizca semanin guncel
 * oldugunu DOGRULAR; degilse acilmaz. Boylece yarim uygulanmis sema uzerinde
 * calisan bir servis olusmaz.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.ts';
import { Logger } from './lib/log.ts';
import { Database } from './db.ts';
import { HttpServer } from './http.ts';
import { registerRoutes } from './routes.ts';
import { authenticate } from './auth.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel, { service: 'dagci-pos-platform' });

  const db = new Database({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    logger,
  });

  if (!(await db.healthy())) {
    logger.error('Veritabanina baglanilamadi, sunucu baslatilmiyor');
    process.exit(1);
  }

  // Sema surumu dogrulamasi
  const files = readdirSync(join(HERE, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const applied = await db.query<{ version: string }>('SELECT version FROM schema_migrations')
    .catch(() => []);
  const appliedSet = new Set(applied.map((r) => r.version));
  const pending = files.filter((f) => !appliedSet.has(f));
  if (pending.length > 0) {
    logger.error('Uygulanmamis migration var, sunucu baslatilmiyor', undefined, { pending });
    process.exit(1);
  }
  logger.info('Sema guncel', { version: files.at(-1) ?? null, migrations: files.length });

  const server = new HttpServer({
    logger,
    maxBodyBytes: config.maxBodyBytes,
    rateLimit: config.rateLimit,
    trustProxy: config.trustProxy,
    authenticate: (token) => authenticate(db, token),
  });
  registerRoutes(server, db, config);

  const port = await server.listen(config.host, config.port);
  logger.info('Sunucu hazir', {
    host: config.host, port, env: config.nodeEnv, routes: server.routes.length,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Kapaniyor', { signal });
    // Once yeni istek kabul etmeyi birak, sonra havuzu kapat
    await server.close();
    await db.close();
    logger.info('Kapandi');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (error) => logger.error('Yakalanmamis hata', error));
  process.on('unhandledRejection', (reason) => logger.error('Islenmeyen ret', reason));
}

await main();
