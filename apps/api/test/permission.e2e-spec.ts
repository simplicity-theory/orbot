import type {
  ApprovalsView,
  BotEvent,
  ChatSendResult,
  RecordEvent,
  RunContext,
  TaskBrief,
  TaskDetailView,
  TaskView,
} from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, SpyRuntime, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/** Keeps every brief the bots were handed. */
class BriefSpy extends SpyRuntime {
  readonly briefs: TaskBrief[] = [];
  override run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    this.briefs.push(brief);
    return super.run(brief, ctx);
  }
}

const RULE = 'Adding a new dependency';

/**
 * Rules of engagement: a bot is briefed with what it may do alone and what it must escalate.
 * Before doing something it must escalate, it asks permission: the task waits (awaiting
 * approval, in Needs you) until the Commander or the unit's Captain decides, then resumes with
 * the decision in its brief. No bot decides its own unit's request.
 */
describe('Rules of engagement: permission requests', () => {
  let t: TestApp;
  let spy: BriefSpy;
  let repoId: string;
  let engId: string;
  let botId: string;

  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const asking = async (title: string): Promise<TaskView> => {
    const x: TaskView = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: engId,
          botId,
          title,
          description: 'Format dates in the report.',
          repoSupplyId: repoId,
          scenario: 'needs-permission',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${x.id}/run`).expect(202);
    await waitFor(async () => (await detail(x.id)).task.status === 'awaiting-approval');
    await settled(t.app);
    return x;
  };
  const statuses = (d: TaskDetailView) =>
    d.events
      .filter((e) => e.kind === 'task.status')
      .map((e) => (e as RecordEvent<'task.status'>).body.to);
  const steps = (d: TaskDetailView) =>
    d.events.filter((e) => e.kind === 'bot.step').map((e) => (e as RecordEvent<'bot.step'>).body);

  beforeAll(async () => {
    t = await startTestApp();
    spy = new BriefSpy().install(t.app);
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const eng = await makeUnitWithBot(t.app, { supplyIds: [repoId] });
    engId = eng.unit.entityId;
    botId = eng.bot.entityId;
    await t.app.get(RecordService).revise(
      'unit',
      engId,
      (u) => ({
        ...u,
        rulesOfEngagement: { mayDoAlone: ['Run tests'], mustEscalate: [RULE] },
      }),
      { actor: 'system:test', reason: 'Rules of engagement for the test' },
    );
  });
  afterAll(() => t.close());

  let approved: TaskView;

  it('the bot is briefed with its rules of engagement, asks permission, and the task waits for you', async () => {
    approved = await asking('Format report dates');
    expect(spy.briefs.at(-1)!.unit.rulesOfEngagement).toEqual({
      mayDoAlone: ['Run tests'],
      mustEscalate: [RULE],
    });
    expect(spy.briefs.at(-1)!.permissions).toEqual([]);

    const d = await detail(approved.id);
    expect(d.task).toMatchObject({
      status: 'awaiting-approval',
      statusReason: 'Asks permission: Add a new production dependency',
      permission: {
        action: 'Add a new production dependency',
        rule: RULE,
        status: 'pending',
        by: null,
      },
    });
    expect(statuses(d)).toEqual(['working', 'awaiting-approval']);
    expect(d.events.some((e) => e.kind === 'permission.requested')).toBe(true);
    // The bot moves on while it waits (D101); the task resumes from its handover and worktree.
    expect(d.bot).toMatchObject({ status: 'idle', currentTaskId: null });

    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    const item = inbox.attention.find((a) => a.entityId === approved.id);
    expect(item).toMatchObject({
      kind: 'awaiting-approval',
      action: 'decide-permission',
      label: `E-1 asks permission on #${approved.number}: Add a new production dependency`,
      permission: { rule: RULE, status: 'pending' },
    });
  });

  it('no bot decides its own unit’s request, and a refusal must say why', async () => {
    await expect(
      t.app
        .get(RecordService)
        .revise(
          'task',
          approved.id,
          (b) => ({ ...b, permission: { ...b.permission!, status: 'approved' } }),
          { actor: `bot:${botId}`, reason: 'Approving myself' },
        ),
    ).rejects.toThrow(/cannot approve its own work/);
    const r = await t.agent
      .post(`/api/tasks/${approved.id}/permission-decision`)
      .send({ approve: false })
      .expect(400);
    expect(JSON.stringify(r.body)).toContain('Say why you refuse');
    expect((await detail(approved.id)).task.permission?.status).toBe('pending');
  });

  it('approved: the bot picks the task up with the decision in its brief and goes ahead', async () => {
    await t.agent
      .post(`/api/tasks/${approved.id}/permission-decision`)
      .send({ approve: true, note: 'Use date-fns.' })
      .expect(200);
    const d = await waitFor(async () => {
      const x = await detail(approved.id);
      return x.task.status === 'done' ? x : null;
    });
    await settled(t.app);
    expect(d.task.permission).toMatchObject({
      status: 'approved',
      by: expect.stringMatching(/^commander:/),
      note: 'Use date-fns.',
    });
    expect(statuses(d)).toEqual(['working', 'awaiting-approval', 'blocked', 'working', 'done']);
    expect(spy.briefs.at(-1)!.permissions).toEqual([
      { action: 'Add a new production dependency', approved: true, note: 'Use date-fns.' },
    ]);
    expect(steps(d)).toContainEqual(
      expect.objectContaining({ action: 'read-decision', outcome: 'going ahead' }),
    );
    const files = d.events
      .filter((e) => e.kind === 'artifact')
      .map((e) => (e as RecordEvent<'artifact'>).body.ref);
    expect(files).toContain(`orbot/task-${approved.number}-dependency.md`);
    // Decided once: a second decision is refused.
    await t.agent
      .post(`/api/tasks/${approved.id}/permission-decision`)
      .send({ approve: true })
      .expect(409);
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention.some((a) => a.entityId === approved.id)).toBe(false);
  });

  it('refused in chat: the bot leaves the refused work out and carries on', async () => {
    const x = await asking('Format invoice dates');
    const r: ChatSendResult = (
      await t.agent
        .post(`/api/chat/${engId}`)
        .send({ text: 'Refuse the request: use the standard library instead' })
        .expect(201)
    ).body;
    expect(r.readback.body.items[0]!.summary).toBe(
      `Permission refused to task #${x.number} (Engineers): Add a new production dependency.`,
    );
    const d = await waitFor(async () => {
      const v = await detail(x.id);
      return v.task.status === 'done' ? v : null;
    });
    await settled(t.app);
    expect(d.task.permission).toMatchObject({
      status: 'refused',
      note: 'use the standard library instead',
    });
    expect(steps(d)).toContainEqual(
      expect.objectContaining({ action: 'read-decision', outcome: 'will not do it' }),
    );
    const files = d.events
      .filter((e) => e.kind === 'artifact')
      .map((e) => (e as RecordEvent<'artifact'>).body.ref);
    expect(files).not.toContain(`orbot/task-${x.number}-dependency.md`);
    // On the record for good: the request and the decision.
    const decided = d.events.filter((e) => e.kind === 'permission.decided');
    expect(decided.map((e) => (e as RecordEvent<'permission.decided'>).body)).toEqual([
      {
        action: 'Add a new production dependency',
        approve: false,
        note: 'use the standard library instead',
      },
    ]);
  });
});
