import type {
  ApprovalsView,
  BudgetView,
  ChatSendResult,
  OperationDetailView,
  RecordEvent,
  TaskDetailView,
  TaskView,
} from '@orbot/shared';
import { WorkService } from '../src/domain/work.service.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Budget caps: a hard limit per unit, per operation and per task, with a warning
 * first. Every run of `happy-path` spends 4 units (3, then 1).
 */
describe('Budget caps', () => {
  let t: TestApp;
  let repoId: string;
  let unitId: string;
  let botId: string;

  const run = async (over: Record<string, unknown> = {}): Promise<TaskView> => {
    const task: TaskView = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Add an audit field', repoSupplyId: repoId, ...over })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    return task;
  };
  const settledTask = (id: string) =>
    waitFor(async () => {
      const d: TaskDetailView = (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
      return ['done', 'blocked', 'failed'].includes(d.task.status) ? d : null;
    });
  const events = async (kinds: string, q: Record<string, string> = {}) =>
    (
      await t.agent
        .get('/api/record/events')
        .query({ kinds, ...q })
        .expect(200)
    ).body as RecordEvent[];

  beforeAll(async () => {
    t = await startTestApp();
    // Caps hold work only once compute limits are on (off by default, D114).
    const st = (await t.agent.get('/api/settings').expect(200)).body;
    await t.agent
      .put('/api/settings')
      .send({ computeLimits: 'on', reason: 'Test', expectedVersion: st.version })
      .expect(200);
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const fx = await makeUnitWithBot(t.app, { supplyIds: [repoId] });
    unitId = fx.unit.entityId;
    botId = fx.bot.entityId;
  });
  afterAll(() => t.close());

  let held: TaskView;

  it('warns once spending crosses 80% of the unit cap, before stopping anything', async () => {
    const b: BudgetView = (
      await t.agent
        .put(`/api/units/${unitId}/budget`)
        .send({ units: 10, reason: 'Pilot month' })
        .expect(200)
    ).body;
    expect(b).toMatchObject({ cap: 10, spent: 0, state: 'ok' });

    expect((await settledTask((await run()).id)).task.status).toBe('done'); // 4
    expect((await settledTask((await run()).id)).task.status).toBe('done'); // 8: warning
    const warnings = await events('budget.warning', { unitId });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.body).toMatchObject({ scope: 'unit', spent: 8, cap: 10 });
    const sitreps = await events('sitrep', { unitId });
    expect(sitreps.map((s) => (s.body as { text: string }).text)).toContain(
      'Budget warning: Engineers has used 8 of 10 compute units (80%). Work stops at the cap.',
    );
    const approvals: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(approvals.attention).toContainEqual(
      expect.objectContaining({
        kind: 'budget',
        label: 'Engineers has used 8 of 10 compute units',
      }),
    );
  });

  it('stops a run at the cap: the spend is on the record, and the task is held with the reason', async () => {
    held = await run();
    const d = await settledTask(held.id);
    expect(d.task.status).toBe('blocked');
    expect(d.task.statusReason).toBe(
      'Held by policy: Compute budget cap reached: Engineers has used 11 of 10 units',
    );
    expect(d.task.budget.spentUnits).toBe(3);
    expect(d.events.filter((e) => e.kind === 'cost')).toHaveLength(1);

    const unit = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
    expect(unit.budget).toMatchObject({ cap: 10, spent: 11, state: 'capped' });
  });

  it('refuses to start new work at the cap, saying how to raise it', async () => {
    const task: TaskView = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Another change', repoSupplyId: repoId })
        .expect(201)
    ).body;
    const res = await t.agent.post(`/api/tasks/${task.id}/run`).expect(409);
    expect(res.body.error.message).toContain('Compute budget cap reached');
    expect(res.body.error.action).toContain('Give Engineers 20 more compute budget');
  });

  it('raising the cap in chat releases the held work, and it finishes', async () => {
    const r: ChatSendResult = (
      await t.agent
        .post(`/api/chat/${unitId}`)
        .send({ text: 'I’ll give you 20 more compute budget.' })
        .expect(201)
    ).body;
    expect(r.readback.body.items[0]!.summary).toBe(
      'Engineers compute budget raised by 20 to 30 units. 1 task(s) held at the cap resumed.',
    );
    const d = await settledTask(held.id);
    expect(d.task.status).toBe('done');
    await settled(t.app);
    const unit = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
    expect(unit.budget).toMatchObject({ cap: 30, spent: 15, state: 'ok' });
  });

  it('a task’s own limit holds just that task', async () => {
    const d = await settledTask((await run({ budgetLimitUnits: 3 })).id);
    expect(d.task.status).toBe('blocked');
    expect(d.task.statusReason).toContain('Task #');
    expect(d.task.statusReason).toContain('has used 3 of 3 units');
  });

  it('an operation’s cap covers every unit in it; raising it on the operation releases the work', async () => {
    const work = t.app.get(WorkService);
    const ctx = { actor: 'system:test', reason: 'fixture' };
    const op = await work.createOperation(
      {
        name: 'Ledger',
        intent: 'Ship the ledger.',
        phase: 'execution',
        supplyIds: [],
        budgetUnits: 2,
      },
      ctx,
    );
    const mission = await work.createMission(
      {
        operationId: op.entityId,
        unitId,
        goal: 'Build the ledger',
        definitionOfDone: ['Ledger exists'],
        status: 'working',
      },
      ctx,
    );
    await t.app
      .get(RecordService)
      .revise('operation', op.entityId, (b) => ({ ...b, missionIds: [mission.entityId] }), ctx);

    const task = await run({ missionId: mission.entityId });
    const d = await settledTask(task.id);
    expect(d.task.status).toBe('blocked');
    expect(d.task.statusReason).toContain('Operation Ledger has used 3 of 2 units');
    let view: OperationDetailView = (
      await t.agent.get(`/api/operations/${op.entityId}`).expect(200)
    ).body;
    expect(view.budget).toMatchObject({ cap: 2, spent: 3, state: 'capped' });
    expect(view.needsYou.map((n) => n.kind)).toContain('budget');

    view = (
      await t.agent
        .put(`/api/operations/${op.entityId}/budget`)
        .send({ units: 50, reason: 'Finance approved more' })
        .expect(200)
    ).body;
    expect((await settledTask(task.id)).task.status).toBe('done');
    const set = await events('budget.set', { operationId: op.entityId });
    expect(set[0]!.body).toMatchObject({ from: 2, to: 50, releasedTaskIds: [task.id] });
  });
});
