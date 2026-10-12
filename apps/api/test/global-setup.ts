import pg from 'pg';
import { testConfig } from './helpers.js';

/** Fails fast with a clear message if the test database is not reachable. */
export default async function setup() {
  const config = testConfig();
  const c = new pg.Client({ ...config.recordDb.owner, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${config.recordDb.owner.host}:${config.recordDb.owner.port} (${(err as Error).message}).\n` +
        'Start it with `npm run db:up` from the repo root, then re-run the tests.',
    );
  } finally {
    await c.end().catch(() => undefined);
  }
}
