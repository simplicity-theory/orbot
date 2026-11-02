import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CreateTaskRequest,
  type ChatSendResult,
  type OperationDetailView,
  type RecordEvent,
  type TaskDetailView,
  type TaskView,
} from '@orbot/shared';
import { git } from '../src/common/git.js';
import { WorkService } from '../src/domain/work.service.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Recon: a bot surveys the code to answer a question, changes nothing, and files
 * a report with its unit. Later work is briefed with it, and HQ can recon before planning.
 */
describe('Recon', () => {
  let t: TestApp;
  let repoId: string;
  let repoPath: string;
  let engId: string;
  let e1: string;

  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const finished = (id: string) =>
    waitFor(async () => {
      const d = await detail(id);
      return ['done', 'blocked', 'failed'].includes(d.task.status) ? d : null;
    });

  beforeAll(async () => {
    t = await startTestApp();
    repoPath = await makeRepo();
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(
      join(repoPath, 'src', 'login.ts'),
      '// Login handler. No rate limit yet: every attempt reaches the password check.\nexport function login() {}\n',
    );
    writeFileSync(join(repoPath, 'src', 'session.ts'), 'export const sessions = new Map();\n');
    await git(repoPath, ['add', '-A']);
    await git(repoPath, ['commit', '--quiet', '-m', 'login']);
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: repoPath })
        .expect(201)
    ).body.id;
    const eng = await makeUnitWithBot(t.app, { supplyIds: [repoId], bots: 2 });
    engId = eng.unit.entityId;
    e1 = eng.bots[0]!.entityId;
  });
  afterAll(() => t.close());

  let report: string;

  it('a recon answers the question with a report filed for the unit, and changes nothing', async () => {
    const task: TaskView = (
      await t.agent
        .post('/api/recon')
        .send({ unitId: engId, question: 'Where is the login rate limit enforced?' })
        .expect(201)
    ).body;
    expect(task).toMatchObject({
      kind: 'recon',
      title: 'Recon: Where is the login rate limit enforced?',
      repoSupplyId: repoId,
      autoStart: true,
    });
    const d = await finished(task.id);
    expect(d.task.status).toBe('done');
    expect(d.report).toMatchObject({
      kind: 'recon',
      unitId: engId,
      title: 'Recon: Where is the login rate limit enforced',
    });
    expect(d.report!.markdown).toContain('## What I found');
    expect(d.report!.markdown).toContain('`src/login.ts` — mentions login, rate, limit');
    expect(d.report!.markdown).not.toContain('session.ts');
    report = d.report!.id;
    // Read-only: the branch has nothing new on it.
    expect(
      await git(d.task.workspace!.path, [
        'rev-list',
        '--count',
        `${d.task.workspace!.baseCommit}..HEAD`,
      ]),
    ).toBe('0');
    // It is one of the unit's documents.
    const unit = (await t.agent.get(`/api/units/${engId}`).expect(200)).body;
    expect(unit.documents.map((x: { id: string }) => x.id)).toContain(report);
  });

  it('later work on the same ground is briefed with the report', async () => {
    const work = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: engId,
          botId: e1,
          title: 'Add a rate limit to login',
          description: 'Cap login attempts per minute.',
          repoSupplyId: repoId,
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${work.id}/run`).expect(202);
    const d = await finished(work.id);
    const brief = d.events.find((e) => e.kind === 'task.briefed') as RecordEvent<'task.briefed'>;
    expect(brief.body.reconDocumentIds).toEqual([report]);
  });

  it('a recon task that tries to change the code is held by policy', async () => {
    const record = t.app.get(RecordService);
    const bots = (await record.listActive('bot', { unitId: engId })).filter(
      (b) => !b.body.isOverseer,
    );
    const number = await record.nextTaskNumber();
    const task = await record.transaction((w) =>
      t.app.get(WorkService).writeTask(
        w,
        number,
        {
          ...CreateTaskRequest.parse({
            unitId: engId,
            botId: bots[1]!.entityId,
            title: 'Recon: sneak a change in',
            repoSupplyId: repoId,
            scenario: 'happy-path',
          }),
          kind: 'recon',
        },
        { actor: 'system:test', reason: 'Test fixture' },
      ),
    );
    await t.agent.post(`/api/tasks/${task.entityId}/run`).expect(202);
    const d = await finished(task.entityId);
    expect(d.task.status).toBe('blocked');
    expect(d.task.statusReason).toBe(
      'Held by policy: Recon is read-only: a recon task may not change the code',
    );
    expect(d.events.some((e) => e.kind === 'artifact')).toBe(false);
  });

  it('chat sends a unit on recon, with Undo calling it off', async () => {
    await settled(t.app);
    const r: ChatSendResult = (
      await t.agent
        .post(`/api/chat/${engId}`)
        .send({ text: 'Recon the app repo: how are sessions stored?' })
        .expect(201)
    ).body;
    const item = r.readback.body.items[0]!;
    expect(item.summary).toMatch(
      /^Engineers sent a bot on recon \(task #\d+\): “How are sessions stored”/,
    );
    expect(item.reversible).toBe(true);
    const id = item.links[0]!.link.split('/').at(-1)!;
    const d = await finished(id);
    expect(d.task.kind).toBe('recon');
    expect(d.report!.markdown).toContain('`src/session.ts` — mentions sessions');
  });

  it('HQ can recon before planning: the plan follows the report', async () => {
    await settled(t.app);
    const op = (
      await t.agent
        .post('/api/operations')
        .send({
          intent: 'Rate limit the login endpoint.',
          name: 'Throttle',
          reconFirst: true,
          supplyIds: [repoId],
        })
        .expect(201)
    ).body;
    const view = await waitFor(async () => {
      const v: OperationDetailView = (await t.agent.get(`/api/operations/${op.id}`).expect(200))
        .body;
      return v.missions.length ? v : null;
    });
    expect(view.operation.reconTaskId).not.toBeNull();
    const recon = await detail(view.operation.reconTaskId!);
    expect(recon.task).toMatchObject({ kind: 'recon', unitId: engId, status: 'done' });
    expect(recon.task.description).toBe('What would it take to: Rate limit the login endpoint?');
    expect(view.missions[0]!.mission.definitionOfDone).toContain(
      'Accounts for the recon findings (What would it take to: Rate limit the login endpoint)',
    );
    const texts = view.timeline
      .filter((e) => e.kind === 'sitrep')
      .map((e) => (e as RecordEvent<'sitrep'>).body.text);
    expect(texts).toContainEqual(
      expect.stringMatching(
        /^HQ sent Engineers on recon \(task #\d+\) before planning Operation Throttle/,
      ),
    );
  });
});
