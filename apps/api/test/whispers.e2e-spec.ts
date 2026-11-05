import type { RecordEvent, TaskDetailView, WhisperView } from '@orbot/shared';
import type { TaskBrief, RunContext, BotEvent } from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { WhispersService } from '../src/whispers/whispers.service.js';
import { makeRepo, makeUnitWithBot, settled, SpyRuntime } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

const GOSSIP =
  'Psst: the first test run after a checkout is slow because of the cold cache; warm it before timing anything.';
const SECRET = 'ghp_whispered_secret_value_9f3a1c';

/** A runtime that keeps the briefs it was handed, so a test can see what a bot overheard. */
class BriefSpy extends SpyRuntime {
  readonly briefs: TaskBrief[] = [];
  override async *run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    this.briefs.push(brief);
    yield* super.run(brief, ctx);
  }
}

/**
 * The whispers board: gossip. Anyone leaves an unsigned note, anyone reads it, bots overhear
 * a few in their brief and leave their own. None of it is on the record or in any log, nothing
 * says who left it, and notes fade at random.
 */
describe('Whispers', () => {
  let t: TestApp;
  let unitId: string;
  let botId: string;
  let repoId: string;
  let runtime: BriefSpy;

  const board = async (): Promise<WhisperView[]> =>
    (await t.agent.get('/api/whispers').expect(200)).body;
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

  beforeAll(async () => {
    t = await startTestApp();
    runtime = new BriefSpy().install(t.app);
    t.app.get(WhispersService).random = () => 1; // nothing fades until the test says so
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
      .post('/api/supply/credentials')
      .send({ name: 'gh-token', value: SECRET })
      .expect(201);
  });
  afterAll(() => t.close());

  it('anyone leaves a note and anyone reads it; nothing says who, and a secret never gets on it', async () => {
    expect(await board()).toEqual([]);
    const left: WhisperView = (
      await t.agent
        .post('/api/whispers')
        .send({ text: '  The flaky test is the clock one; run it twice before you believe it.  ' })
        .expect(201)
    ).body;
    expect(Object.keys(left).sort()).toEqual(['at', 'id', 'text']);
    expect(left.text).toBe('The flaky test is the clock one; run it twice before you believe it.');
    await t.agent.post('/api/whispers').send({ text: '' }).expect(400);
    await t.agent
      .post('/api/whispers')
      .send({ text: 'x'.repeat(281) })
      .expect(400);
    await t.agent
      .post('/api/whispers')
      .send({ text: `the token is ${SECRET} if anyone needs it` })
      .expect(201);
    const notes = await board();
    expect(notes.map((n) => n.id)).toContain(left.id);
    expect(JSON.stringify(notes)).not.toContain(SECRET);
    expect(notes[0]!.text).toContain('the token is ');
  });

  it('a bot leaves a whisper as it works; the next bot overhears it; the record and the logs never do', async () => {
    const first = await runTask({ title: 'Warm-up', scenario: 'gossip' });
    expect(first.task.status).toBe('done');
    expect((await board()).map((n) => n.text)).toContain(GOSSIP);

    const second = await runTask({ title: 'Follow-on', scenario: 'happy-path' });
    expect(second.task.status).toBe('done');
    const brief = runtime.briefs.at(-1)!;
    expect(brief.overheard).toContain(GOSSIP);
    expect(brief.overheard.length).toBeLessThanOrEqual(5);

    // Nothing of it on the record: not in the briefed event, no event body, no document, no search hit.
    const briefed = second.events.find(
      (e) => e.kind === 'task.briefed',
    ) as RecordEvent<'task.briefed'>;
    expect(JSON.stringify(briefed.body)).not.toContain('Psst');
    const record = t.app.get(RecordService);
    const events = await record.listEvents({ limit: 10_000 });
    expect(JSON.stringify(events)).not.toContain('Psst');
    for (const type of ['document', 'task', 'bot', 'unit'] as const) {
      expect(JSON.stringify(await record.listActive(type))).not.toContain('Psst');
    }
    expect(await record.search({ q: 'Psst', scope: 'all', limit: 10 })).toEqual([]);
    expect(t.logs.text).not.toContain('Psst');
    // Nest maps the routes at boot; no line after that says a whisper was left or read.
    expect(
      t.logs.lines.filter((l) => /whisper/i.test(l) && !/RoutesResolver|RouterExplorer/.test(l)),
    ).toEqual([]);
  });

  it('notes fade at random until the board is bare', async () => {
    expect((await board()).length).toBeGreaterThan(0);
    const whispers = t.app.get(WhispersService);
    whispers.random = () => 0;
    whispers.fade();
    expect(await board()).toEqual([]);
  });
});
