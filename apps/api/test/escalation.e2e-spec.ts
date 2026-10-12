import type {
  ApprovalsView,
  RecordEvent,
  StandDownView,
  TaskDetailView,
  TaskView,
} from '@orbot/shared';
import { EscalationService } from '../src/overseer/escalation.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Phase 5, Escalation for stuck work: stalls, timeouts and repeated failures go up the
 * chain — the Overseer acts first, then HQ, then it reaches the Commander.
 */
describe('Escalation for stuck work', () => {
  let t: TestApp;
  let repoId: string;
  let unitId: string;
  let bots: string[];
  let escalations: EscalationService;

  const task = async (botId: string, title: string, scenario: string): Promise<TaskView> =>
    (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title, repoSupplyId: repoId, scenario })
        .expect(201)
    ).body;
  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const until = (id: string, status: string) =>
    waitFor(async () => {
      const d = await detail(id);
      return d.task.status === status ? d : null;
    });
  const chain = async (taskId: string) =>
    (
      (await t.agent.get('/api/record/events').query({ kinds: 'escalation', taskId }).expect(200))
        .body as RecordEvent<'escalation'>[]
    ).map((e) => ({ level: e.body.level, cause: e.body.cause, actor: e.actor }));
  const attention = async () =>
    ((await t.agent.get('/api/approvals').expect(200)).body as ApprovalsView).attention;
  const setEscalation = async (over: Record<string, number>) => {
    const s = (await t.agent.get('/api/settings').expect(200)).body;
    await t.agent
      .put('/api/settings')
      .send({
        escalation: { ...s.escalation, ...over },
        reason: 'Test timings',
        expectedVersion: s.version,
      })
      .expect(200);
  };

  beforeAll(async () => {
    t = await startTestApp();
    escalations = t.app.get(EscalationService);
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const fx = await makeUnitWithBot(t.app, { supplyIds: [repoId], bots: 3 });
    unitId = fx.unit.entityId;
    bots = fx.bots.map((b) => b.entityId);
  });
  afterAll(() => t.close());

  it('a stall: the Overseer checks in first; still silent, the run is paused and it reaches the Commander', async () => {
    await setEscalation({ stallSeconds: 1 });
    const s = await task(bots[0]!, 'Re-index the search tables', 'long-haul');
    await t.agent.post(`/api/tasks/${s.id}/run`).expect(202);
    await until(s.id, 'working');

    await sleep(1200);
    await escalations.sweep();
    let d = await detail(s.id);
    expect(d.task.status).toBe('working');
    expect(d.events.some((e) => e.kind === 'frago')).toBe(true);
    expect(await chain(s.id)).toEqual([
      { level: 'overseer', cause: 'stall', actor: expect.stringMatching(/^bot:/) },
    ]);

    await sleep(1200);
    await escalations.sweep();
    d = await until(s.id, 'stood-down');
    expect(d.task.statusReason).toBe('Stalled: no progress for 1 s after a status check');
    expect(d.handover?.markdown).toContain('Stood down mid-task');
    expect(await chain(s.id)).toEqual([
      { level: 'overseer', cause: 'stall', actor: expect.stringMatching(/^bot:/) },
      { level: 'hq', cause: 'stall', actor: 'system:hq' },
      { level: 'commander', cause: 'stall', actor: 'system:hq' },
    ]);
    const item = (await attention()).find((a) => a.kind === 'escalation');
    expect(item).toMatchObject({ action: 'acknowledge', entityId: s.id });
    expect(item!.label).toContain('stalled and was paused with a handover');

    // The Commander picks it up again: the escalation closes itself, and the work finishes.
    await t.agent.post(`/api/tasks/${s.id}/run`).expect(202);
    await until(s.id, 'done');
    await settled(t.app);
    expect((await attention()).some((a) => a.kind === 'escalation')).toBe(false);
    await setEscalation({ stallSeconds: 600 });
  });

  it('a timeout: stopped with a handover and escalated; the Commander acknowledges it', async () => {
    await setEscalation({ timeoutSeconds: 1 });
    const s = await task(bots[1]!, 'Backfill a year of audit rows', 'long-haul');
    await t.agent.post(`/api/tasks/${s.id}/run`).expect(202);
    await until(s.id, 'working');
    await sleep(1200);
    await escalations.sweep();
    const d = await until(s.id, 'stood-down');
    expect(d.task.statusReason).toBe('Timed out: ran for more than 1 s');
    expect((await chain(s.id)).map((c) => c.level)).toEqual(['overseer', 'hq', 'commander']);

    const item = (await attention()).find((a) => a.kind === 'escalation')!;
    await t.agent
      .post(`/api/escalations/${item.chainId}/resolve`)
      .send({ note: 'Will split it into monthly batches' })
      .expect(200);
    expect((await attention()).some((a) => a.kind === 'escalation')).toBe(false);
    await setEscalation({ timeoutSeconds: 3600 });
  });

  it('repeated failures: not retried, escalated in place of the plain failure', async () => {
    const f = await task(bots[2]!, 'Change the rounding rule', 'tests-fail');
    await t.agent.post(`/api/tasks/${f.id}/run`).expect(202);
    await until(f.id, 'failed');
    await settled(t.app);
    expect(await chain(f.id)).toEqual([]);
    expect((await attention()).find((a) => a.entityId === f.id)?.kind).toBe('failed-task');

    await t.agent
      .post(`/api/tasks/${f.id}/reassign`)
      .send({ botId: bots[1], reason: 'One more try, on another bot' })
      .expect(200);
    await t.agent.post(`/api/tasks/${f.id}/run`).expect(202);
    await until(f.id, 'failed');
    await settled(t.app);
    expect(await chain(f.id)).toEqual([
      { level: 'overseer', cause: 'repeated-failure', actor: expect.stringMatching(/^bot:/) },
      { level: 'hq', cause: 'repeated-failure', actor: 'system:hq' },
      { level: 'commander', cause: 'repeated-failure', actor: 'system:hq' },
    ]);
    const items = (await attention()).filter((a) => a.entityId === f.id);
    expect(items.map((i) => i.kind)).toEqual(['escalation']);
    expect(items[0]!.label).toContain('has failed 2 times');
  });

  it('a bot that keeps failing is stood down by its Overseer and escalated; resuming it closes that', async () => {
    // bots[2] failed task #f above; two more failures in a row and its Overseer acts.
    for (const title of ['Change the tax rule', 'Change the fee rule']) {
      const g = await task(bots[2]!, title, 'tests-fail');
      await t.agent.post(`/api/tasks/${g.id}/run`).expect(202);
      await until(g.id, 'failed');
      await settled(t.app);
    }

    const sd: StandDownView = (await t.agent.get('/api/stand-down').expect(200)).body;
    expect(sd.bots).toEqual([
      expect.objectContaining({
        id: bots[2],
        halt: expect.objectContaining({ reason: 'Failed its last 3 runs' }),
      }),
    ]);
    const item = (await attention()).find((a) => a.kind === 'escalation' && a.entityId === bots[2]);
    expect(item?.label).toContain('failed its last 3 runs and is stood down');

    await t.agent
      .post('/api/stand-down/lift')
      .send({ scope: 'bot', targetId: bots[2], reason: 'Runtime fixed' })
      .expect(200);
    await settled(t.app);
    expect((await attention()).some((a) => a.entityId === bots[2])).toBe(false);
  });
});
