import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { DEFAULT_PRODUCT_NAME } from '@orbot/shared';

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'docker-compose.yml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const Env = z.object({
  ORBOT_PRODUCT_NAME: z.string().min(1).default(DEFAULT_PRODUCT_NAME),
  ORBOT_DB_HOST: z.string().default('localhost'),
  ORBOT_DB_PORT: z.coerce.number().int().default(5432),
  ORBOT_DB_NAME: z.string().default('orbot'),
  ORBOT_DB_OWNER_PASSWORD: z.string().default('change-me-owner'),
  ORBOT_DB_APP_PASSWORD: z.string().default('change-me-app'),
  ORBOT_SECRETS_DB_NAME: z.string().default('orbot_secrets'),
  ORBOT_DB_SECRETS_PASSWORD: z.string().default('change-me-secrets'),
  ORBOT_SECRETS_KEY: z.string().refine((k) => Buffer.from(k, 'base64').length === 32, {
    message:
      'ORBOT_SECRETS_KEY must be 32 bytes, base64-encoded. Run `npm run dev` once to generate one.',
  }),
  ORBOT_COMMANDER_PASSPHRASE: z.string().min(8, {
    message: 'ORBOT_COMMANDER_PASSPHRASE must be at least 8 characters.',
  }),
  ORBOT_SESSION_SECRET: z.string().min(32, {
    message: 'ORBOT_SESSION_SECRET must be at least 32 characters.',
  }),
  ORBOT_API_PORT: z.coerce.number().int().default(3000),
  ORBOT_WEB_ORIGIN: z.string().default('http://localhost:4200'),
  ORBOT_RUNTIME: z.string().default('simulated'),
  ORBOT_SIM_SPEED: z.coerce.number().min(0).default(1),
  ORBOT_WORKSPACES_DIR: z.string().default('./workspaces'),
  ORBOT_CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  /** Enables the Claude runtime. Kept out of every record by the redactor. */
  ANTHROPIC_API_KEY: z.string().default(''),
  /**
   * Enables the claude-code runtime: bots run with Claude Code, signed in with your own
   * Claude plan (`claude` login on this machine). Also on when ORBOT_RUNTIME=claude-code.
   */
  ORBOT_CLAUDE_CODE: z
    .enum(['on', 'off'])
    .default('off')
    .transform((v) => v === 'on'),
  /** A `claude` binary to use instead of the one bundled with the Agent SDK. */
  ORBOT_CLAUDE_CODE_PATH: z.string().default(''),
  /** How often each Overseer runs its cold-start check (0 = only on demand). */
  ORBOT_COLDSTART_INTERVAL_MINUTES: z.coerce.number().min(0).default(360),
  /** How often stuck work is looked for (0 = never; tests call the sweep directly). */
  ORBOT_ESCALATION_SWEEP_SECONDS: z.coerce.number().min(0).default(30),
  /** How often HQ checks whether the daily brief is due (0 = never; tests write it on demand). */
  ORBOT_DAILY_BRIEF_CHECK_SECONDS: z.coerce.number().min(0).default(60),
  /** How often pending build pipelines are checked on connected services (0 = only on push). */
  ORBOT_CONNECTIONS_POLL_SECONDS: z.coerce.number().min(0).default(30),
  ORBOT_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export interface DbConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface AppConfig {
  productName: string;
  recordDb: { app: DbConnection; owner: DbConnection };
  secretsDb: DbConnection;
  secretsKey: Buffer;
  commanderPassphrase: string;
  sessionSecret: string;
  apiPort: number;
  webOrigin: string;
  defaultRuntime: string;
  simSpeed: number;
  workspacesDir: string;
  claudeModel: string;
  anthropicApiKey: string;
  claudeCode: boolean;
  claudeCodePath: string;
  coldStartIntervalMs: number;
  escalationSweepMs: number;
  dailyBriefCheckMs: number;
  connectionsPollMs: number;
  logLevel: z.infer<typeof Env>['ORBOT_LOG_LEVEL'];
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Reads `.env` at the repo root (if present) and validates the environment. */
export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  loadDotenv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
  const parsed = Env.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`ORBOT configuration is invalid:\n${problems}`);
  }
  const e = parsed.data;
  const base = { host: e.ORBOT_DB_HOST, port: e.ORBOT_DB_PORT, database: e.ORBOT_DB_NAME };
  return {
    productName: e.ORBOT_PRODUCT_NAME,
    recordDb: {
      app: { ...base, user: 'orbot_app', password: e.ORBOT_DB_APP_PASSWORD },
      owner: { ...base, user: 'orbot_owner', password: e.ORBOT_DB_OWNER_PASSWORD },
    },
    secretsDb: {
      host: e.ORBOT_DB_HOST,
      port: e.ORBOT_DB_PORT,
      database: e.ORBOT_SECRETS_DB_NAME,
      user: 'orbot_secrets',
      password: e.ORBOT_DB_SECRETS_PASSWORD,
    },
    secretsKey: Buffer.from(e.ORBOT_SECRETS_KEY, 'base64'),
    commanderPassphrase: e.ORBOT_COMMANDER_PASSPHRASE,
    sessionSecret: e.ORBOT_SESSION_SECRET,
    apiPort: e.ORBOT_API_PORT,
    webOrigin: e.ORBOT_WEB_ORIGIN,
    defaultRuntime: e.ORBOT_RUNTIME,
    simSpeed: e.ORBOT_SIM_SPEED,
    workspacesDir: resolve(REPO_ROOT, e.ORBOT_WORKSPACES_DIR),
    claudeModel: e.ORBOT_CLAUDE_MODEL,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    claudeCode: e.ORBOT_CLAUDE_CODE || e.ORBOT_RUNTIME === 'claude-code',
    claudeCodePath: e.ORBOT_CLAUDE_CODE_PATH,
    coldStartIntervalMs: e.ORBOT_COLDSTART_INTERVAL_MINUTES * 60_000,
    escalationSweepMs: e.ORBOT_ESCALATION_SWEEP_SECONDS * 1000,
    dailyBriefCheckMs: e.ORBOT_DAILY_BRIEF_CHECK_SECONDS * 1000,
    connectionsPollMs: e.ORBOT_CONNECTIONS_POLL_SECONDS * 1000,
    logLevel: e.ORBOT_LOG_LEVEL,
  };
}

/** The config values that are themselves secrets; fed to the redactor at startup. */
export function configSecrets(c: AppConfig): string[] {
  return [
    c.recordDb.app.password,
    c.recordDb.owner.password,
    c.secretsDb.password,
    c.secretsKey.toString('base64'),
    c.commanderPassphrase,
    c.sessionSecret,
    ...(c.anthropicApiKey ? [c.anthropicApiKey] : []),
  ];
}
