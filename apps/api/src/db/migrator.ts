import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { DbConnection } from '../config/config.js';

const MIGRATIONS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type MigrationSet = 'record' | 'secrets';

/**
 * Minimal forward-only migrator. Applies `migrations/<set>/*.sql` in name order,
 * each in its own transaction, and records it in `schema_migration` (which is
 * itself append-only once 0002 has run).
 */
export async function migrate(conn: DbConnection, set: MigrationSet): Promise<string[]> {
  const client = new pg.Client(conn);
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name),
    );
    const files = readdirSync(join(MIGRATIONS_ROOT, set))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_ROOT, set, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${set}/${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}
