import type { FmEntryView, RecordEvent, UnitDetailView } from '@orbot/shared';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

describe('cold-start check', () => {
  let t: TestApp;
  let unitId: string;
  let lesson: FmEntryView;

  const unit = async (): Promise<UnitDetailView> =>
    (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
  const check = async (): Promise<RecordEvent<'coldstart.check'>> =>
    (await t.agent.post(`/api/units/${unitId}/coldstart`).expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    const repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const fx = await makeUnitWithBot(t.app, { supplyIds: [repoId] });
    unitId = fx.unit.entityId;
    // Part 1 of a relay: a half-done task with a handover.
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId,
          botId: fx.bot.entityId,
          title: 'Audit logging',
          repoSupplyId: repoId,
          scenario: 'relay',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    lesson = (await unit()).fieldManual.find((e) => e.body.includes('[ENG]'))!;
  });
  afterAll(() => t.close());

  it('passes when the documents carry everything a fresh bot needs', async () => {
    const r = await check();
    expect(r.body.score).toBe(100);
    expect(r.body.gaps).toEqual([]);
    expect(r.body.taskNumber).toBeGreaterThan(0);
  });

  it('finds a gap when a handover flag is missing from the Field Manual, and fixes it', async () => {
    await t.agent
      .post(`/api/fm-entries/${lesson.id}/retire`)
      .send({ reason: 'Testing the check', expectedVersion: lesson.version })
      .expect(200);
    await settled(t.app);
    const r = await check();
    expect(r.body.score).toBeLessThan(100);
    expect(r.body.gaps).toEqual([
      expect.stringMatching(
        /^Flag only in a handover, not in the Field Manual: “Prefix commit messages with `\[ENG\]`/,
      ),
      'The Field Manual is empty: a fresh bot would have no unit conventions.',
    ]);
    expect(r.body.fixes).toHaveLength(1);

    const u = await unit();
    const fix = u.fieldManual.find((e) => e.id === r.body.fixes[0])!;
    expect(fix.body).toContain('[ENG]');
    expect(fix.sources).toEqual([
      expect.objectContaining({ kind: 'coldstart', label: 'Cold-start check' }),
    ]);
    expect(u.coldStart?.id).toBe(r.id);
  });

  it('passes again once the fix is in', async () => {
    expect((await check()).body.score).toBe(100);
  });
});
