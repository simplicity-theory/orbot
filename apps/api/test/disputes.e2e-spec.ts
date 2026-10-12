import type {
  ApprovalsView,
  DisputeView,
  RecordEvent,
  TaskDetailView,
  TaskView,
} from '@orbot/shared';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Disputes: a bot disagrees with another unit about its task. HQ rules under
 * standing orders (citing the order) and the work carries on as ruled; when no order
 * settles it, HQ refers it to the Commander. The Commander's ruling is final.
 */
describe('Disputes', () => {
  let t: TestApp;
  let repoId: string;
  let engId: string;
  let guardId: string;
  let bots: string[];

  const task = async (botId: string, title: string, claim: string): Promise<TaskView> => {
    const x: TaskView = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: engId,
          botId,
          title,
          description: claim,
          repoSupplyId: repoId,
          scenario: 'dispute',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${x.id}/run`).expect(202);
    return x;
  };
  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const disputes = async (): Promise<DisputeView[]> =>
    (await t.agent.get('/api/disputes').expect(200)).body;

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
    bots = eng.bots.map((b) => b.entityId);
    const guard = await makeUnitWithBot(t.app, { name: 'Guard', prefix: 'G', supplyIds: [repoId] });
    guardId = guard.unit.entityId;
    const unit = (await t.agent.get(`/api/units/${guardId}`).expect(200)).body.unit;
    await t.agent
      .put(`/api/units/${guardId}/standing-orders`)
      .send({
        orders: [{ text: 'Login attempts are capped at 5 per minute.' }],
        reason: 'Security baseline',
        expectedVersion: unit.version,
      })
      .expect(200);
  });
  afterAll(() => t.close());

  let ruled: TaskView;

  it('HQ rules under the standing order that settles it, and the work carries on as ruled', async () => {
    ruled = await task(
      bots[0]!,
      'Raise the login limit',
      'The brief asks for 10 login attempts per minute, but Guard caps login attempts at 5 per minute.',
    );
    const d = await waitFor(async () => {
      const x = await detail(ruled.id);
      return x.task.status === 'done' ? x : null;
    });
    await settled(t.app);
    const [dispute] = await disputes();
    expect(dispute).toMatchObject({
      status: 'ruled',
      unitName: 'Engineers',
      againstUnitName: 'Guard',
      taskNumber: ruled.number,
    });
    expect(dispute!.hqRuling).toMatchObject({
      prevails: 'other',
      by: 'system:hq',
      cited: [{ unitId: guardId, text: 'Login attempts are capped at 5 per minute.' }],
    });
    // The task waited for the ruling, then the bot read it and complied.
    const statuses = d.events
      .filter((e) => e.kind === 'task.status')
      .map((e) => (e as RecordEvent<'task.status'>).body.to);
    expect(statuses).toEqual(['working', 'blocked', 'working', 'done']);
    const read = d.events.find(
      (e) => e.kind === 'bot.step' && (e.body as { action: string }).action === 'read-ruling',
    );
    expect((read!.body as { detail: string }).detail).toBe(
      "HQ ruled: Guard prevails. Guard's standing order “Login attempts are capped at 5 per minute.” settles it: Guard prevails.",
    );
    // Both units hear about it.
    for (const unitId of [engId, guardId]) {
      const sitreps = (
        await t.agent.get('/api/record/events').query({ kinds: 'sitrep', unitId }).expect(200)
      ).body as RecordEvent<'sitrep'>[];
      expect(sitreps.map((s) => s.body.text)).toContainEqual(
        expect.stringContaining('HQ ruled on task'),
      );
    }
    // HQ's ruling is not something that waits on the Commander.
    const approvals: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(approvals.attention.some((a) => a.kind === 'dispute')).toBe(false);
  });

  it('the Commander can overturn HQ: final, on the record, and cannot be ruled again', async () => {
    const [dispute] = await disputes();
    await t.agent
      .post(`/api/disputes/${dispute!.id}/rule`)
      .send({ prevails: 'raiser', reasoning: 'Product needs 10; Guard will update its order.' })
      .expect(200);
    const [after] = await disputes();
    expect(after).toMatchObject({
      status: 'final',
      hqRuling: expect.objectContaining({ prevails: 'other' }),
      commanderRuling: expect.objectContaining({
        prevails: 'raiser',
        by: expect.stringMatching(/^commander:/),
      }),
    });
    const history = (await t.agent.get(`/api/record/${dispute!.id}/history`).expect(200)).body as {
      superseded: { reason: string } | null;
    }[];
    expect(history.map((v) => v.superseded?.reason ?? null)).toEqual([
      'HQ ruled: Guard prevails',
      'The Commander overturned HQ: Engineers prevails',
      null,
    ]);
    await t.agent
      .post(`/api/disputes/${dispute!.id}/rule`)
      .send({ prevails: 'other', reasoning: 'Changed my mind' })
      .expect(409);
  });

  it('no standing order settles it: HQ refers it to the Commander, who rules; the task resumes', async () => {
    const x = await task(
      bots[1]!,
      'Restyle the error pages',
      'Guard wants plain-text error pages; the design system needs branded pages.',
    );
    await waitFor(async () => ((await detail(x.id)).task.status === 'blocked' ? true : null));
    await settled(t.app);
    const dispute = (await disputes()).find((d) => d.taskId === x.id)!;
    expect(dispute.status).toBe('referred');
    expect((await detail(x.id)).task.statusReason).toBe(
      'Disputed with Guard: Guard wants plain-text error pages; the design system needs branded pages.',
    );
    const approvals: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    const item = approvals.attention.find((a) => a.kind === 'dispute');
    expect(item).toMatchObject({ entityId: dispute.id, link: `/disputes#dispute-${dispute.id}` });
    expect(item!.label).toContain('Dispute to rule on: Engineers v Guard');

    await t.agent
      .post(`/api/disputes/${dispute.id}/rule`)
      .send({ prevails: 'raiser', reasoning: 'Branded pages; plain text only for the API.' })
      .expect(200);
    const d = await waitFor(async () => {
      const y = await detail(x.id);
      return y.task.status === 'done' ? y : null;
    });
    const read = d.events.find(
      (e) => e.kind === 'bot.step' && (e.body as { action: string }).action === 'read-ruling',
    );
    expect((read!.body as { detail: string }).detail).toBe(
      'The Commander (final) ruled: Engineers prevails. Branded pages; plain text only for the API.',
    );
    await settled(t.app);
    const after: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(after.attention.some((a) => a.kind === 'dispute')).toBe(false);
  });
});
