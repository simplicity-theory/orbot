import type { ApprovalsView, SupplyView } from '@orbot/shared';
import { WorkService } from '../src/domain/work.service.js';
import { TaskRunner } from '../src/execution/task-runner.js';
import { OverseerService } from '../src/overseer/overseer.service.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * A held task does not hold its bot (D101): a bot whose task blocks moves on to its queue, the
 * task resumes later (now if the bot is free, else first in its queue), and a bot that crashed
 * has its queue moved to the unit's other bots.
 */
describe('Held work does not hold up a unit', () => {
  let t: TestApp;
  let repo: SupplyView;
  let record: RecordService;

  const task = async (unitId: string, botId: string, title: string, scenario: string) =>
    record.transaction(async (w) =>
      t.app.get(WorkService).writeTask(
        w,
        await record.nextTaskNumber(),
        {
          unitId,
          botId,
          missionId: null,
          title,
          description: '',
          repoSupplyId: repo.id,
          credentialNames: [],
          scenario,
          budgetLimitUnits: null,
          continuesTaskId: null,
          autoStart: true,
        },
        { actor: 'system:test', reason: 'test' },
      ),
    );
  const status = async (id: string) => (await record.requireActive('task', id)).body.status;
  const bot = async (id: string) => (await record.requireActive('bot', id)).body;

  beforeAll(async () => {
    t = await startTestApp();
    record = t.app.get(RecordService);
    repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'svc', location: await makeRepo() })
        .expect(201)
    ).body;
  });
  afterAll(() => t.close());

  it('a blocked task frees its bot for the next task, and resumes first in its queue', async () => {
    const { unit, bot: e1 } = await makeUnitWithBot(t.app, { name: 'Builders' });
    const blocked = await task(
      unit.entityId,
      e1.entityId,
      'Wire the client',
      'blocked-on-dependency',
    );
    const next = await task(unit.entityId, e1.entityId, 'Add a health check', 'happy-path');
    t.app.get(OverseerService).dispatchSoon(unit.entityId);
    await settled(t.app);

    expect(await status(blocked.entityId)).toBe('blocked');
    expect(await status(next.entityId)).toBe('done');
    expect(await bot(e1.entityId)).toMatchObject({ status: 'idle', currentTaskId: null });
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention).toContainEqual(
      expect.objectContaining({
        kind: 'blocked-bot',
        entityId: blocked.entityId,
        label: expect.stringMatching(/^E-1 blocked on #\d+: Upstream API client/),
        next: expect.stringMatching(/^Resume the task once the upstream client is available/),
      }),
    );

    // The bot is busy when the task is unblocked: it goes first in the bot's queue.
    await record.revise(
      'bot',
      e1.entityId,
      (b) => ({ ...b, status: 'working', currentTaskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      { actor: 'system:test', reason: 'busy' },
    );
    const other = await task(unit.entityId, e1.entityId, 'Something else', 'happy-path');
    await settled(t.app);
    expect(await t.app.get(TaskRunner).resume(blocked.entityId, 'system:test')).toBe('queued');
    expect(await status(blocked.entityId)).toBe('queued');
    expect((await bot(e1.entityId)).queue[0]).toBe(blocked.entityId);
    expect((await bot(e1.entityId)).queue).toContain(other.entityId);

    // Once the bot is free, the Overseer starts it before the rest of the queue.
    await record.revise(
      'bot',
      e1.entityId,
      (b) => ({ ...b, status: 'idle', currentTaskId: null }),
      { actor: 'system:test', reason: 'free' },
    );
    await settled(t.app);
    const starts = await record.listEvents({ kinds: ['run.started'], limit: 1000 }, {});
    const order = starts
      .filter((e) => [blocked.entityId, other.entityId].includes(e.taskId!))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.taskId);
    expect(order.slice(-2)).toEqual([blocked.entityId, other.entityId]);
    expect(await status(other.entityId)).toBe('done');
  });

  it('a bot still holding a held task (from before) is freed on the next dispatch', async () => {
    const { unit, bot: e1 } = await makeUnitWithBot(t.app, { name: 'Holders' });
    const held = await task(unit.entityId, e1.entityId, 'Wire the client', 'blocked-on-dependency');
    t.app.get(OverseerService).dispatchSoon(unit.entityId);
    await settled(t.app);
    // How a bot was left before D101: blocked, holding its task.
    await record.revise(
      'bot',
      e1.entityId,
      (b) => ({ ...b, status: 'blocked', currentTaskId: held.entityId }),
      { actor: 'system:test', reason: 'as before' },
    );
    const waiting = await task(unit.entityId, e1.entityId, 'Add a health check', 'happy-path');
    t.app.get(OverseerService).dispatchSoon(unit.entityId);
    await settled(t.app);
    expect(await status(waiting.entityId)).toBe('done');
    expect(await status(held.entityId)).toBe('blocked');
  });

  it('a crashed bot’s queue moves to the bots that can work', async () => {
    const { unit, bots } = await makeUnitWithBot(t.app, { name: 'Crashers', bots: 2 });
    const [e1, e2] = bots as [(typeof bots)[0], (typeof bots)[0]];
    await record.revise(
      'bot',
      e1.entityId,
      (b) => ({ ...b, status: 'failed', currentTaskId: null }),
      { actor: 'system:test', reason: 'crashed' },
    );
    const queued = await task(unit.entityId, e1.entityId, 'Add a health check', 'happy-path');
    t.app.get(OverseerService).dispatchSoon(unit.entityId);
    await settled(t.app);
    const done = await record.requireActive('task', queued.entityId);
    expect(done.body).toMatchObject({ status: 'done', botId: e2.entityId });
    expect((await bot(e1.entityId)).queue).toEqual([]);
  });
});
