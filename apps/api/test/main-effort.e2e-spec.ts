import {
  CreateTaskRequest,
  type ChatSendResult,
  type MainEffortView,
  type RecordEvent,
  type TaskDetailView,
} from '@orbot/shared';
import { WorkService } from '../src/domain/work.service.js';
import { StandDownService } from '../src/overseer/stand-down.service.js';
import { MainEffortService } from '../src/overseer/main-effort.service.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Main Effort: one operation the force puts first. Its tasks start before
 * supporting work; a ready main-effort task moves to a free bot, or supporting work an
 * Overseer dispatched pauses (with a handover) to make way. Commander-started work never does.
 */
describe('Main effort', () => {
  let t: TestApp;
  let record: RecordService;
  let repoId: string;
  let engId: string;
  let e1: string;
  let e2: string;
  let inspId: string;
  let i1: string;
  let login: string;
  let audit: string;
  const missions: Record<string, string> = {};
  const SYS = { actor: 'system:test', reason: 'Test fixture' };

  const view = async (): Promise<MainEffortView> =>
    (await t.agent.get('/api/main-effort').expect(200)).body;
  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const status = (id: string, want: string) =>
    waitFor(async () => {
      const d = await detail(id);
      return d.task.status === want ? d : null;
    });

  /** A task as an Overseer issues it (auto-start), or as the Commander does (`auto: false`). */
  const issue = async (
    unitId: string,
    botId: string,
    title: string,
    opts: { missionId?: string; scenario?: string; auto?: boolean } = {},
  ) => {
    const work = t.app.get(WorkService);
    const number = await record.nextTaskNumber();
    return record.transaction((w) =>
      work.writeTask(
        w,
        number,
        {
          ...CreateTaskRequest.parse({
            unitId,
            botId,
            title,
            repoSupplyId: repoId,
            missionId: opts.missionId ?? null,
            scenario: opts.scenario ?? null,
          }),
          autoStart: opts.auto ?? true,
        },
        SYS,
      ),
    );
  };
  const operation = async (name: string, units: string[]) => {
    const op = await record.create(
      'operation',
      { name, intent: `${name}.`, phase: 'execution', supplyIds: [], missionIds: [] },
      SYS,
    );
    const ids: string[] = [];
    for (const unitId of units) {
      const m = await record.create(
        'mission',
        {
          operationId: op.entityId,
          unitId,
          goal: `${name} (${unitId === engId ? 'build' : 'inspect'})`,
          definitionOfDone: ['Done'],
          status: 'working',
        },
        SYS,
      );
      missions[`${name}:${unitId}`] = m.entityId;
      ids.push(m.entityId);
      // One task nobody starts keeps the mission open, so HQ doesn't move the operation on.
      await t.agent
        .post('/api/tasks')
        .send({ unitId, missionId: m.entityId, title: 'Write the runbook' })
        .expect(201);
    }
    await record.revise('operation', op.entityId, (b) => ({ ...b, missionIds: ids }), SYS);
    return op.entityId;
  };

  beforeAll(async () => {
    t = await startTestApp();
    record = t.app.get(RecordService);
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const eng = await makeUnitWithBot(t.app, { supplyIds: [repoId], bots: 2 });
    engId = eng.unit.entityId;
    e1 = eng.bots[0]!.entityId;
    e2 = eng.bots[1]!.entityId;
    const insp = await makeUnitWithBot(t.app, {
      name: 'Inspection',
      prefix: 'I',
      supplyIds: [repoId],
    });
    inspId = insp.unit.entityId;
    i1 = insp.bot.entityId;
    login = await operation('Login Rate Limiting', [engId, inspId]);
    audit = await operation('Audit Trail', [engId]);
  });
  afterAll(() => t.close());

  it('the Commander names the main effort; every unit hears it; HQ refuses a repeat', async () => {
    expect((await view()).mainEffort).toBeNull();
    const v: MainEffortView = (
      await t.agent
        .put('/api/main-effort')
        .send({ operationId: login, reason: 'The launch is Friday' })
        .expect(200)
    ).body;
    expect(v).toMatchObject({
      mainEffort: { operationId: login, reason: 'The launch is Friday' },
      operation: { id: login, name: 'Login Rate Limiting' },
      yieldEnabled: true,
    });
    expect(v.mainEffort!.by).toMatch(/^commander:/);
    expect(v.missionIds.sort()).toEqual(
      [missions[`Login Rate Limiting:${engId}`], missions[`Login Rate Limiting:${inspId}`]].sort(),
    );
    for (const unitId of [engId, inspId]) {
      const sitreps = (
        await t.agent.get('/api/record/events').query({ kinds: 'sitrep', unitId }).expect(200)
      ).body as RecordEvent<'sitrep'>[];
      expect(sitreps.map((s) => s.body.text)).toContainEqual(
        'HQ: Operation Login Rate Limiting is now the main effort (The launch is Friday). Its tasks go first.',
      );
    }
    await t.agent.put('/api/main-effort').send({ operationId: login, reason: 'Again' }).expect(409);
  });

  it('a bot cannot name the main effort', async () => {
    await expect(
      t.app.get(MainEffortService).set(audit, 'Mine first', `bot:${e1}`),
    ).rejects.toThrow(/cannot change its own unit’s rules/);
    expect((await view()).mainEffort?.operationId).toBe(login);
  });

  it('main-effort tasks start before supporting work queued ahead of them', async () => {
    const sd = t.app.get(StandDownService);
    await sd.standDown({ scope: 'bot', targetId: i1 }, 'Line the work up', 'commander:test');
    const support = await issue(inspId, i1, 'Tidy the test fixtures');
    const main = await issue(inspId, i1, 'Load-test the login limit', {
      missionId: missions[`Login Rate Limiting:${inspId}`],
    });
    const queue = (await record.requireActive('bot', i1)).body.queue;
    expect(queue).toEqual([support.entityId, main.entityId]);
    await sd.lift({ scope: 'bot', targetId: i1 }, 'Go', 'commander:test');
    const [m, s] = await Promise.all([
      status(main.entityId, 'done'),
      status(support.entityId, 'done'),
    ]);
    const started = (d: TaskDetailView) =>
      d.events.find(
        (e) => e.kind === 'task.status' && (e as RecordEvent<'task.status'>).body.to === 'working',
      )!.seq;
    expect(started(m) < started(s)).toBe(true);
  });

  it('a ready main-effort task moves to a free bot when its own is busy', async () => {
    // E-1 is busy with work the Commander started; E-2 is free.
    const busy = await issue(engId, e1, 'Migrate the billing tables', {
      scenario: 'long-haul',
      auto: false,
    });
    await t.agent.post(`/api/tasks/${busy.entityId}/run`).expect(202);
    await status(busy.entityId, 'working');
    const main = await issue(engId, e1, 'Cap login attempts', {
      missionId: missions[`Login Rate Limiting:${engId}`],
    });
    const d = await status(main.entityId, 'done');
    expect(d.task.botId).toBe(e2);
    const moves = (
      await t.agent.get('/api/record/events').query({ kinds: 'main-effort.yield' }).expect(200)
    ).body as RecordEvent<'main-effort.yield'>[];
    expect(moves.map((e) => e.body)).toContainEqual({
      mainEffortTaskId: main.entityId,
      how: 'moved',
      yieldedTaskId: null,
      toBotId: e2,
    });
    // The Commander's own work was not touched.
    expect((await detail(busy.entityId)).task.status).toBe('working');
  });

  it('with no free bot, supporting work pauses with a handover, then resumes after', async () => {
    // E-1 still runs the Commander's task; E-2 now runs supporting work an Overseer dispatched.
    const support = await issue(engId, e2, 'Rewrite the export job', {
      missionId: missions[`Audit Trail:${engId}`],
      scenario: 'long-haul',
    });
    await status(support.entityId, 'working');
    // Queued on E-1, whose work is the Commander's: E-2's supporting work makes way instead.
    const main = await issue(engId, e1, 'Lock out after five failures', {
      missionId: missions[`Login Rate Limiting:${engId}`],
    });
    const d = await status(main.entityId, 'done');
    expect(d.task.botId).toBe(e2);

    const s = await waitFor(async () => {
      const x = await detail(support.entityId);
      return x.task.status === 'done' ? x : null;
    });
    const statuses = s.events
      .filter((e) => e.kind === 'task.status')
      .map((e) => (e as RecordEvent<'task.status'>).body);
    expect(statuses.map((x) => x.to)).toEqual([
      'working',
      'stood-down',
      'queued',
      'working',
      'done',
    ]);
    expect(statuses[1]!.reason).toBe(
      `Made way for the main effort: task #${d.task.number} (Operation Login Rate Limiting) goes first`,
    );
    expect(s.events.some((e) => e.kind === 'main-effort.yield')).toBe(true);
    // Its successor run picked up from the handover the pause wrote.
    const briefs = s.events.filter(
      (e) => e.kind === 'task.briefed',
    ) as RecordEvent<'task.briefed'>[];
    expect(briefs).toHaveLength(2);
    expect(briefs[1]!.body.handoverId).not.toBeNull();
    // The Commander's task on E-1 ran on throughout.
    const busy = (await t.agent.get(`/api/bots/${e1}`).expect(200)).body;
    expect(busy.bot.status).toBe('working');
  });

  it('chat names and clears the main effort, through HQ, with Undo', async () => {
    const send = async (text: string): Promise<ChatSendResult> =>
      (await t.agent.post('/api/chat/hq').send({ text }).expect(201)).body;
    const r = await send('Make the audit trail the main effort.');
    const item = r.readback.body.items[0]!;
    expect(item.summary).toBe(
      'Operation Audit Trail is now the main effort: its tasks go first, and other work makes way for it.',
    );
    expect((await view()).operation?.name).toBe('Audit Trail');

    await t.agent.post(`/api/orders/${item.ordersLogId}/undo`).expect(200);
    expect((await view()).operation?.name).toBe('Login Rate Limiting');

    await send('No main effort any more.');
    expect((await view()).mainEffort).toBeNull();
    await send('Make login rate limiting the main effort.');
    expect((await view()).operation?.name).toBe('Login Rate Limiting');
  });

  it('closing the operation clears the main effort', async () => {
    await record.revise('operation', login, (b) => ({ ...b, phase: 'closed' }), SYS);
    // (E-1 still runs the Commander's long task, so wait for HQ rather than for everything.)
    await waitFor(async () => ((await view()).mainEffort === null ? true : null));
    const events = (
      await t.agent.get('/api/record/events').query({ kinds: 'main-effort' }).expect(200)
    ).body as RecordEvent<'main-effort'>[];
    const last = events.sort((a, b) => a.seq - b.seq).at(-1)!;
    expect(last).toMatchObject({
      actor: 'system:hq',
      body: { operationId: null, previousOperationId: login, reason: 'The operation is closed' },
    });
    await t.agent
      .put('/api/main-effort')
      .send({ operationId: login, reason: 'Back on' })
      .expect(400);
  });

  afterAll(async () => {
    await t.app
      .get(StandDownService)
      .standDown({ scope: 'all', targetId: null }, 'End of test', 'commander:test')
      .catch(() => undefined);
  });
});
