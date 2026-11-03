import type { OperationDetailView, TaskDetailView, TheatreSummary } from '@orbot/shared';
import { READY_FOR_HANDOFF } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { makeUnitWithBot, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Inspection's work lands with the operation, and it starts before the handoff (D129): a check
 * task prepares its test plan and harness while the unit before it builds, holds for the
 * handoff without troubling the Commander, is queued again with a Frago when the handoff
 * comes, and its commits are integrated and landed like any unit's work.
 */
describe('Inspection prepares during the build and its work lands', () => {
  let t: TestApp;
  let inspection: { unitId: string; botId: string };
  let engineers: { unitId: string; botId: string };

  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const task = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    const eng = await makeUnitWithBot(t.app, {
      name: 'Engineers',
      role: 'Developers',
      prefix: 'E',
    });
    engineers = { unitId: eng.unit.entityId, botId: eng.bot.entityId };
    const ins = await makeUnitWithBot(t.app, { name: 'Inspection', role: 'QA', prefix: 'I' });
    inspection = { unitId: ins.unit.entityId, botId: ins.bot.entityId };
  });
  afterAll(() => t.close());

  it('the check task prepares, holds for the handoff, runs after it, and its commits reach main', async () => {
    const r = (
      await t.agent
        .post('/api/theatres')
        .send({
          name: 'Ledger',
          description: 'A personal ledger.',
          repository: { kind: 'template', template: 'single-html' },
          site: true,
          intent: 'Build the first version.',
        })
        .expect(201)
    ).body;
    const opId: string = r.operation.id;

    // Inspection's task starts while Engineers build, and holds for the handoff.
    const prepared = await waitFor(async () => {
      const v = await op(opId);
      const m = v.missions.find((x) => x.mission.stage === 'inspect');
      const x = m?.tasks.find((k) => k.status === 'blocked');
      return x ?? null;
    }, 30_000);
    expect(prepared.statusReason).toMatch(new RegExp(`^${READY_FOR_HANDOFF}: `));
    expect(prepared.statusAction).toMatch(/^Nothing to do: it starts again/);
    // Nothing for the Commander in it.
    const needs = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(needs.attention.map((a: { label: string }) => a.label)).toEqual([]);

    const v = await waitFor(async () => {
      const x = await op(opId);
      return x.operation.phase === 'closed' ? x : null;
    }, 60_000);
    expect(v.missions.map((m) => m.mission.stage)).toEqual(['build', 'inspect']);
    const inspect = v.missions.find((m) => m.mission.stage === 'inspect')!;
    expect(inspect.unit.id).toBe(inspection.unitId);
    const d = await task(inspect.tasks[0]!.id);
    const statuses = d.events
      .filter((e) => e.kind === 'task.status')
      .map((e) => (e.body as { to: string }).to);
    // Prepared and held, queued by the handoff, then the usual send-back and re-check.
    expect(statuses).toEqual([
      'working',
      'blocked',
      'queued',
      'working',
      'stood-down',
      'queued',
      'working',
      'done',
    ]);
    const requeued = d.events.find(
      (e) => e.kind === 'task.status' && (e.body as { to: string }).to === 'queued',
    )!;
    expect((requeued.body as { reason: string }).reason).toMatch(/^Handoff from Engineers at /);
    expect(d.task.description).toMatch(/Frago: Engineers handed off at \w+ on orbot\/op-/);
    // The preparation came before the handoff, in time.
    const handoff = v.timeline.find((e) => e.kind === 'handoff')!;
    const held = d.events.find(
      (e) => e.kind === 'task.status' && (e.body as { to: string }).to === 'blocked',
    )!;
    expect(held.createdAt < handoff.createdAt).toBe(true);

    // Its commits were integrated and landed with the operation: main holds the test plan
    // written before the handoff and the results written after it.
    const integrations = v.timeline.filter((e) => e.kind === 'integration');
    expect(integrations.map((e) => (e.body as { from: string }).from)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^orbot\/task-/),
        expect.stringMatching(/^orbot\/task-/),
        expect.stringMatching(/^orbot\/op-/),
      ]),
    );
    const list: TheatreSummary[] = (await t.agent.get('/api/theatres').expect(200)).body;
    const repo = list[0]!.repository!;
    const local = repo.spec.kind === 'repository' ? repo.spec.localPath : '';
    const files = await git(local, ['ls-tree', '-r', '--name-only', 'main']);
    expect(files.split('\n')).toEqual(
      expect.arrayContaining([
        'index.html',
        `tests/test-plan-${d.task.number}.md`,
        `tests/inspection-${d.task.number}.md`,
      ]),
    );
    expect(v.needsYou).toEqual([]);
    theatreId = r.theatre.id;
  });

  let theatreId = '';

  it('what comes up twice in the theatre is recommended once, with one button, never as a stop (D130)', async () => {
    // The first review drew a lesson (the send-back) and left a finding open; nothing is
    // recommended from one operation.
    const before = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(before.recommendations).toEqual([]);
    const second = (
      await t.agent
        .post(`/api/theatres/${theatreId}/operations`)
        .send({ intent: 'Add a running balance.' })
        .expect(201)
    ).body;
    const closed = await waitFor(async () => {
      const x = await op(second.id);
      return x.operation.phase === 'closed' ? x : null;
    }, 60_000);
    expect(closed.afterAction?.markdown).toMatch(/## HQ recommends/);
    const inbox = (await t.agent.get('/api/approvals').expect(200)).body;
    // Not a stop: nothing in attention, and the operation closed on its own.
    expect(inbox.attention).toEqual([]);
    const recs = inbox.recommendations as {
      recommendation: {
        id: string;
        kind: string;
        text: string;
        status: string;
        operationIds: string[];
      };
      theatre: { name: string };
      unitName: string | null;
      operations: { name: string }[];
    }[];
    expect(recs.map((x) => [x.recommendation.kind, x.recommendation.text])).toEqual([
      ['fix', 'Fix touch targets on the add button are below 24px'],
    ]);
    const fix = recs[0]!;
    expect(fix.theatre.name).toBe('Ledger');
    expect(fix.unitName).toBe('Inspection');
    expect(fix.operations.map((o) => o.name)).toEqual(['Add a running']);

    // One button: a rule becomes a standing order of the unit.
    const rule = await t.app.get(RecordService).create(
      'recommendation',
      {
        theatreId,
        kind: 'rule',
        unitId: inspection.unitId,
        text: 'Before handing over, check: the suite ran on the integration branch.',
        why: 'Drawn again after Operation Ledger.',
        operationIds: [second.id],
      },
      { actor: 'system:hq', reason: 'test' },
    );
    const adopted = (
      await t.agent.post(`/api/recommendations/${rule.entityId}/adopt`).send({}).expect(200)
    ).body;
    expect(adopted.recommendation.status).toBe('adopted');
    const unit = (await t.agent.get(`/api/units/${inspection.unitId}`).expect(200)).body;
    expect(unit.unit.standingOrders.map((o: { text: string }) => o.text)).toContainEqual(
      rule.body.text,
    );
    // In chat: the fix becomes an operation in the theatre.
    const chat = (await t.agent.post('/api/chat/hq').send({ text: 'Launch the fix.' }).expect(201))
      .body;
    expect(chat.readback.body.items.map((x: { summary: string }) => x.summary)).toEqual([
      expect.stringMatching(
        /^Fix taken up: Operation Fix: touch targets on the add button launched/,
      ),
    ]);
    const after = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(after.recommendations).toEqual([]);
    const theatre = (await t.agent.get(`/api/theatres/${theatreId}`).expect(200)).body;
    expect(
      theatre.operations.map((o: { operation: { name: string } }) => o.operation.name),
    ).toContain('Fix: touch targets on the add button');
    await t.agent
      .post(`/api/recommendations/${rule.entityId}/dismiss`)
      .send({ note: 'late' })
      .expect(409);

    // Decided once, it is not raised again by the next review.
    const third = await waitFor(async () => {
      const x = await op(
        theatre.operations.find(
          (o: { operation: { name: string } }) =>
            o.operation.name === 'Fix: touch targets on the add button',
        ).operation.id,
      );
      return x.operation.phase === 'closed' ? x : null;
    }, 60_000);
    expect(third.afterAction?.markdown).not.toMatch(/## HQ recommends/);
    expect((await t.agent.get('/api/approvals').expect(200)).body.recommendations).toEqual([]);
    const all = (await t.agent.get('/api/recommendations').expect(200)).body;
    expect(all).toEqual([]);
  });

  it('a check task that reports done before the handoff is held for it, whatever the bot said', async () => {
    // Engineers stand down first, so the build cannot hand off while the test acts.
    await t.agent
      .post('/api/stand-down')
      .send({ scope: 'unit', targetId: engineers.unitId, reason: 'Hold the build for a moment' })
      .expect(200);
    const launched = (
      await t.agent
        .post(`/api/theatres/${theatreId}/operations`)
        .send({ intent: 'Add categories.' })
        .expect(201)
    ).body;
    const prepared = await waitFor(async () => {
      const v = await op(launched.id);
      const m = v.missions.find((x) => x.mission.stage === 'inspect');
      const x = m?.tasks.find((k) => k.status === 'blocked');
      return x ? { task: x, mission: m!.mission } : null;
    }, 30_000);
    expect(prepared.mission.status).toBe('waiting');
    // A bot that reports done instead of holding: the Overseer holds the task for the handoff.
    const record = t.app.get(RecordService);
    await record.transaction(async (w) => {
      await w.revise(
        'task',
        prepared.task.id,
        (b) => ({ ...b, status: 'done', statusReason: 'Prepared.' }),
        {
          actor: 'system:test',
          reason: 'a bot that reported done too early',
        },
      );
      await w.event(
        'task.status',
        { from: 'blocked', to: 'done', reason: 'Prepared.' },
        {
          unitId: prepared.task.unitId,
          botId: prepared.task.botId,
          taskId: prepared.task.id,
          missionId: prepared.mission.id,
          operationId: launched.id,
        },
        'system:test',
      );
    });
    const held = await waitFor(async () => {
      const d = await task(prepared.task.id);
      return d.task.status === 'blocked' &&
        d.task.statusReason?.includes('reported done before the handoff')
        ? d
        : null;
    }, 20_000);
    expect(held.mission?.status).toBe('waiting');
    // The build goes on, the handoff comes, and the operation runs through as usual.
    await t.agent
      .post('/api/stand-down/lift')
      .send({ scope: 'unit', targetId: engineers.unitId, reason: 'Carry on' })
      .expect(200);
    const closed = await waitFor(async () => {
      const x = await op(launched.id);
      return x.operation.phase === 'closed' ? x : null;
    }, 60_000);
    expect(closed.needsYou).toEqual([]);
    expect(closed.missions.map((m) => m.mission.status)).toEqual(['done', 'done']);
  });
});
