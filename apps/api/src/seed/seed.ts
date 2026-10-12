import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { UnitBody } from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { git } from '../common/git.js';
import { FieldManualService } from '../documents/field-manual.service.js';
import { ForceService } from '../domain/force.service.js';
import { WorkService } from '../domain/work.service.js';
import { ColdStartService } from '../overseer/coldstart.service.js';
import { OverseerService } from '../overseer/overseer.service.js';
import { settled } from '../testing/settle.js';
import { ChatService } from '../chat/chat.service.js';
import { TaskRunner } from '../execution/task-runner.js';
import { RecordService } from '../record/record.service.js';
import { SupplyService } from '../supply/supply.service.js';

const SEED = { actor: 'system:seed', reason: 'Demo force seeded' };

interface UnitSeed {
  body: Omit<UnitBody, 'overseerBotId' | 'supplyIds' | 'computeBudget' | 'halt'>;
  overseerRole: string;
  botRoles: string[];
  fieldManual: {
    entries: { title: string; body: string }[];
    /** A later, better wording of one entry (gives it history). */
    refine: { title: string; body: string; reason: string };
    /** A lesson added later. */
    add: { title: string; body: string; reason: string };
  };
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
        mayDoAlone: [
          'Create branches and commits in the task workspace',
          'Run tests',
          'Refactor within the task scope',
        ],
        mustEscalate: [
          'Changing a public API',
          'Adding a new dependency',
          'Anything touching authentication',
        ],
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
      entries: [
        { title: 'Branching', body: 'Work on `orbot/task-<n>` branches cut from main.' },
        { title: 'Tests', body: 'Run the unit suite before handing over.' },
      ],
      refine: {
        title: 'Tests',
        body: 'Run the unit suite before handing over. Warm the test cache first: the suite is slow on a cold cache.',
        reason: 'Promoted a lesson from a task handover',
      },
      add: {
        title: 'Fixtures',
        body: 'Shared fixtures live in `test/fixtures`; never edit one without checking who else uses it.',
        reason: 'Promoted a lesson from a task handover',
      },
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
      standingOrders: [
        { id: 'log-1', text: 'Nothing reaches production without a green pipeline.' },
      ],
      order: 2,
    },
    overseerRole: 'Overseer — platform lead',
    botRoles: ['Pipeline engineer', 'Release engineer', 'Infrastructure engineer'],
    fieldManual: {
      entries: [{ title: 'Deploys', body: 'Staging first, always.' }],
      refine: {
        title: 'Deploys',
        body: 'Staging first, always. Production deploys need the Commander’s approval.',
        reason: 'Production deploys are an approval gate',
      },
      add: {
        title: 'Rollback',
        body: 'Keep the previous release tagged so rollback is one command.',
        reason: 'Added rollback procedure after After Action review',
      },
    },
  },
  {
    body: {
      name: 'Inspection',
      slug: 'inspection',
      role: 'QA',
      standingMission: 'Nothing moves forward untested.',
      callsignPrefix: 'I',
      // Shows the approval-gate setting: Inspection's plans don't wait for the Commander.
      approvalGate: 'escalations-only',
      rulesOfEngagement: {
        mayDoAlone: ['Run any test suite', 'Send work back to Engineers with a reason'],
        mustEscalate: ['Waiving a failing test'],
      },
      standingOrders: [
        { id: 'ins-1', text: 'A failed check goes back to Engineers with the reason.' },
      ],
      order: 3,
    },
    overseerRole: 'Overseer — test lead',
    botRoles: ['Test engineer', 'Test engineer', 'Exploratory tester'],
    fieldManual: {
      entries: [{ title: 'Test plans', body: 'Every mission gets a written test plan.' }],
      refine: {
        title: 'Test plans',
        body: 'Every mission gets a written test plan before Engineers hand over.',
        reason: 'Clarified timing of test plans',
      },
      add: {
        title: 'Send-backs',
        body: 'State the failing check and how to reproduce it.',
        reason: 'Clarified send-back format',
      },
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
        mayDoAlone: [
          'Run dependency and static scans',
          'Block a release on a high-severity finding',
        ],
        mustEscalate: ['Accepting a known vulnerability', 'Rotating production credentials'],
      },
      standingOrders: [
        { id: 'grd-1', text: 'High and critical findings block release.' },
        { id: 'grd-2', text: 'Low-severity findings also block release.' },
      ],
      order: 4,
    },
    overseerRole: 'Overseer — security lead',
    botRoles: ['Security reviewer', 'Dependency auditor', 'Penetration tester'],
    fieldManual: {
      entries: [{ title: 'Scans', body: 'Run the dependency audit on every branch.' }],
      refine: {
        title: 'Scans',
        body: 'Run the dependency audit and the static scan on every branch.',
        reason: 'Added the static scan',
      },
      add: {
        title: 'Secrets',
        body: 'Credentials are referenced by name only. Report any value you see in a log immediately.',
        reason: 'Added secrets-handling rule',
      },
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
  const supply = app.get(SupplyService);
  const fieldManual = app.get(FieldManualService);
  const overseer = app.get(OverseerService);
  const coldStart = app.get(ColdStartService);

  // Supply: a small demo repository and a credential for it, issued to Engineers and Inspection.
  const sourcePath = await createDemoRepo(join(config.workspacesDir, 'source', 'demo-app'));
  const repo = await supply.connectRepository(
    { name: 'demo-app', location: sourcePath },
    { ...SEED, reason: 'Demo repository connected' },
  );
  const tokenName = 'demo-app-push-token';
  const token = await supply.storeCredential(
    { name: tokenName, value: `demo-${randomBytes(18).toString('base64url')}` },
    { ...SEED, reason: 'Demo credential stored' },
  );

  // In the depot but not issued to anyone yet: the payments service and production.
  const paymentsPath = await createDemoRepo(
    join(config.workspacesDir, 'source', 'payments-service'),
    'payments-service',
  );
  await supply.connectRepository(
    { name: 'payments-service', location: paymentsPath },
    { ...SEED, reason: 'Payments repository connected' },
  );
  await supply.connectEnvironment(
    { name: 'production', tier: 'production' },
    { ...SEED, reason: 'Production environment connected' },
  );

  const unitIds: Record<string, string> = {};
  const botIds: Record<string, string[]> = {};
  let botCount = 0;
  for (const u of UNITS) {
    const unitId = randomUUID();
    const overseerId = randomUUID();
    unitIds[u.body.slug] = unitId;
    const supplied = ['engineers', 'inspection'].includes(u.body.slug)
      ? [repo.entityId, token.entityId]
      : u.body.slug === 'guard'
        ? [repo.entityId]
        : [];
    await force.createUnit(
      { ...u.body, overseerBotId: overseerId, supplyIds: supplied, computeBudget: 20 },
      SEED,
      unitId,
    );
    const base = {
      unitId,
      status: 'idle' as const,
      currentTaskId: null,
      queue: [],
      runtime: 'simulated',
    };
    await force.createBot(
      { ...base, callsign: `${u.body.callsignPrefix}-0`, role: u.overseerRole, isOverseer: true },
      SEED,
      overseerId,
    );
    botIds[u.body.slug] = [];
    for (const [i, role] of u.botRoles.entries()) {
      const b = await force.createBot(
        { ...base, callsign: `${u.body.callsignPrefix}-${i + 1}`, role, isOverseer: false },
        SEED,
      );
      botIds[u.body.slug]!.push(b.entityId);
      botCount++;
    }

    // Field Manual: initial entries, then a refinement and a later lesson, so it has history.
    const source = {
      kind: 'commander' as const,
      id: null,
      version: null,
      label: 'Seeded with the demo force',
    };
    const overseerCtx = (reason: string) => ({ actor: `bot:${overseerId}`, reason });
    const ids = await record.transaction(async (w) => {
      const created = [];
      for (const e of u.fieldManual.entries) {
        created.push(
          await fieldManual.promote(w, unitId, { ...e, tags: [], pinned: false }, source, {
            ...SEED,
            reason: 'Initial Field Manual',
          }),
        );
      }
      await fieldManual.rerender(w, unitId, { ...SEED, reason: 'Initial Field Manual' });
      return created;
    });
    const refine = ids.find((e) => e.body.title === u.fieldManual.refine.title)!;
    await record.transaction(async (w) => {
      await fieldManual.edit(
        w,
        refine.entityId,
        { body: u.fieldManual.refine.body },
        source,
        overseerCtx(u.fieldManual.refine.reason),
      );
      await fieldManual.rerender(w, unitId, overseerCtx(u.fieldManual.refine.reason));
    });
    await record.transaction(async (w) => {
      await fieldManual.promote(
        w,
        unitId,
        { title: u.fieldManual.add.title, body: u.fieldManual.add.body, tags: [], pinned: false },
        source,
        overseerCtx(u.fieldManual.add.reason),
      );
      await fieldManual.rerender(w, unitId, overseerCtx(u.fieldManual.add.reason));
    });
  }

  // One operation in flight. Its missions go to the units' Overseers, who draft backbriefs.
  const op = await work.createOperation(
    {
      name: 'Gatekeeper',
      intent: 'Stop credential-stuffing on the login endpoint without locking out real users.',
      phase: 'execution',
      supplyIds: [repo.entityId],
    },
    { ...SEED, reason: 'Commander stated intent' },
  );
  const mission = (slug: string, goal: string, dod: string[]) =>
    record.create(
      'mission',
      {
        operationId: op.entityId,
        unitId: unitIds[slug]!,
        goal,
        definitionOfDone: dod,
        status: 'planning',
      },
      { ...SEED, reason: 'Mission issued' },
    );

  // Engineers: the plan comes back for approval; it is approved with scenarios that exercise the failure paths.
  const eng = await mission('engineers', 'Add rate limiting to the login endpoint', [
    'Add rate limiter middleware',
    'Wire limiter settings into environment config',
    'Update login tests for rate limiting',
  ]);
  await settled(app);
  const [engBrief] = await record.listActive('backbrief', {
    bodyContains: { missionId: eng.entityId },
  });
  await overseer.amend(
    engBrief!.entityId,
    {
      proposedTasks: engBrief!.body.proposedTasks.map((t, i) => ({
        ...t,
        scenario: ['happy-path', 'blocked-on-dependency', 'tests-fail'][i] ?? 'happy-path',
      })),
      note: 'Demo: exercise the blocked and failed paths too.',
      expectedVersion: engBrief!.version,
    },
    'system:seed',
  );
  await settled(app);

  // Inspection runs on "escalations only": its plan is approved automatically and executed.
  await mission('inspection', 'Prove rate limiting holds under load', [
    'Write the rate-limiting test plan',
  ]);
  await settled(app);

  // A second Engineers mission, left awaiting the Commander's approval.
  await mission('engineers', 'Harden session handling', [
    'Rotate session ids on login',
    'Expire idle sessions after 30 minutes',
  ]);
  await settled(app);

  // A queued task issued directly to E-1, to start by hand from the UI.
  await work.createTask(
    {
      unitId: unitIds['engineers']!,
      botId: botIds['engineers']![0]!,
      missionId: eng.entityId,
      title: 'Document rate limits in the README',
      description: 'Short section for operators.',
      repoSupplyId: repo.entityId,
      credentialNames: [tokenName],
      scenario: 'happy-path',
      budgetLimitUnits: 10,
      continuesTaskId: null,
    },
    { ...SEED, reason: 'Issued directly by the Commander' },
  );

  // Guard: two tasks held up — one by a standing order, one waiting for the payments repo.
  // One chat message ("Stop blocking on low-severity findings. I'll give you access to the
  // payments repo.") clears both.
  for (const [i, [title, scenario]] of [
    ['Security review of the login change', 'guard-review'],
    ['Review payments token handling', 'needs-supply'],
  ].entries()) {
    const t = await work.createTask(
      {
        unitId: unitIds['guard']!,
        botId: botIds['guard']![i]!,
        missionId: null,
        title: title!,
        description: '',
        repoSupplyId: repo.entityId,
        credentialNames: [],
        scenario: scenario!,
        budgetLimitUnits: 10,
        continuesTaskId: null,
      },
      { ...SEED, reason: 'Issued directly by the Commander' },
    );
    await app.get(TaskRunner).start(t.entityId, 'system:seed');
  }
  await settled(app);

  // A short chat history, through the real chat path.
  await app
    .get(ChatService)
    .send(
      unitIds['engineers']!,
      'How far along is the login rate limiting?',
      'commander:commander',
    );

  await coldStart.check(unitIds['engineers']!);
  await settled(app);

  const tasks = await record.listActive('task');
  return { seeded: true, units: UNITS.length, bots: botCount + UNITS.length, tasks: tasks.length };
}

async function createDemoRepo(path: string, name = 'demo-app'): Promise<string> {
  if (existsSync(join(path, '.git'))) return path;
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(
    join(path, 'README.md'),
    `# ${name}\n\nA tiny service used by the ORBOT demo force.\n`,
  );
  await writeFile(
    join(path, 'src', 'login.js'),
    'export function login(username, password, users) {\n  const u = users.get(username);\n  return Boolean(u && u.password === password);\n}\n',
  );
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({ name, version: '0.1.0', type: 'module' }, null, 2) + '\n',
  );
  await git(path, ['init', '--quiet', '-b', 'main']);
  await git(path, ['add', '-A']);
  await git(path, ['commit', '--quiet', '-m', 'Initial commit']);
  return path;
}
