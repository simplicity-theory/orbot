import type { RecordEvent, TaskDetailView } from '@orbot/shared';
import { BriefingService } from '../src/overseer/briefing.service.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

describe('pre-task briefing', () => {
  let t: TestApp;
  let unitId: string;
  let botId: string;
  let repoId: string;
  let first: TaskDetailView;

  const runTask = async (body: Record<string, unknown>): Promise<TaskDetailView> => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, repoSupplyId: repoId, ...body })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    return (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
  };
  const briefOf = (d: TaskDetailView) =>
    d.events.filter((e) => e.kind === 'task.briefed').at(-1) as RecordEvent<'task.briefed'>;

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
    await t.agent
      .post(`/api/units/${unitId}/field-manual`)
      .send({ title: 'Branching', body: 'One task, one branch.', reason: 'test' })
      .expect(201);
    first = await runTask({ title: 'Add rate limiter middleware', scenario: 'happy-path' });
  });
  afterAll(() => t.close());

  it('a first task is briefed with the Field Manual and no handover', () => {
    const b = briefOf(first);
    expect(b.body.handoverId).toBeNull();
    expect(b.body.fieldManualEntryIds.length).toBeGreaterThan(0);
  });

  it('a follow-up task is briefed with its predecessor’s handover, the Field Manual and recent War Diary', async () => {
    const second = await runTask({
      title: 'Tune the rate limiter',
      scenario: 'happy-path',
      continuesTaskId: first.task.id,
    });
    const b = briefOf(second);
    expect(b.body.handoverId).toBe(first.handover!.id);
    expect(b.body.handoverVersion).toBe(first.handover!.version);
    const diaryIds = first.events.filter((e) => e.kind === 'diary.entry').map((e) => e.id);
    expect(b.body.diaryEventIds).toEqual(expect.arrayContaining(diaryIds));
    // The lesson the first bot flagged was curated into the manual and is in the brief.
    const unit = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
    const lesson = unit.fieldManual.find((e: { body: string }) => /cold cache/.test(e.body));
    expect(b.body.fieldManualEntryIds).toContain(lesson.id);
  });

  it('with a long manual, briefs pinned and relevant entries only', async () => {
    for (let i = 0; i < 14; i++) {
      await t.agent
        .post(`/api/units/${unitId}/field-manual`)
        .send({
          title: `Unrelated note ${i}`,
          body: `Pottery glaze kiln temperature ${i}.`,
          reason: 'filler',
        })
        .expect(201);
    }
    const pinned = (
      await t.agent
        .post(`/api/units/${unitId}/field-manual`)
        .send({ title: 'Always', body: 'Speak plainly.', pinned: true, reason: 'test' })
        .expect(201)
    ).body;
    const k = await t.app.get(BriefingService).relevantEntries(unitId, 'rate limiter branch');
    expect(k.length).toBeLessThanOrEqual(8);
    expect(k[0]!.entryId).toBe(pinned.id);
    expect(k.map((e) => e.title)).toContain('Branching');
  });

  it('bots can search the unit’s record on demand, falling back to the archive', async () => {
    const e = (
      await t.agent
        .post(`/api/units/${unitId}/field-manual`)
        .send({
          title: 'Zeppelin protocol',
          body: 'Greet the quokka handshake first.',
          reason: 'test',
        })
        .expect(201)
    ).body;
    await t.agent
      .post(`/api/fm-entries/${e.id}/retire`)
      .send({ reason: 'Outdated', expectedVersion: e.version })
      .expect(200);
    await settled(t.app);
    const briefing = t.app.get(BriefingService);
    const hits = await briefing.search(unitId, 'quokka handshake');
    // Nothing current mentions it any more; the archive still does.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.archived)).toBe(true);
    const doc = (
      await t.app
        .get(RecordService)
        .listActive('document', { unitId, bodyContains: { kind: 'field-manual' } })
    )[0]!;
    expect(doc.body.markdown).not.toContain('quokka');
  });
});
