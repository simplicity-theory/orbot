import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { UnitBody } from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { git } from '../common/git.js';
import { DocumentsService } from '../domain/documents.service.js';
import { ForceService } from '../domain/force.service.js';
import { WorkService } from '../domain/work.service.js';
import { TaskRunner } from '../execution/task-runner.js';
import { RecordService } from '../record/record.service.js';
import { SupplyService } from '../supply/supply.service.js';

const SEED = { actor: 'system:seed', reason: 'Demo force seeded' };

interface UnitSeed {
  body: Omit<UnitBody, 'overseerBotId' | 'supplyIds'>;
  overseerRole: string;
  botRoles: string[];
  fieldManual: { v1: string; v2: string; v2Reason: string };
}

const UNITS: UnitSeed[] = [
  {
    body: {
      name: 'Engineers',
      slug: 'engineers',
      role: 'Developers',
      standingMission: 'Build features and fix bugs to spec.',
      callsignPrefix: 'E',
      approvalGate: 'backbriefs-and-deploys',
      rulesOfEngagement: {
        mayDoAlone: ['Create branches and commits in the task workspace', 'Run tests', 'Refactor within the task scope'],
        mustEscalate: ['Changing a public API', 'Adding a new dependency', 'Anything touching authentication'],
      },
      standingOrders: [
        { id: 'eng-1', text: 'Every change ships with tests.' },
        { id: 'eng-2', text: 'One task, one branch.' },
      ],
      order: 1,
    },
    overseerRole: 'Overseer — lead engineer',
    botRoles: ['Backend developer', 'Backend developer', 'Frontend developer'],
    fieldManual: {
      v1: '# Engineers Field Manual\n\n## Branching\nWork on `orbot/task-<n>` branches cut from main.\n\n## Tests\nRun the unit suite before handing over.\n',
      v2: '# Engineers Field Manual\n\n## Branching\nWork on `orbot/task-<n>` branches cut from main.\n\n## Tests\nRun the unit suite before handing over.\nWarm the test cache first: the suite is slow on a cold cache.\n\n## Fixtures\nShared fixtures live in `test/fixtures`; never edit one without checking who else uses it.\n',
      v2Reason: 'Promoted two lessons from task handovers',
    },
  },
  {
    body: {
      name: 'Logistics',
      slug: 'logistics',
      role: 'DevOps',
      standingMission: 'Keep pipelines, environments and deployments running.',
      callsignPrefix: 'L',
      approvalGate: 'backbriefs-and-deploys',
      rulesOfEngagement: {
        mayDoAlone: ['Restart failed pipeline jobs', 'Deploy to staging'],
        mustEscalate: ['Deploy to production', 'Change infrastructure cost by more than 10%'],
      },
      standingOrders: [{ id: 'log-1', text: 'Nothing reaches production without a green pipeline.' }],
      order: 2,
    },
    overseerRole: 'Overseer — platform lead',
    botRoles: ['Pipeline engineer', 'Release engineer', 'Infrastructure engineer'],
    fieldManual: {
      v1: '# Logistics Field Manual\n\n## Deploys\nStaging first, always.\n',
      v2: '# Logistics Field Manual\n\n## Deploys\nStaging first, always. Production deploys need the Commander’s approval.\n\n## Rollback\nKeep the previous release tagged so rollback is one command.\n',
      v2Reason: 'Added rollback procedure after After Action review',
    },
  },
  {
    body: {
      name: 'Inspection',
      slug: 'inspection',
      role: 'QA',
      standingMission: 'Nothing moves forward untested.',
      callsignPrefix: 'I',
      approvalGate: 'backbriefs-and-deploys',
      rulesOfEngagement: {
        mayDoAlone: ['Run any test suite', 'Send work back to Engineers with a reason'],
        mustEscalate: ['Waiving a failing test'],
      },
      standingOrders: [{ id: 'ins-1', text: 'A failed check goes back to Engineers with the reason.' }],
      order: 3,
    },
    overseerRole: 'Overseer — test lead',
    botRoles: ['Test engineer', 'Test engineer', 'Exploratory tester'],
    fieldManual: {
      v1: '# Inspection Field Manual\n\n## Test plans\nEvery mission gets a written test plan.\n',
      v2: '# Inspection Field Manual\n\n## Test plans\nEvery mission gets a written test plan before Engineers hand over.\n\n## Send-backs\nState the failing check and how to reproduce it.\n',
      v2Reason: 'Clarified timing of test plans and send-back format',
    },
  },
  {
    body: {
      name: 'Guard',
      slug: 'guard',
      role: 'Security',
      standingMission: 'Nothing ships with a known vulnerability.',
      callsignPrefix: 'G',
      approvalGate: 'backbriefs-and-deploys',
      rulesOfEngagement: {
        mayDoAlone: ['Run dependency and static scans', 'Block a release on a high-severity finding'],
        mustEscalate: ['Accepting a known vulnerability', 'Rotating production credentials'],
      },
      standingOrders: [{ id: 'grd-1', text: 'High and critical findings block release.' }],
      order: 4,
    },
    overseerRole: 'Overseer — security lead',
    botRoles: ['Security reviewer', 'Dependency auditor', 'Penetration tester'],
    fieldManual: {
      v1: '# Guard Field Manual\n\n## Scans\nRun the dependency audit on every branch.\n',
      v2: '# Guard Field Manual\n\n## Scans\nRun the dependency audit and the static scan on every branch.\n\n## Secrets\nCredentials are referenced by name only. Report any value you see in a log immediately.\n',
      v2Reason: 'Added static scan and secrets-handling rule',
    },
  },
];

export interface SeedResult {
  seeded: boolean;
  units: number;
  bots: number;
  tasks: number;
}

/** Creates the demo force if the record has no units yet. Idempotent. */
export async function seedDemoForce(app: INestApplication): Promise<SeedResult> {
  const record = app.get(RecordService);
  const existing = await record.listActive('unit');
  if (existing.length) return { seeded: false, units: existing.length, bots: 0, tasks: 0 };

  const config = app.get<AppConfig>(APP_CONFIG);
  const force = app.get(ForceService);
  const work = app.get(WorkService);
  const docs = app.get(DocumentsService);
  const supply = app.get(SupplyService);
  const runner = app.get(TaskRunner);

  // Supply: a small demo repository and a credential for it.
  const sourcePath = await createDemoRepo(join(config.workspacesDir, 'source', 'demo-app'));
  const repo = await supply.connectRepository({ name: 'demo-app', location: sourcePath }, { ...SEED, reason: 'Demo repository connected' });
  const tokenName = 'demo-app-push-token';
  await supply.storeCredential(
    { name: tokenName, value: `demo-${randomBytes(18).toString('base64url')}` },
    { ...SEED, reason: 'Demo credential stored' },
  );

  const unitIds: Record<string, string> = {};
  const botIds: Record<string, string[]> = {};
  let botCount = 0;
  for (const u of UNITS) {
    const unitId = randomUUID();
    const overseerId = randomUUID();
    unitIds[u.body.slug] = unitId;
    await force.createUnit({ ...u.body, overseerBotId: overseerId, supplyIds: u.body.slug === 'engineers' ? [repo.entityId] : [] }, SEED, unitId);
    await force.createBot(
      { unitId, callsign: `${u.body.callsignPrefix}-0`, role: u.overseerRole, isOverseer: true, status: 'idle', currentTaskId: null, queue: [], runtime: 'simulated' },
      SEED,
      overseerId,
    );
    botIds[u.body.slug] = [];
    for (const [i, role] of u.botRoles.entries()) {
      const b = await force.createBot(
        { unitId, callsign: `${u.body.callsignPrefix}-${i + 1}`, role, isOverseer: false, status: 'idle', currentTaskId: null, queue: [], runtime: 'simulated' },
        SEED,
      );
      botIds[u.body.slug]!.push(b.entityId);
      botCount++;
    }
    const fm = await docs.create({ kind: 'field-manual', unitId, title: `${u.body.name} Field Manual`, markdown: u.fieldManual.v1 }, SEED);
    await docs.revise(fm.entityId, { markdown: u.fieldManual.v2, reason: u.fieldManual.v2Reason, expectedVersion: 1 }, `bot:${overseerId}`);
  }

  // One operation in flight.
  const op = await work.createOperation(
    { name: 'Gatekeeper', intent: 'Stop credential-stuffing on the login endpoint without locking out real users.', phase: 'execution', supplyIds: [repo.entityId] },
    { ...SEED, reason: 'Commander stated intent' },
  );
  const mission = (slug: string, goal: string, dod: string[], status: 'planning' | 'working') =>
    work.createMission({ operationId: op.entityId, unitId: unitIds[slug]!, goal, definitionOfDone: dod, status }, SEED);
  const engMission = await mission('engineers', 'Add rate limiting to the login endpoint', ['Limiter in place', 'Configurable per environment', 'Tests green'], 'working');
  const insMission = await mission('inspection', 'Prove rate limiting holds under load', ['Test plan written', 'Load test passes'], 'planning');
  await mission('guard', 'Review rate limiting for bypasses', ['No high-severity findings'], 'planning');
  await mission('logistics', 'Deploy rate limiting to production', ['Staging deploy green', 'Production deploy approved and done'], 'planning');

  const e = botIds['engineers']!;
  const task = (title: string, botId: string, scenario: string | null, description: string) =>
    work.createTask(
      {
        unitId: unitIds['engineers']!,
        botId,
        missionId: engMission.entityId,
        title,
        description,
        repoSupplyId: repo.entityId,
        credentialNames: [tokenName],
        scenario,
        budgetLimitUnits: 20,
      },
      { ...SEED, reason: 'Overseer issued task' },
    );
  const t1 = await task('Add rate limiter middleware', e[0]!, 'happy-path', 'Token-bucket limiter on POST /login keyed by IP and username.');
  const t2 = await task('Wire limiter settings into environment config', e[1]!, 'blocked-on-dependency', 'Read limits from env; defaults for dev.');
  const t3 = await task('Update login tests for rate limiting', e[2]!, 'tests-fail', 'Cover limit reached, reset window and allow-list.');
  await task('Document rate limits in the README', e[0]!, 'happy-path', 'Short section for operators.');
  await work.createTask(
    {
      unitId: unitIds['inspection']!,
      botId: botIds['inspection']![0]!,
      missionId: insMission.entityId,
      title: 'Write the rate-limiting test plan',
      description: 'Cover burst, sustained and distributed attacks.',
      repoSupplyId: repo.entityId,
      credentialNames: [],
      scenario: 'happy-path',
      budgetLimitUnits: 10,
    },
    { ...SEED, reason: 'Overseer issued task' },
  );

  // Play out three tasks so the ORBAT has a done task, a blocked bot and a failed task.
  for (const t of [t1, t2, t3]) {
    const h = await runner.start(t.entityId, 'system:seed');
    await h.finished;
  }

  return { seeded: true, units: UNITS.length, bots: botCount + UNITS.length, tasks: 5 };
}

async function createDemoRepo(path: string): Promise<string> {
  if (existsSync(join(path, '.git'))) return path;
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(path, 'README.md'), '# demo-app\n\nA tiny login service used by the ORBOT demo force.\n');
  await writeFile(
    join(path, 'src', 'login.js'),
    "export function login(username, password, users) {\n  const u = users.get(username);\n  return Boolean(u && u.password === password);\n}\n",
  );
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'demo-app', version: '0.1.0', type: 'module' }, null, 2) + '\n');
  await git(path, ['init', '--quiet', '-b', 'main']);
  await git(path, ['add', '-A']);
  await git(path, ['commit', '--quiet', '-m', 'Initial commit']);
  return path;
}
