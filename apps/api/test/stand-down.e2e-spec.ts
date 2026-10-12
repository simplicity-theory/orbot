import type { ChatSendResult, StandDownView, TaskDetailView, TaskView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Stand down: halt a bot, a unit or everything. Work pauses with a handover,
 * nothing starts while the order is in force, and lifting it picks the work back up.
 */
describe('Stand down', () => {
  let t: TestApp;
  let repoId: string;
  let engId: string;
  let guardId: string;
  let e1: string;
  let e2: string;
  let g1: string;

  const task = async (unitId: string, botId: string, title: string): Promise<TaskView> =>
    (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title, repoSupplyId: repoId, scenario: 'long-haul' })
        .expect(201)
    ).body;
  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const status = (id: string, want: string) =>
    waitFor(async () => ((await detail(id)).task.status === want ? true : null));

  beforeAll(async () => {
    t = await startTestApp();
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
    const guard = await makeUnitWithBot(t.app, { name: 'Guard', prefix: 'G', supplyIds: [repoId] });
    guardId = guard.unit.entityId;
    g1 = guard.bot.entityId;
  });
  afterAll(() => t.close());

  let t1: TaskView;
  let t2: TaskView;

  it('one bot: its running task pauses with a handover; the other bot keeps working', async () => {
    t1 = await task(engId, e1, 'Migrate the billing tables');
    t2 = await task(engId, e2, 'Rewrite the export job');
    await t.agent.post(`/api/tasks/${t1.id}/run`).expect(202);
    await t.agent.post(`/api/tasks/${t2.id}/run`).expect(202);
    await status(t1.id, 'working');
    await status(t2.id, 'working');

    const view: StandDownView = (
      await t.agent
        .post('/api/stand-down')
        .send({
          scope: 'bot',
          targetId: e1,
          reason: 'Hold billing changes until finance signs off',
        })
        .expect(200)
    ).body;
    expect(view.bots.map((b) => b.id)).toEqual([e1]);
    expect(view.bots[0]!.halt.by).toMatch(/^commander:/);

    const d1 = await detail(t1.id);
    expect(d1.task.status).toBe('stood-down');
    expect(d1.task.statusReason).toBe(
      'Stood down by order: Hold billing changes until finance signs off',
    );
    expect(d1.handover?.markdown).toContain('Stood down mid-task');
    expect(d1.handover?.markdown).toContain(
      `Pick the task up from branch ${d1.task.workspace!.branch}`,
    );
    expect((await detail(t2.id)).task.status).toBe('working');

    const bot = (await t.agent.get(`/api/bots/${e1}`).expect(200)).body.bot;
    expect(bot.status).toBe('idle');
    expect(bot.halt.reason).toBe('Hold billing changes until finance signs off');
  });

  it('nothing starts for a stood-down bot, and the refusal is on the record', async () => {
    const res = await t.agent.post(`/api/tasks/${t1.id}/run`).expect(409);
    expect(res.body.error.message).toContain('Stood down: Hold billing changes');
    expect(res.body.error.action).toContain('Resume work');
    const d = await detail(t1.id);
    expect(d.events.some((e) => e.kind === 'policy.check')).toBe(true);
  });

  it('lifting the order picks the work up again from its handover, and it finishes', async () => {
    await t.agent
      .post('/api/stand-down/lift')
      .send({ scope: 'bot', targetId: e1, reason: 'Finance signed off' })
      .expect(200);
    await status(t1.id, 'done');
    const d = await detail(t1.id);
    // The second run was briefed with the stand-down handover.
    const briefs = d.events.filter((e) => e.kind === 'task.briefed');
    expect(briefs).toHaveLength(2);
    expect(await git(d.task.workspace!.path, ['log', '-1', '--format=%s'])).toContain(
      'Migrate the billing tables',
    );
    expect(d.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['task.status']));
    expect(
      (d.versions as { body: TaskView }[]).some(
        (v) => v.body.status === 'queued' && v.body.statusReason === 'Resumed: Finance signed off',
      ),
    ).toBe(true);
  });

  let chatReply: ChatSendResult;

  it('a unit, by order in chat: the read-back says what paused, and Undo resumes it', async () => {
    chatReply = (
      await t.agent
        .post(`/api/chat/${engId}`)
        .send({ text: 'Stand down until the audit is over.' })
        .expect(201)
    ).body;
    await settled(t.app);
    const rb = chatReply.readback.body;
    expect(rb.text).toBe('Wilco.');
    expect(rb.items[0]!.summary).toBe(
      'Engineers stood down: The audit is over. 1 running task(s) paused with a handover.',
    );
    expect(rb.items[0]!.reversible).toBe(true);
    expect((await detail(t2.id)).task.status).toBe('stood-down');
    const unit = (await t.agent.get(`/api/units/${engId}`).expect(200)).body.unit;
    expect(unit.halt.reason).toBe('The audit is over');

    // A bot of a stood-down unit can't start new work either.
    const t3 = await task(engId, e1, 'Tidy the README');
    await t.agent.post(`/api/tasks/${t3.id}/run`).expect(409);

    await t.agent.post(`/api/orders/${rb.items[0]!.ordersLogId}/undo`).expect(200);
    await status(t2.id, 'done');
    expect((await t.agent.get(`/api/units/${engId}`).expect(200)).body.unit.halt).toBeNull();
  });

  it('everything, then everyone back to work, from HQ chat', async () => {
    const g = await task(guardId, g1, 'Scan the dependencies');
    await t.agent.post(`/api/tasks/${g.id}/run`).expect(202);
    await status(g.id, 'working');

    const down: ChatSendResult = (
      await t.agent.post('/api/chat/hq').send({ text: 'Everyone, stand down.' }).expect(201)
    ).body;
    await settled(t.app);
    expect(down.readback.body.items[0]!.summary).toContain('All units stood down');
    expect((await detail(g.id)).task.status).toBe('stood-down');
    const view: StandDownView = (await t.agent.get('/api/stand-down').expect(200)).body;
    expect(view.all?.reason).toBe('Commander’s order in chat');

    const up: ChatSendResult = (
      await t.agent.post('/api/chat/hq').send({ text: 'Back to work, everyone.' }).expect(201)
    ).body;
    expect(up.readback.body.items[0]!.summary).toBe(
      'All units: stand-down lifted. 1 paused task(s) back in the queue.',
    );
    await status(g.id, 'done');
    expect(
      ((await t.agent.get('/api/stand-down').expect(200)).body as StandDownView).all,
    ).toBeNull();
  });

  it('every order and its lifting is on the record, with who and why', async () => {
    const events = (
      await t.agent.get('/api/record/events').query({ kinds: 'stand-down' }).expect(200)
    ).body as { kind: string; actor: string; body: { scope: string } }[];
    expect(events.map((e) => e.body.scope).sort()).toEqual(['all', 'bot', 'unit']);
    expect(events.every((e) => e.actor.startsWith('commander:'))).toBe(true);
    const history = (await t.agent.get(`/api/record/${e1}/history`).expect(200)).body;
    expect(
      history.some((v: { superseded: { reason: string } | null }) =>
        v.superseded?.reason.startsWith('Resume work: Finance signed off'),
      ),
    ).toBe(true);
  });
});
