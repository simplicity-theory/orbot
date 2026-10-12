#!/usr/bin/env node
// Wipes the DEV databases (record and secrets) and re-seeds the demo force.
// Destructive by design and only for local development: it asks for confirmation.
// The permanent record of a real deployment must never be reset.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const root = new URL('..', import.meta.url).pathname;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    'This deletes ALL local dev data (the docker volume orbot_orbot-pg) and re-seeds the demo force.\nType "reset" to continue: ',
  );
  rl.close();
  if (answer.trim() !== 'reset') {
    console.log('Nothing changed.');
    process.exit(0);
  }
}

run('docker', ['compose', 'down', '--volumes']);
run('docker', ['compose', 'up', '-d', '--wait', 'db']);
run('npm', ['run', 'build', '-w', '@orbot/shared']);
run('npm', ['run', 'migrate', '-w', '@orbot/api']);
run('npm', ['run', 'seed', '-w', '@orbot/api']);
console.log('Dev database reset and re-seeded.');
