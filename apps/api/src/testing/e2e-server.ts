import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { createApp } from '../bootstrap.js';
import { RecordService } from '../record/record.service.js';
import { SupplyService } from '../supply/supply.service.js';
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
  ORBOT_APPS_POLL_SECONDS: '0',
  ORBOT_LOG_LEVEL: 'warn',
  ORBOT_API_PORT: process.env['ORBOT_E2E_API_PORT'] ?? '3100',
  ORBOT_WEB_ORIGIN: 'http://localhost:4300',
  ORBOT_WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'orbot-e2e-ws-')),
});
await resetTestDatabases(config);
const app = await createApp({ config });
await app.init();
await seedDemoForce(app);
// A GPU server as it is once connected (the suite has no SSH server). Its host does not
// resolve, so an install from the UI fails the way an unreachable server does.
await app.get(SupplyService).storeCredential(
  {
    name: 'gpu1-key',
    value: '-----BEGIN OPENSSH PRIVATE KEY-----\ne2ee2ee2e\n-----END OPENSSH PRIVATE KEY-----',
  },
  { actor: 'system:e2e', reason: 'SSH key for the UI suite’s GPU server' },
);
await app.get(RecordService).create(
  'supply',
  {
    name: 'gpu1',
    connected: true,
    spec: {
      kind: 'environment',
      details: { tier: 'dev' },
      server: {
        host: 'gpu1.invalid',
        port: 22,
        user: 'admin',
        credentialName: 'gpu1-key',
        hostKeys: ['gpu1.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2eE2eE2eE2eE2eE2eE2eE2e'],
        fingerprints: ['256 SHA256:e2e/fingerprint gpu1.invalid (ED25519)'],
        url: null,
        rsync: true,
        facts: {
          os: 'Ubuntu 24.04.1 LTS',
          gpu: 'NVIDIA GeForce RTX 3090, 24576 MiB, 550.120',
          memory: '62 GB',
          docker: 'not installed',
          sudo: 'passwordless',
          rsync: 'yes',
        },
        workspace: null,
        apps: [],
      },
    },
  },
  { actor: 'system:e2e', reason: 'A connected GPU server for the UI suite' },
);
await app.listen(config.apiPort);
console.log(`e2e API ready on :${config.apiPort}`);
