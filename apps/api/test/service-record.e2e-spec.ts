import type { ServiceRecordView } from '@orbot/shared';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Service record: each bot's history of service, worked out from the record.
 * It outlives the bot's active service and never goes into a brief.
 */
describe('Service record', () => {
  let t: TestApp;
  let unitId: string;
  let botId: string;
  let repoId: string;

  const serviceRecord = async (id: string): Promise<ServiceRecordView> =>
    (await t.agent.get(`/api/bots/${id}/service-record`).expect(200)).body;
  const run = async (title: string, scenario: string | null) => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title, repoSupplyId: repoId, scenario })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    return task;
  };

  beforeAll(async () => {
    t = await startTestApp();
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

  it('starts at enlistment', async () => {
    const r = await serviceRecord(botId);
    expect(r).toMatchObject({
      unitName: 'Engineers',
      enlisted: { by: 'system:test', reason: 'test fixture' },
      replaces: null,
      replacedBy: null,
      stats: { runs: 0, successRate: null, unitsSpent: 0, refusals: 0 },
      commendations: [],
    });
    expect(r.entries.map((e) => e.kind)).toEqual(['enlisted']);
  });

  it('counts runs, outcomes, spend, handovers and what it wrote; lists notable entries', async () => {
    const done = await run('Add audit logging', 'happy-path');
    const failed = await run('Migrate the database', 'tests-fail');
    const r = await serviceRecord(botId);
    expect(r.stats.runs).toBe(2);
    expect(r.stats.outcomes.done).toBe(1);
    expect(r.stats.outcomes.failed + r.stats.outcomes.blocked).toBe(1);
    expect(r.stats.successRate).toBe(0.5);
    expect(r.stats.tasksDone).toBe(1);
    expect(r.stats.unitsSpent).toBeGreaterThan(0);
    expect(r.stats.handovers).toBe(2);
    expect(r.stats.diaryEntries).toBeGreaterThan(0);
    expect(r.stats.averageRunSeconds).not.toBeNull();
    const doneEntry = r.entries.find((e) => e.kind === 'done')!;
    expect(doneEntry.text).toContain(`Task #${done.number} Add audit logging — done`);
    expect(doneEntry.link).toBe(`/units/${unitId}/bots/${botId}/tasks/${done.id}`);
    expect(r.entries.at(-1)!.kind).toBe('enlisted');
    void failed;
  });

  it('commends the bot for lessons its handovers left in the Field Manual', async () => {
    const r = await serviceRecord(botId);
    // The Overseer curates handovers; any entry sourced from this bot's handover counts.
    expect(r.commendations.map((c) => c.title).sort()).toEqual([
      'Do not delete the failing tests without an…',
      'Test suite is slow on a cold cache',
    ]);
    for (const c of r.commendations) {
      expect(r.entries).toContainEqual(
        expect.objectContaining({ kind: 'commendation', text: expect.stringContaining(c.title) }),
      );
    }
  });

  it('a replacement links both ways, and the old record stays', async () => {
    const added = (
      await t.agent
        .post(`/api/units/${unitId}/bots`)
        .send({ role: 'Developer', reason: 'Fresh pair of hands', replacesBotId: botId })
        .expect(201)
    ).body;
    const old = await serviceRecord(botId);
    const fresh = await serviceRecord(added.id);
    expect(old.replacedBy).toEqual({ id: added.id, callsign: added.callsign });
    expect(fresh.replaces).toEqual({ id: botId, callsign: old.bot.callsign });
    expect(old.stats.runs).toBe(2);
    expect(fresh.stats.runs).toBe(0);
  });
});
