import type { BotEvent, BotView, RecordEvent, TaskDetailView, TaskView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, SpyRuntime, waitFor } from './fixtures.js';
import { asRole, startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 1 "done when": one bot completes one task in its own workspace, and
 * every step it took can be found in the record.
 */
describe('Phase 1: one bot, one task, fully on the record', () => {
  let t: TestApp;
  let spy: SpyRuntime;
  let taskId: string;
  let botId: string;
  let repoLocalPath: string;
  let detail: TaskDetailView;
  const SECRET = `push-token-${Date.now()}-Zq8vX2`;

  beforeAll(async () => {
    t = await startTestApp();
    spy = new SpyRuntime().install(t.app);

    // 1. Connect a repository and a credential through the Supply Depot.
    const repoPath = await makeRepo();
    const repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'test-repo', location: repoPath })
        .expect(201)
    ).body;
    repoLocalPath = repo.spec.localPath;
    await t.agent
      .post('/api/supply/credentials')
      .send({ name: 'test-push-token', value: SECRET })
      .expect(201);

    // 2. One unit, one bot.
    const { unit, bot } = await makeUnitWithBot(t.app);
    botId = bot.entityId;

    // 3. Issue a task and run it.
    const task: TaskView = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: unit.entityId,
          botId,
          title: 'Add rate limiting to the login endpoint',
          description: 'Token bucket per IP.',
          repoSupplyId: repo.id,
          credentialNames: ['test-push-token'],
          scenario: 'happy-path',
        })
        .expect(201)
    ).body;
    taskId = task.id;
    expect(task.status).toBe('queued');

    await t.agent.post(`/api/tasks/${taskId}/run`).expect(202);
    detail = await waitFor(async () => {
      const d: TaskDetailView = (await t.agent.get(`/api/tasks/${taskId}`).expect(200)).body;
      return d.task.status === 'done' ? d : null;
    });
    // The run's closing events (and the Overseer's reaction) land just after the status flips.
    await settled(t.app);
    detail = (await t.agent.get(`/api/tasks/${taskId}`).expect(200)).body;
  });
  afterAll(() => t.close());

  it('the bot finished the task and is free again', async () => {
    expect(detail.task.status).toBe('done');
    const bot: { bot: BotView } = (await t.agent.get(`/api/bots/${botId}`).expect(200)).body;
    expect(bot.bot.status).toBe('idle');
    expect(bot.bot.currentTaskId).toBeNull();
    expect(bot.bot.queue).not.toContain(taskId);
  });

  it('worked in its own git worktree on its own branch', async () => {
    const ws = detail.task.workspace!;
    expect(ws.branch).toBe(`orbot/task-${detail.task.number}`);
    expect(await git(ws.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(ws.branch);
    const log = await git(repoLocalPath, ['log', '--format=%s', `main..${ws.branch}`]);
    expect(log).toBe(`Task #${detail.task.number}: Add rate limiting to the login endpoint`);
    // main is untouched
    expect(await git(repoLocalPath, ['rev-parse', 'main'])).toBe(ws.baseCommit);
  });

  it('every event the bot produced is in the record', async () => {
    const events = detail.events;
    const ofKind = <K extends RecordEvent['kind']>(k: K) =>
      events.filter((e) => e.kind === k) as RecordEvent<K>[];
    const handovers = await t.app
      .get(RecordService)
      .listActive('document', { bodyContains: { kind: 'handover', taskId } });

    expect(spy.yielded.length).toBeGreaterThan(10);
    for (const ev of spy.yielded) {
      const found = matchInRecord(
        ev,
        ofKind,
        handovers.map((h) => h.body.markdown),
      );
      expect(found, `no record entry for ${JSON.stringify(ev)}`).toBe(true);
    }
    // One record entry per yielded event of each kind, no more, no less.
    const count = (type: BotEvent['type']) => spy.yielded.filter((e) => e.type === type).length;
    expect(ofKind('bot.step')).toHaveLength(count('step'));
    expect(ofKind('diary.entry')).toHaveLength(count('diary'));
    // Bot-level sitreps only: the Overseer adds its own unit-level sitrep about the task.
    expect(ofKind('sitrep').filter((e) => e.body.level === 'bot')).toHaveLength(count('sitrep'));
    expect(ofKind('artifact')).toHaveLength(count('artifact'));
    expect(ofKind('cost')).toHaveLength(count('cost'));
    expect(handovers).toHaveLength(count('handover'));
  });

  it('records the run lifecycle, the workspace and the credential use (by name only)', () => {
    // The bot's own trail (the Overseer's unit-level sitrep may follow it).
    const kinds = detail.events
      .filter((e) => !(e.kind === 'sitrep' && (e.body as { level: string }).level === 'unit'))
      .map((e) => e.kind);
    expect(kinds[0]).toBe('task.assigned');
    expect(kinds).toContain('run.started');
    expect(kinds).toContain('workspace.prepared');
    expect(kinds.at(-1)).toBe('run.finished');
    const used = detail.events.find((e) => e.kind === 'credential.used')!;
    expect(used.body).toEqual({
      secretName: 'test-push-token',
      purpose: `push ${detail.task.workspace!.branch}`,
    });
    expect(JSON.stringify(detail)).not.toContain(SECRET);
  });

  it('keeps every status change of the task as a version with who and why', () => {
    const statuses = detail.versions.map((v) => (v.body as { status: string }).status);
    expect(statuses[0]).toBe('queued');
    expect(statuses).toContain('working');
    expect(statuses.at(-1)).toBe('done');
    for (const v of detail.versions.slice(0, -1)) {
      expect(v.superseded?.reason).toBeTruthy();
      expect(v.superseded?.supersededBy).toMatch(/^(commander|bot|system):/);
    }
  });

  it('the handover is a document in the record and searchable', async () => {
    expect(detail.handover?.markdown).toContain('## Next steps');
    const hits = (await t.agent.get('/api/record/search').query({ q: 'cold cache' }).expect(200))
      .body as { entityId: string | null }[];
    expect(hits.some((h) => h.entityId === detail.handover!.id)).toBe(true);
  });

  it('the task view shows exactly what the database holds for this task', async () => {
    const n = await asRole(t.config.recordDb.owner, async (c) =>
      Number(
        (
          await c.query<{ n: string }>(
            'SELECT count(*) AS n FROM record_event WHERE task_id = $1',
            [taskId],
          )
        ).rows[0]!.n,
      ),
    );
    expect(detail.events).toHaveLength(n);
  });
});

function matchInRecord(
  ev: BotEvent,
  ofKind: <K extends RecordEvent['kind']>(k: K) => RecordEvent<K>[],
  handoverMarkdown: string[],
): boolean {
  switch (ev.type) {
    case 'step':
      return ofKind('bot.step').some(
        (e) => e.body.action === ev.action && e.body.detail === ev.detail,
      );
    case 'diary':
      return ofKind('diary.entry').some(
        (e) => e.body.text === ev.text && e.body.category === ev.category,
      );
    case 'sitrep':
      return ofKind('sitrep').some((e) => e.body.text === ev.text);
    case 'artifact':
      return ofKind('artifact').some((e) => e.body.ref === ev.ref && e.body.kind === ev.kind);
    case 'cost':
      return ofKind('cost').some((e) => e.body.units === ev.units);
    case 'handover':
      return handoverMarkdown.some((m) => m.includes(ev.note.state));
    case 'done':
      return ofKind('task.status').some(
        (e) => e.body.to === 'done' && e.body.reason === ev.summary,
      );
    case 'blocked':
      return ofKind('task.status').some(
        (e) => e.body.to === 'blocked' && e.body.reason === ev.reason,
      );
    case 'failed':
      return ofKind('task.status').some(
        (e) => e.body.to === 'failed' && e.body.reason === ev.reason,
      );
    case 'stood-down':
      return ofKind('task.status').some(
        (e) => e.body.to === 'stood-down' && e.body.reason === ev.reason,
      );
    case 'send-back':
      return ofKind('task.status').some(
        (e) => e.body.to === 'stood-down' && e.body.reason === `Sent back: ${ev.reason}`,
      );
    case 'dispute':
      return ofKind('dispute.raised').some((e) => e.body.claim === ev.claim);
    case 'permission':
      return ofKind('permission.requested').some((e) => e.body.action === ev.action);
    case 'report':
      return ofKind('report.filed').some((e) => e.body.title === ev.title);
  }
}
