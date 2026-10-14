import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { createApp } from '../bootstrap.js';
import { seedDemoForce } from '../seed/seed.js';
import { resetTestDatabases } from './reset.js';

/**
 * API for the Playwright suite: fresh *_test databases, demo force seeded,
 * fixed test credentials. Never touches the real record.
 */
const config = loadConfig({
  ORBOT_DB_NAME: 'orbot_test',
  ORBOT_SECRETS_DB_NAME: 'orbot_secrets_test',
  ORBOT_SECRETS_KEY: createHash('sha256').update('orbot-test-secrets-key').digest('base64'),
  ORBOT_COMMANDER_PASSPHRASE: 'test-commander-passphrase',
  ORBOT_SESSION_SECRET: 'test-session-secret-test-session-secret',
  ORBOT_SIM_SPEED: '0',
  // Never the Commander's real runtime from .env: tests run on the simulator alone.
  ORBOT_RUNTIME: 'simulated',
  ORBOT_CLAUDE_CODE: 'off',
  ANTHROPIC_API_KEY: '',
  ORBOT_COLDSTART_INTERVAL_MINUTES: '0',
  ORBOT_ESCALATION_SWEEP_SECONDS: '1',
  ORBOT_DAILY_BRIEF_CHECK_SECONDS: '0',
  ORBOT_CONNECTIONS_POLL_SECONDS: '0',
  ORBOT_LOG_LEVEL: 'warn',
  ORBOT_API_PORT: process.env['ORBOT_E2E_API_PORT'] ?? '3100',
  ORBOT_WEB_ORIGIN: 'http://localhost:4300',
  ORBOT_WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'orbot-e2e-ws-')),
});
await resetTestDatabases(config);
const app = await createApp({ config });
await app.init();
await seedDemoForce(app);
await app.listen(config.apiPort);
console.log(`e2e API ready on :${config.apiPort}`);
