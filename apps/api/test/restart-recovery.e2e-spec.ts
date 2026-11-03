import type { RecordEvent, TaskDetailView } from '@orbot/shared';
import { TaskRunner } from '../src/execution/task-runner.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * A run lives in the API process. When the process restarts under it (an update, a crash), the
 * record still says the task is working and nothing would notice: at boot, every such task is
 * queued again with the reason, its run closed, and its bot freed (D115).
 */
describe('Restart recovery: a task left working by a restart goes again', () => {
  let t: TestApp;
  let record: RecordService;
  let repoId: string;
  let unitId: string;
  let botId: string;

  /** The state a restart leaves behind: task working, bot on it, a run started and never finished. */
  const strand = async (title: string, autoStart: boolean) => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title, repoSupplyId: repoId })
        .expect(201)
    ).body as { id: string; number: number };
    await record.revise('task', task.id, (b) => ({ ...b, status: 'working', autoStart }), {
      actor: 'system:test',
      reason: 'Simulate a run in progress',
    });
    await record.revise(
      'bot',
      botId,
      (b) => ({ ...b, status: 'working', currentTaskId: task.id }),
      { actor: 'system:test', reason: 'Simulate a run in progress' },
    );
    await record.event(
      'run.started',
      { runId: `run-${task.number}`, runtime: 'simulated' },
      { unitId, botId, taskId: task.id },
      'system:test',
    );
    return task;
  };
  const detail = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    record = t.app.get(RecordService);
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

  it('a Commander-started task is queued again with the reason and what to do; its bot is freed', async () => {
    const task = await strand('Add an audit field', false);
    await t.app.get(TaskRunner).onApplicationBootstrap();
    await settled(t.app);
    const d = await detail(task.id);
    expect(d.task.status).toBe('queued');
    expect(d.task.statusReason).toMatch(/^ORBOT restarted while the task ran/);
    expect(d.task.statusAction).toBe(
      'Start the task again; the bot carries on from its branch and handover.',
    );
    expect(d.bot).toMatchObject({ status: 'idle', currentTaskId: null });
    const finished = d.events.filter(
      (e) => e.kind === 'run.finished',
    ) as RecordEvent<'run.finished'>[];
    expect(finished.map((e) => e.body)).toEqual([
      { runId: `run-${task.number}`, outcome: 'stopped' },
    ]);
    expect(
      d.events.filter((e) => e.kind === 'sitrep').map((e) => (e.body as { text: string }).text),
    ).toContainEqual(
      expect.stringMatching(/was running when ORBOT restarted; queued again for E-1/),
    );
    // Started again, it runs to the end.
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await waitFor(async () => ((await detail(task.id)).task.status === 'done' ? true : null));
  });

  it('an Overseer-issued task (auto-start) is picked up again without anyone', async () => {
    const task = await strand('Add a health check', true);
    await t.app.get(TaskRunner).onApplicationBootstrap();
    await settled(t.app);
    const d = await waitFor(async () => {
      const x = await detail(task.id);
      return x.task.status === 'done' ? x : null;
    });
    const statuses = d.events
      .filter((e) => e.kind === 'task.status')
      .map((e) => (e as RecordEvent<'task.status'>).body);
    expect(statuses.map((s) => s.to)).toEqual(['queued', 'working', 'done']);
    expect(statuses[0]!.action).toBe(
      'Nothing to do: the Overseer starts it again as soon as its bot is free.',
    );
  });
});
