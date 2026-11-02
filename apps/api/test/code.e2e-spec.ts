import type {
  CommitDetailView,
  RepositoryHistoryView,
  TaskChangesView,
  TaskDetailView,
} from '@orbot/shared';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, makeUnitWithBot, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * The code itself: every change a bot makes is visible as a diff, from its task, from the
 * repository's history and from the commit, and each commit is tied to the task and bot that
 * made it.
 */
describe('Code: commits and diffs', () => {
  let t: TestApp;
  let repoId: string;
  let task: TaskDetailView;

  beforeAll(async () => {
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'svc', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const { unit, bot } = await makeUnitWithBot(t.app);
    const created = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: unit.entityId,
          botId: bot.entityId,
          title: 'Add a health check',
          repoSupplyId: repoId,
          scenario: 'happy-path',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${created.id}/run`).expect(202);
    task = await waitFor(async () => {
      const d: TaskDetailView = (await t.agent.get(`/api/tasks/${created.id}`).expect(200)).body;
      return d.task.status === 'done' ? d : null;
    });
  });
  afterAll(() => t.close());

  it('a task’s changes: its commits, tied to the bot, and the whole diff since its base', async () => {
    const c: TaskChangesView = (await t.agent.get(`/api/tasks/${task.task.id}/changes`).expect(200))
      .body;
    expect(c.repository).toEqual({ id: repoId, name: 'svc' });
    expect(c.branch).toBe(`orbot/task-${task.task.number}`);
    const recorded = task.events
      .filter((e) => e.kind === 'artifact' && (e.body as { kind: string }).kind === 'commit')
      .map((e) => (e.body as { ref: string }).ref);
    expect(recorded.length).toBeGreaterThan(0);
    expect(c.commits.map((x) => x.sha)).toEqual(recorded);
    expect(c.commits[0]!.origin).toMatchObject({
      kind: 'commit',
      taskId: task.task.id,
      taskNumber: task.task.number,
      botCallsign: 'E-1',
      unitName: 'Engineers',
    });
    expect(c.files.length).toBeGreaterThan(0);
    expect(c.files.some((f) => f.added > 0 && f.hunks.length > 0)).toBe(true);
    expect(c.uncommitted).toEqual([]);

    // Something the bot has not committed yet shows separately.
    writeFileSync(join(task.task.workspace!.path, 'scratch.md'), 'draft\n');
    const later: TaskChangesView = (
      await t.agent.get(`/api/tasks/${task.task.id}/changes`).expect(200)
    ).body;
    expect(later.uncommitted).toEqual([
      expect.objectContaining({ path: 'scratch.md', status: 'added', added: 1 }),
    ]);
  });

  it('a commit, by repository or by id alone, with who made it', async () => {
    const c: TaskChangesView = (await t.agent.get(`/api/tasks/${task.task.id}/changes`).expect(200))
      .body;
    const sha = c.commits.at(-1)!.sha;
    const detail: CommitDetailView = (
      await t.agent.get(`/api/repositories/${repoId}/commits/${sha}`).expect(200)
    ).body;
    expect(detail.commit).toMatchObject({ sha, origin: { botCallsign: 'E-1' } });
    expect(detail.commit.refs).toContain(c.branch);
    expect(detail.files.length).toBeGreaterThan(0);
    const found: CommitDetailView = (
      await t.agent.get(`/api/commits/${sha.slice(0, 12)}`).expect(200)
    ).body;
    expect(found.repository.id).toBe(repoId);
    expect(found.commit.sha).toBe(sha);
    await t.agent.get('/api/commits/not-a-sha').expect(400);
    await t.agent.get(`/api/commits/${'0'.repeat(40)}`).expect(404);
  });

  it('a repository’s history, on any of its branches', async () => {
    const h: RepositoryHistoryView = (
      await t.agent.get(`/api/repositories/${repoId}/history`).expect(200)
    ).body;
    expect(h.ref).toBe('main');
    expect(h.refs[0]).toEqual({ name: 'main', kind: 'default' });
    const branch = `orbot/task-${task.task.number}`;
    expect(h.refs).toContainEqual({ name: branch, kind: 'task' });
    const onTask: RepositoryHistoryView = (
      await t.agent
        .get(`/api/repositories/${repoId}/history?ref=${encodeURIComponent(branch)}`)
        .expect(200)
    ).body;
    expect(onTask.commits[0]!.origin?.taskId).toBe(task.task.id);
    expect(onTask.commits.at(-1)!.subject).toBe('init');
    // Only real branches: nothing else reaches git.
    await t.agent.get(`/api/repositories/${repoId}/history?ref=--all`).expect(400);
  });
});
