import type {
  ApprovalsView,
  BackbriefView,
  RecordEvent,
  UnitDetailView,
  VersionWithStatus,
} from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

describe('the Overseer commands its unit', () => {
  let t: TestApp;
  let repoId: string;

  beforeAll(async () => {
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
  });
  afterAll(() => t.close());

  const unitView = async (id: string): Promise<UnitDetailView> =>
    (await t.agent.get(`/api/units/${id}`).expect(200)).body;
  const sitreps = async (unitId: string) =>
    (
      (await t.app
        .get(RecordService)
        .listEvents({ unitId, kinds: ['sitrep'], limit: 1000 })) as RecordEvent<'sitrep'>[]
    )
      .filter((e) => e.body.level === 'unit')
      .map((e) => e.body.text);

  describe('with the default gate (backbriefs need approval)', () => {
    let unitId: string;
    let botIds: string[];
    let bb: BackbriefView;

    beforeAll(async () => {
      const fx = await makeUnitWithBot(t.app, { name: 'Engineers', bots: 2, supplyIds: [repoId] });
      unitId = fx.unit.entityId;
      botIds = fx.bots.map((b) => b.entityId);
      await t.agent
        .post('/api/missions')
        .send({
          unitId,
          goal: 'Add audit logging',
          definitionOfDone: ['Log every login', 'Log every logout', 'Document the log format'],
        })
        .expect(201);
      await settled(t.app);
      const approvals: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
      bb = approvals.backbriefs.find((b) => b.unitId === unitId)!;
    });

    it('drafts a backbrief and waits for the Commander', async () => {
      expect(bb.status).toBe('awaiting-approval');
      expect(bb.proposedTasks.map((p) => p.title)).toEqual([
        'Log every login',
        'Log every logout',
        'Document the log format',
      ]);
      // Work is spread across the unit's bots.
      expect(new Set(bb.proposedTasks.map((p) => p.botId))).toEqual(new Set(botIds));
      const u = await unitView(unitId);
      expect(u.missions[0]!.mission.status).toBe('awaiting-approval');
      expect(u.attention).toContainEqual(
        expect.objectContaining({ kind: 'awaiting-approval', entityId: bb.id }),
      );
      expect(await sitreps(unitId)).toContainEqual(
        expect.stringMatching(/Backbrief ready for “Add audit logging”/),
      );
    });

    it('re-plans when sent back, keeping the rejected round in history', async () => {
      await t.agent
        .post(`/api/backbriefs/${bb.id}/reject`)
        .send({ note: 'Do the format doc first', expectedVersion: bb.version })
        .expect(200);
      await settled(t.app);
      bb = (await t.agent.get(`/api/backbriefs/${bb.id}`).expect(200)).body;
      expect(bb.status).toBe('awaiting-approval');
      expect(bb.round).toBe(2);
      expect(bb.commanderNotes).toEqual(['Do the format doc first']);
      expect(bb.risks.join(' ')).toContain('Do the format doc first');
      const history: VersionWithStatus[] = (
        await t.agent.get(`/api/record/${bb.id}/history`).expect(200)
      ).body;
      expect(history.map((v) => (v.body as { status: string }).status)).toEqual([
        'awaiting-approval',
        'rejected',
        'awaiting-approval',
      ]);
    });

    it('refuses a decision on a stale version', async () => {
      const r = await t.agent
        .post(`/api/backbriefs/${bb.id}/approve`)
        .send({ expectedVersion: 1 })
        .expect(409);
      expect(r.body.error.action).toBeTruthy();
    });

    it('approves with amendments: issues the tasks, dispatches them, reports, and completes the mission', async () => {
      const amended = [
        { ...bb.proposedTasks[2]!, title: 'Document the audit log format' },
        bb.proposedTasks[0]!,
        bb.proposedTasks[1]!,
      ];
      const r = await t.agent
        .post(`/api/backbriefs/${bb.id}/amend`)
        .send({ proposedTasks: amended, note: 'Format doc first', expectedVersion: bb.version })
        .expect(200);
      expect(r.body.status).toBe('approved');
      expect(r.body.decision).toEqual(
        expect.objectContaining({
          outcome: 'amended',
          note: 'Format doc first',
          by: 'commander:commander',
        }),
      );
      expect(r.body.taskIds).toHaveLength(3);

      await settled(t.app);
      const u = await unitView(unitId);
      const tasks = u.tasks.filter((x) => r.body.taskIds.includes(x.id));
      expect(tasks.map((x) => x.status)).toEqual(['done', 'done', 'done']);
      expect(tasks.map((x) => x.title)).toContain('Document the audit log format');
      expect(u.missions[0]!.mission.status).toBe('done');
      expect(u.missions[0]!.done).toBe(3);
      const reports = await sitreps(unitId);
      expect(reports).toContainEqual(
        expect.stringMatching(/^Wilco\. “Add audit logging”: 3 task\(s\) issued as amended/),
      );
      expect(reports).toContainEqual(expect.stringMatching(/completed task #\d+/));
      expect(reports.at(-1)).toBe('Mission complete: Add audit logging.');
    });

    it('refuses to decide an already-approved plan', async () => {
      const current: BackbriefView = (await t.agent.get(`/api/backbriefs/${bb.id}`).expect(200))
        .body;
      await t.agent
        .post(`/api/backbriefs/${bb.id}/approve`)
        .send({ expectedVersion: current.version })
        .expect(409);
    });

    it('reassigns a task between bots', async () => {
      const task = (
        await t.agent
          .post('/api/tasks')
          .send({ unitId, botId: botIds[0], title: 'Tidy logs', repoSupplyId: repoId })
          .expect(201)
      ).body;
      const r = await t.agent
        .post(`/api/tasks/${task.id}/reassign`)
        .send({ botId: botIds[1], reason: 'E-1 is busy' })
        .expect(200);
      expect(r.body.botId).toBe(botIds[1]);
      const [a, b] = await Promise.all(
        botIds.map(async (id) => (await t.agent.get(`/api/bots/${id}`).expect(200)).body),
      );
      expect(a.bot.queue).not.toContain(task.id);
      expect(b.bot.queue).toContain(task.id);
    });
  });

  it('with "escalations only", the plan is approved automatically and executed', async () => {
    const fx = await makeUnitWithBot(t.app, {
      name: 'Inspection',
      gate: 'escalations-only',
      supplyIds: [repoId],
    });
    await t.agent
      .post('/api/missions')
      .send({
        unitId: fx.unit.entityId,
        goal: 'Write a test plan',
        definitionOfDone: ['Test plan written'],
      })
      .expect(201);
    await settled(t.app);
    const u = await unitView(fx.unit.entityId);
    expect(u.backbriefs).toHaveLength(0);
    expect(u.missions[0]!.backbrief!.decision!.outcome).toBe('auto-approved');
    expect(u.missions[0]!.mission.status).toBe('done');
  });

  it('a mission needs a unit with an Overseer', async () => {
    const fx = await makeUnitWithBot(t.app, { name: 'Leaderless', overseer: false });
    const r = await t.agent
      .post('/api/missions')
      .send({ unitId: fx.unit.entityId, goal: 'x', definitionOfDone: ['y'] })
      .expect(409);
    expect(r.body.error.message).toBe('Leaderless has no Overseer.');
  });
});
