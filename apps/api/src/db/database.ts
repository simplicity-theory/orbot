import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { DbConnection } from '../config/config.js';
import * as schema from './schema.js';

export type RecordDb = NodePgDatabase<typeof schema>;

export const RECORD_POOL = Symbol('RECORD_POOL');
export const RECORD_DB = Symbol('RECORD_DB');

export function createPool(conn: DbConnection, max = 10): pg.Pool {
  return new pg.Pool({ ...conn, max, application_name: `orbot-${conn.user}` });
}

export function createRecordDb(pool: pg.Pool): RecordDb {
  return drizzle(pool, { schema });
}
