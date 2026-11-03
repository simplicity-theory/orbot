import type { ApprovalsView, RecordEvent, SupplyView, TaskDetailView } from '@orbot/shared';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Every hold names its way out (D112): a task that stops short carries what the Commander can
 * do about it, the inbox shows it, a failed task can be retried, and when the task stops the
 * same way again it says that resuming alone will not change it.
 */
describe('a held or failed task says what to do next', () => {
  let t: TestApp;
  let unitId: string;
  let botIds: string[];
  let repo: SupplyView;

  const create = async (scenario: string, botId: string) =>
    (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId,
          botId,
          title: `Work (${scenario})`,
          description: 'Scripted.',
          repoSupplyId: repo.id,
          credentialNames: [],
          scenario,
        })
        .expect(201)
    ).body.id as string;
  const run = async (id: string, status: string) => {
    await t.agent.post(`/api/tasks/${id}/run`).expect(202);
    await waitFor(async () => {
      const x: TaskDetailView = (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
      return x.task.status === status ? x : null;
    });
    await settled(t.app);
    return (await t.agent.get(`/api/tasks/${id}`).expect(200)).body as TaskDetailView;
  };

  beforeAll(async () => {
    t = await startTestApp();
    repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    const fx = await makeUnitWithBot(t.app, { name: 'Engineers', bots: 2, supplyIds: [repo.id] });
    unitId = fx.unit.entityId;
    botIds = fx.bots.map((b) => b.entityId);
  });
  afterAll(() => t.close());

  it('a block carries the bot’s next step for the Commander, on the task, the event and the inbox', async () => {
    const id = await create('blocked-on-dependency', botIds[0]!);
    const d = await run(id, 'blocked');
    const next =
      'Resume the task once the upstream client is available, or change the task to build against a stub.';
    expect(d.task.statusReason).toBe('Upstream API client is not available yet.');
    expect(d.task.statusAction).toBe(next);
    const status = d.events.find(
      (e) => e.kind === 'task.status' && (e as RecordEvent<'task.status'>).body.to === 'blocked',
    ) as RecordEvent<'task.status'>;
    expect(status.body.action).toBe(next);
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention).toContainEqual(
      expect.objectContaining({ kind: 'blocked-bot', entityId: id, next }),
    );
    const sitreps = d.events
      .filter((e) => e.kind === 'sitrep')
      .map((e) => (e.body as { text: string }).text);
    expect(sitreps.at(-1)).toContain(next);

    // Resumed as it stands, it holds again: the next step says resuming alone is not the answer.
    const again = await run(id, 'blocked');
    expect(again.task.statusAction).toBe(
      `Held again for the same reason: resuming alone will not clear it. ${next}`,
    );
  });

  it('a failed task says what to do and can be retried; failed the same way, it says so', async () => {
    const id = await create('tests-fail', botIds[1]!);
    const d = await run(id, 'failed');
    const next =
      'Decide the spec: in chat, order the tests updated or the change reverted; then Retry the task.';
    expect(d.task.statusAction).toBe(next);
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention).toContainEqual(
      expect.objectContaining({ kind: 'failed-task', entityId: id, next }),
    );
    const again = await run(id, 'failed');
    expect(again.task.statusAction).toBe(
      `Failed again in the same way: retrying alone will not fix it. ${next}`,
    );
  });
});
