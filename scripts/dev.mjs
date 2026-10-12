#!/usr/bin/env node
// One command for local development:
//   1. create .env from .env.example on first run (generating real secrets)
//   2. start Postgres (docker compose) and wait until healthy
//   3. build the shared package, run migrations, seed the demo force if the record is empty
//   4. run shared (watch), API (watch) and web (ng serve) together
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function ensureEnv() {
  if (existsSync(envPath)) return;
  const gen = {
    ORBOT_SECRETS_KEY: randomBytes(32).toString('base64'),
    ORBOT_COMMANDER_PASSPHRASE: randomBytes(12).toString('base64url'),
    ORBOT_SESSION_SECRET: randomBytes(32).toString('base64url'),
  };
  let text = readFileSync(join(root, '.env.example'), 'utf8');
  for (const [k, v] of Object.entries(gen))
    text = text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
  writeFileSync(envPath, text, { mode: 0o600 });
  console.log('\nCreated .env with freshly generated secrets.');
  console.log(`Your Commander passphrase: ${gen.ORBOT_COMMANDER_PASSPHRASE}  (also in .env)\n`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(' ')} failed.`);
    process.exit(r.status ?? 1);
  }
}

ensureEnv();

console.log('▸ Starting Postgres…');
const dc = spawnSync('docker', ['compose', 'up', '-d', '--wait', 'db'], {
  cwd: root,
  stdio: 'inherit',
});
if (dc.status !== 0) {
  console.error(
    '\n✖ Could not start Postgres with docker compose.\n' +
      '  Is Docker running, and is your user in the docker group? (sudo usermod -aG docker $USER, then log in again)',
  );
  process.exit(1);
}

console.log('▸ Building shared package…');
run('npm', ['run', 'build', '-w', '@orbot/shared']);
console.log('▸ Migrating…');
run('npm', ['run', 'migrate', '-w', '@orbot/api']);
console.log('▸ Seeding (skipped if the record already has units)…');
run('npm', ['run', 'seed', '-w', '@orbot/api']);

console.log('▸ Starting shared (watch), API and web…\n');
const child = spawn(
  'npx',
  [
    'concurrently',
    '--kill-others-on-fail',
    '--names',
    'shared,api,web',
    '--prefix-colors',
    'gray,cyan,magenta',
    'npm run dev -w @orbot/shared',
    'npm run dev -w @orbot/api',
    'npm run dev -w @orbot/web',
  ],
  { cwd: root, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 0));
