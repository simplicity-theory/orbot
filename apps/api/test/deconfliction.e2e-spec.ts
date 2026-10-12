import type { DeconflictionView, RecordEvent, TaskDetailView, TaskView } from '@orbot/shared';
import { makeRepo, makeUnitWithBot, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Deconfliction: each task has its own workspace and branch, and HQ tracks who
 * touches what. Two units changing the same file are told about each other.
 */
describe('Deconfliction', () => {
  let t: TestApp;
  let repoId: string;
  let eng: { unitId: string; botId: string };
  let eng2: { unitId: string; botId: string };
  let guard: { unitId: string; botId: string };
  let a: TaskView;
  let b: TaskView;

  const start = async (who: { unitId: string; botId: string }, title: string, scenario: string) => {
    const task: TaskView = (
      await t.agent
        .post('/api/tasks')
        .send({ ...who, title, repoSupplyId: repoId, scenario })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    return task;
  };
  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const e = await makeUnitWithBot(t.app, { supplyIds: [repoId], bots: 2 });
    eng = { unitId: e.unit.entityId, botId: e.bot.entityId };
    eng2 = { unitId: e.unit.entityId, botId: e.bots[1]!.entityId };
    const g = await makeUnitWithBot(t.app, { name: 'Guard', prefix: 'G', supplyIds: [repoId] });
    guard = { unitId: g.unit.entityId, botId: g.bot.entityId };
  });
  afterAll(async () => {
    await t.agent.post('/api/stand-down').send({ scope: 'all', reason: 'End of test' }).expect(200);
    await t.close();
  });

  it('every task works in its own worktree, on its own branch', async () => {
    a = await start(eng, 'Tighten the login limit', 'shared-file');
    b = await start(guard, 'Rate-limit the admin API', 'shared-file');
    const [da, db] = await Promise.all(
      [a, b].map((x) =>
        waitFor(async () => {
          const d = await detail(x.id);
          return d.events.some((e) => e.kind === 'artifact') ? d : null;
        }),
      ),
    );
    expect(da!.task.workspace!.path).not.toBe(db!.task.workspace!.path);
    expect(da!.task.workspace!.branch).toBe(`orbot/task-${a.number}`);
    expect(db!.task.workspace!.branch).toBe(`orbot/task-${b.number}`);
  });

  it('HQ notices both change the same file: one notice, a sitrep, and a frago to each bot', async () => {
    // (Both bots are still at work, so wait for the notice rather than for everything to settle.)
    const notices = await waitFor(async () => {
      const n = (
        await t.agent.get('/api/record/events').query({ kinds: 'deconfliction' }).expect(200)
      ).body as RecordEvent<'deconfliction'>[];
      return n.length ? n : null;
    });
    await waitFor(async () =>
      (await detail(a.id)).events.some((e) => e.kind === 'frago') &&
      (await detail(b.id)).events.some((e) => e.kind === 'frago')
        ? true
        : null,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatchObject({
      repoSupplyId: repoId,
      paths: ['src/config/limits.js'],
      taskIds: [a.id, b.id],
    });
    expect(notices[0]!.actor).toBe('system:hq');

    for (const x of [a, b]) {
      const fragos = (await detail(x.id)).events.filter((e) => e.kind === 'frago');
      expect(fragos).toHaveLength(1);
      expect((fragos[0]!.body as { text: string }).text).toContain('HQ deconfliction');
    }
    const sitreps = (await t.agent.get('/api/record/events').query({ kinds: 'sitrep' }).expect(200))
      .body as RecordEvent<'sitrep'>[];
    expect(sitreps.map((s) => s.body.text)).toContainEqual(
      expect.stringContaining('both change `src/config/limits.js`'),
    );
  });

  it('the map shows who touches what, overlaps first; each task page lists its overlaps', async () => {
    const view: DeconflictionView = (await t.agent.get('/api/deconfliction').expect(200)).body;
    expect(view.overlaps).toBe(1);
    const repo = view.repos.find((r) => r.id === repoId)!;
    expect(repo.files[0]).toMatchObject({
      path: 'src/config/limits.js',
      tasks: [
        expect.objectContaining({ taskId: a.id, unitName: 'Engineers', callsign: 'E-1' }),
        expect.objectContaining({ taskId: b.id, unitName: 'Guard' }),
      ],
    });
    // ORBOT's own per-task notes are not "touches".
    expect(repo.files.some((f) => f.path.startsWith('orbot/'))).toBe(false);

    const d = await detail(a.id);
    expect(d.overlaps).toEqual([
      { path: 'src/config/limits.js', others: [expect.objectContaining({ taskId: b.id })] },
    ]);
  });

  it('the same overlap is not reported twice', async () => {
    const c = await start(eng2, 'Tidy the README', 'happy-path');
    await waitFor(async () => ((await detail(c.id)).task.status === 'done' ? true : null));
    await new Promise((r) => setTimeout(r, 300));
    const notices = (
      await t.agent.get('/api/record/events').query({ kinds: 'deconfliction' }).expect(200)
    ).body as unknown[];
    expect(notices).toHaveLength(1);
  });
});
