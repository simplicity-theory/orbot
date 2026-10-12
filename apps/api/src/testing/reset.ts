import pg from 'pg';
import type { AppConfig, DbConnection } from '../config/config.js';
import { migrate } from '../db/migrator.js';

function assertTestDb(conn: DbConnection) {
  if (!conn.database.endsWith('_test')) {
    throw new Error(`Refusing to reset non-test database "${conn.database}".`);
  }
}

async function resetSchema(conn: DbConnection, grantTo?: string) {
  assertTestDb(conn);
  const c = new pg.Client(conn);
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
    if (grantTo) await c.query(`GRANT USAGE ON SCHEMA public TO ${grantTo}`);
  } finally {
    await c.end();
  }
}

/**
 * Drops and re-migrates both *_test databases. Test-only: refuses any database
 * whose name does not end in `_test`, so the real record can never be reset.
 */
export async function resetTestDatabases(config: AppConfig): Promise<void> {
  await resetSchema(config.recordDb.owner, 'orbot_app');
  await resetSchema(config.secretsDb);
  await migrate(config.recordDb.owner, 'record');
  await migrate(config.secretsDb, 'secrets');
}
