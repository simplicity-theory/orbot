import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { loadConfig, type AppConfig, type DbConnection } from '../src/config/config.js';
import { createApp } from '../src/bootstrap.js';
import { resetTestDatabases } from '../src/testing/reset.js';

export const TEST_PASSPHRASE = 'test-commander-passphrase';

/** Config pointed at the *_test databases, with fixed test secrets. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ORBOT_DB_NAME: 'orbot_test',
    ORBOT_SECRETS_DB_NAME: 'orbot_secrets_test',
    ORBOT_SECRETS_KEY: createHash('sha256').update('orbot-test-secrets-key').digest('base64'),
    ORBOT_COMMANDER_PASSPHRASE: TEST_PASSPHRASE,
    ORBOT_SESSION_SECRET: 'test-session-secret-test-session-secret',
    ORBOT_SIM_SPEED: '0',
    ORBOT_COLDSTART_INTERVAL_MINUTES: '0',
    ORBOT_LOG_LEVEL: 'info',
    ORBOT_WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'orbot-test-ws-')),
    ...overrides,
  });
}

/** Drops and re-migrates both test databases. Test-only: the real record is never reset. */
export const resetDatabases = resetTestDatabases;

/** Collects every log line the app writes. */
export class LogCapture extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  }
  get text() {
    return this.lines.join('\n');
  }
}

export interface TestApp {
  app: INestApplication;
  config: AppConfig;
  logs: LogCapture;
  /** A supertest agent already signed in as the Commander. */
  agent: TestAgent;
  close(): Promise<void>;
}

export async function startTestApp(
  opts: { reset?: boolean; overrides?: Record<string, string> } = {},
): Promise<TestApp> {
  const config = testConfig(opts.overrides);
  if (opts.reset !== false) await resetDatabases(config);
  const logs = new LogCapture();
  const app = await createApp({ config, logDestination: logs });
  await app.init();
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').send({ passphrase: TEST_PASSPHRASE }).expect(200);
  return { app, config, logs, agent, close: () => app.close() };
}

/** Run SQL as a given role against the test record database. */
export async function asRole<T>(conn: DbConnection, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(conn);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
