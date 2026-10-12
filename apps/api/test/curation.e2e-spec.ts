import type {
  FmEntryView,
  RecordEvent,
  TaskDetailView,
  UnitDetailView,
  VersionWithStatus,
} from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

describe('the Overseer curates the Field Manual', () => {
  let t: TestApp;
  let unitId: string;
  let botId: string;
  let repoId: string;

  const run = async (title: string): Promise<TaskDetailView> => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, repoSupplyId: repoId, title, scenario: 'happy-path' })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    return (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
  };
  const unit = async (): Promise<UnitDetailView> =>
    (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
  const coldCache = (u: UnitDetailView) => u.fieldManual.filter((e) => /cold cache/.test(e.body));

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

  let entry: FmEntryView;
  let firstTask: TaskDetailView;

  it('promotes a lasting lesson from a handover, linked to its source', async () => {
    firstTask = await run('First task');
    const u = await unit();
    expect(coldCache(u)).toHaveLength(1);
    entry = coldCache(u)[0]!;
    expect(entry.sources).toEqual([
      {
        kind: 'handover',
        id: firstTask.handover!.id,
        version: 1,
        label: `Task #${firstTask.task.number} handover v1`,
      },
    ]);
    expect(entry.updatedBy).toMatch(/^bot:/); // the Overseer
    const fm = u.documents.find((d) => d.kind === 'field-manual')!;
    expect(fm.markdown).toContain(entry.title);
    expect(fm.markdown).toContain(`_Sources: Task #${firstTask.task.number} handover v1_`);
  });

  it('merges the same lesson from a later handover instead of duplicating it', async () => {
    const second = await run('Second task');
    const u = await unit();
    expect(coldCache(u)).toHaveLength(1);
    expect(coldCache(u)[0]!.sources.map((s) => s.label)).toEqual([
      `Task #${firstTask.task.number} handover v1`,
      `Task #${second.task.number} handover v1`,
    ]);
  });

  it('retires an entry a handover marks obsolete: gone from the manual, kept in the archive', async () => {
    const h = firstTask.handover!;
    const current = (await t.agent.get(`/api/documents/${h.id}`).expect(200)).body;
    await t.agent
      .post(`/api/documents/${h.id}/versions`)
      .send({
        markdown: current.markdown.replace(
          '## Flags for a successor\n',
          `## Flags for a successor\n- Obsolete: ${entry.title}\n`,
        ),
        reason: 'Cache is now pre-warmed in CI',
        expectedVersion: current.version,
      })
      .expect(201);
    await settled(t.app);
    const u = await unit();
    expect(coldCache(u)).toHaveLength(0);
    expect(u.retiredEntries.map((e) => e.id)).toContain(entry.id);
    const history: VersionWithStatus[] = (
      await t.agent.get(`/api/record/${entry.id}/history`).expect(200)
    ).body;
    expect(history.at(-1)!.body).toEqual(expect.objectContaining({ retired: true }));
    expect(history.at(-2)!.superseded?.reason).toMatch(/Marked obsolete/);
    const fm = u.documents.find((d) => d.kind === 'field-manual')!;
    expect(fm.markdown).not.toContain(entry.title);
  });

  it('records every curation action', async () => {
    const events = (await t.app
      .get(RecordService)
      .listEvents({ unitId, kinds: ['curation'], limit: 100 })) as RecordEvent<'curation'>[];
    expect(events.map((e) => e.body.action)).toEqual(
      expect.arrayContaining(['promote', 'merge', 'retire']),
    );
  });

  it('the Commander can add, edit and retire entries; the whole manual is not editable as one blob', async () => {
    const e = (
      await t.agent
        .post(`/api/units/${unitId}/field-manual`)
        .send({ title: 'Reviews', body: 'Two reviewers.', reason: 'New rule' })
        .expect(201)
    ).body;
    const edited = (
      await t.agent
        .post(`/api/fm-entries/${e.id}/versions`)
        .send({ body: 'One reviewer is enough.', reason: 'Relaxed', expectedVersion: 1 })
        .expect(201)
    ).body;
    expect(edited.version).toBe(2);
    expect(edited.sources.map((s: { kind: string }) => s.kind)).toEqual(['commander']);
    await t.agent
      .post(`/api/fm-entries/${e.id}/versions`)
      .send({ body: 'stale', reason: 'x', expectedVersion: 1 })
      .expect(409);
    const u = await unit();
    const fm = u.documents.find((d) => d.kind === 'field-manual')!;
    const r = await t.agent
      .post(`/api/documents/${fm.id}/versions`)
      .send({ markdown: 'blob', reason: 'x', expectedVersion: fm.version })
      .expect(400);
    expect(r.body.error.action).toMatch(/entry/);
  });
});
