import type { ComputeUsageView, RecordEvent, TaskDetailView } from '@orbot/shared';
import { makeRepo, makeUnitWithBot, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Compute limits are off by default (D114): a cap is advisory, nothing is held or warned about,
 * and every unit spent is still on the record, summed per task, unit and operation as the
 * baseline for deciding limits later.
 */
describe('Compute: unlimited by default, spend recorded', () => {
  let t: TestApp;
  let repoId: string;
  let unitId: string;
  let botId: string;

  beforeAll(async () => {
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const fx = await makeUnitWithBot(t.app, { name: 'Engineers', supplyIds: [repoId] });
    unitId = fx.unit.entityId;
    botId = fx.bot.entityId;
  });
  afterAll(() => t.close());

  it('a cap far below the spend holds nothing and warns of nothing; the spend is recorded', async () => {
    const b = (
      await t.agent
        .put(`/api/units/${unitId}/budget`)
        .send({ units: 1, reason: 'A note, not a limit' })
        .expect(200)
    ).body;
    expect(b).toMatchObject({ cap: 1, enforced: false, state: 'uncapped' });
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Add an audit field', repoSupplyId: repoId })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    const d = await waitFor(async () => {
      const x: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
      return ['done', 'blocked', 'failed'].includes(x.task.status) ? x : null;
    });
    expect(d.task.status).toBe('done');
    expect(d.task.budget.spentUnits).toBeGreaterThan(1);
    const warnings: RecordEvent[] = (
      await t.agent.get('/api/record/events').query({ kinds: 'budget.warning', unitId }).expect(200)
    ).body;
    expect(warnings).toEqual([]);

    const usage: ComputeUsageView = (await t.agent.get('/api/compute').expect(200)).body;
    expect(usage.limits).toBe('off');
    expect(usage.total).toBe(d.task.budget.spentUnits);
    expect(usage.units).toContainEqual({
      id: unitId,
      name: 'Engineers',
      spent: d.task.budget.spentUnits,
      cap: 1,
    });
    expect(usage.tasks[0]).toMatchObject({ id: task.id, spent: d.task.budget.spentUnits });
  });

  it('turning limits on makes the same cap hold the next task', async () => {
    const st = (await t.agent.get('/api/settings').expect(200)).body;
    await t.agent
      .put('/api/settings')
      .send({ computeLimits: 'on', reason: 'Trial', expectedVersion: st.version })
      .expect(200);
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Add another field', repoSupplyId: repoId })
        .expect(201)
    ).body;
    const r = await t.agent.post(`/api/tasks/${task.id}/run`).expect(409);
    expect(r.body.error.message).toMatch(/Compute budget cap reached/);
    expect((await t.agent.get(`/api/units/${unitId}`).expect(200)).body.budget).toMatchObject({
      enforced: true,
      state: 'capped',
    });
  });
});
