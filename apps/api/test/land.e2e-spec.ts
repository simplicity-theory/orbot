import type { ChatSendResult, LandedView, RecordEvent, TaskDetailView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Landing a task's branch on the repository's default branch is the Commander's order (a
 * button on the task, "Land #N on main" in chat), never a bot's doing (D117).
 */
describe('Land a task on main', () => {
  let t: TestApp;
  let repoId: string;
  let repoPath: string;
  let unitId: string;
  let botId: string;

  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const finished = async (title: string) => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title, repoSupplyId: repoId })
        .expect(201)
    ).body as { id: string; number: number };
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await waitFor(async () => ((await detail(task.id)).task.status === 'done' ? true : null));
    return task;
  };

  beforeAll(async () => {
    t = await startTestApp();
    const r = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    repoId = r.id;
    repoPath = r.spec.localPath;
    const fx = await makeUnitWithBot(t.app, { name: 'Engineers', supplyIds: [repoId] });
    unitId = fx.unit.entityId;
    botId = fx.bot.entityId;
  });
  afterAll(() => t.close());

  it('from the task: main moves to the branch, recorded as an integration; again, nothing to land', async () => {
    const task = await finished('Add an audit field');
    const before = await git(repoPath, ['rev-parse', 'main']);
    const d = await detail(task.id);
    const head = await git(repoPath, ['rev-parse', d.task.workspace!.branch]);
    expect(head).not.toBe(before);

    const r: LandedView = (await t.agent.post(`/api/tasks/${task.id}/land`).expect(200)).body;
    expect(r).toMatchObject({ number: task.number, branch: 'main', unchanged: false });
    expect(await git(repoPath, ['rev-parse', 'main'])).toBe(r.commit);
    expect(await git(repoPath, ['merge-base', '--is-ancestor', head, 'main'])).toBe('');
    const after = await detail(task.id);
    const landed = after.events.filter(
      (e) => e.kind === 'integration',
    ) as RecordEvent<'integration'>[];
    expect(landed.map((e) => e.body)).toEqual([
      { branch: 'main', commit: r.commit, from: d.task.workspace!.branch },
    ]);

    const again: LandedView = (await t.agent.post(`/api/tasks/${task.id}/land`).expect(200)).body;
    expect(again.unchanged).toBe(true);
  });

  it('in chat: "Land #N on main"', async () => {
    const task = await finished('Add a health check');
    const r: ChatSendResult = (
      await t.agent
        .post(`/api/chat/${unitId}`)
        .send({ text: `Land #${task.number} on main.` })
        .expect(201)
    ).body;
    await settled(t.app);
    expect(r.readback.body.items[0]!.summary).toMatch(
      new RegExp(`^Task #${task.number} landed on main: app is at [0-9a-f]{10}\\.$`),
    );
  });

  it('a task still working cannot be landed; one with no branch neither', async () => {
    const fresh = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Nothing yet', repoSupplyId: repoId })
        .expect(201)
    ).body;
    const r = await t.agent.post(`/api/tasks/${fresh.id}/land`).expect(400);
    expect(r.body.error.action).toMatch(/Start the task first/);
  });
});
