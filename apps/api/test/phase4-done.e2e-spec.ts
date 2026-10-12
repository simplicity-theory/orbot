import type {
  ChatSendResult,
  OperationDetailView,
  RecordEvent,
  UnitDetailView,
} from '@orbot/shared';
import { git } from '../src/common/git.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

const INTENT = 'Ship login rate limiting to production.';

/**
 * Phase 4 "done when": one operation runs from the Commander's statement of intent to a
 * production deployment across all four units (Engineers → Inspection → Guard → Logistics),
 * including a send-back, the deploy approval and deploy rights given in chat.
 */
describe('Phase 4: intent to deployment across the whole force', () => {
  let t: TestApp;
  let units: Record<string, string>;
  let repoPath: string;
  let opId: string;
  let op: OperationDetailView;

  const chat = async (channel: string, text: string): Promise<ChatSendResult> => {
    const r = (await t.agent.post(`/api/chat/${channel}`).send({ text }).expect(201)).body;
    await settled(t.app);
    return r;
  };
  const detail = async (): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${opId}`).expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    const repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    repoPath = repo.spec.localPath;
    await t.agent
      .post('/api/supply/environments')
      .send({ name: 'production', tier: 'production' })
      .expect(201);
    const eng = await makeUnitWithBot(t.app, {
      name: 'Engineers',
      role: 'Developers',
      prefix: 'E',
      bots: 2,
      supplyIds: [repo.id],
    });
    const ins = await makeUnitWithBot(t.app, {
      name: 'Inspection',
      role: 'QA',
      prefix: 'I',
      gate: 'escalations-only',
    });
    const grd = await makeUnitWithBot(t.app, { name: 'Guard', role: 'Security', prefix: 'G' });
    const log = await makeUnitWithBot(t.app, { name: 'Logistics', role: 'DevOps', prefix: 'L' });
    units = {
      eng: eng.unit.entityId,
      ins: ins.unit.entityId,
      grd: grd.unit.entityId,
      log: log.unit.entityId,
    };

    // 1. Intent, stated to HQ in chat.
    const r = await chat('hq', INTENT);
    expect(r.readback.body.items[0]!.summary).toMatch(/^Operation .+ launched/);
    opId = r.readback.body.items[0]!.links[0]!.link.split('/').pop()!;

    // 2. Backbriefs: Inspection's gate approves its own; the Commander approves the other three.
    op = await detail();
    for (const m of op.missions) {
      if (m.backbrief?.status === 'awaiting-approval') {
        await t.agent
          .post(`/api/backbriefs/${m.backbrief.id}/approve`)
          .send({ expectedVersion: m.backbrief.version })
          .expect(200);
      }
    }
    await settled(t.app);

    // 3. Work flows down the chain; the deploy waits for the Commander.
    op = await waitFor(async () => {
      const d = await detail();
      return d.needsYou.some((n) => n.action === 'approve-deploy') ? d : null;
    });
    const deploy = op.missions.at(-1)!.tasks[0]!;
    await t.agent
      .post(`/api/tasks/${deploy.id}/deploy-decision`)
      .send({ approve: true })
      .expect(200);
    await settled(t.app);

    // 4. Logistics has no deploy rights yet: blocked. Grant them in chat (irreversible: confirm).
    const grant = await chat(units.log!, 'Grant Logistics production deploy rights.');
    const pending = grant.readback.body.pending[0]!;
    await t.agent
      .post(`/api/pending/${pending.pendingId}/confirm`)
      .send({ phrase: 'confirm' })
      .expect(200);
    await settled(t.app);
    op = await detail();
  });
  afterAll(() => t.close());

  it('HQ split the intent into four missions, in handoff order', () => {
    expect(op.operation.intent).toBe(INTENT);
    expect(op.missions.map((m) => [m.unit.name, m.mission.stage])).toEqual([
      ['Engineers', 'build'],
      ['Inspection', 'inspect'],
      ['Guard', 'guard'],
      ['Logistics', 'deploy'],
    ]);
    expect(op.missions.map((m) => m.mission.dependsOnMissionId)).toEqual([
      null,
      op.missions[0]!.mission.id,
      op.missions[1]!.mission.id,
      op.missions[2]!.mission.id,
    ]);
    expect(op.missions.every((m) => m.mission.status === 'done')).toBe(true);
  });

  it('went through every phase of the operation lifecycle, in order', () => {
    const phases = op.timeline
      .filter((e) => e.kind === 'operation.phase')
      .map((e) => (e.body as { to: string }).to);
    expect(phases).toEqual([
      'o-group',
      'backbrief',
      'execution',
      'handoffs',
      'sitreps',
      'after-action',
      'closed',
    ]);
    expect(op.operation.phase).toBe('closed');
  });

  it('Inspection sent the work back once; Engineers fixed it; the re-check passed', () => {
    const sendbacks = op.timeline.filter((e) => e.kind === 'sendback') as RecordEvent<'sendback'>[];
    expect(sendbacks).toHaveLength(1);
    expect(sendbacks[0]!.body).toMatchObject({ fromUnitId: units.ins, toUnitId: units.eng });
    const engTasks = op.missions[0]!.tasks;
    expect(engTasks.map((x) => x.kind).sort()).toEqual(['fix', 'work']);
    const handoffs = (
      op.timeline.filter((e) => e.kind === 'handoff') as RecordEvent<'handoff'>[]
    ).map((h) => [h.body.fromUnitId, h.body.toUnitId]);
    expect(handoffs).toEqual([
      [units.eng, units.ins],
      [units.eng, units.ins],
      [units.ins, units.grd],
      [units.grd, units.log],
    ]);
  });

  it('the production deploy waited for the Commander, then for deploy rights, then shipped the integrated work', async () => {
    const approvals = op.timeline.filter((e) => e.kind === 'deploy.approval');
    expect(approvals).toHaveLength(1);
    const deployTask = op.missions.at(-1)!.tasks[0]!;
    const d = (await t.agent.get(`/api/tasks/${deployTask.id}`).expect(200)).body;
    const statuses = d.versions.map((v: { body: { status: string } }) => v.body.status);
    expect(statuses).toEqual(expect.arrayContaining(['awaiting-approval', 'blocked', 'done']));

    expect(op.operation.deployment).toMatchObject({
      environment: 'production',
      ref: 'deploy/production',
    });
    const deployed = await git(repoPath, ['rev-parse', 'deploy/production']);
    expect(deployed).toBe(op.operation.deployment!.commit);
    const files = await git(repoPath, ['ls-tree', '-r', '--name-only', 'deploy/production']);
    expect(files).toMatch(/orbot\/task-\d+\.md/); // Engineers' work
    expect(files).toMatch(/orbot\/fix-\d+\.md/); // the fix after the send-back
  });

  it('the After Action review was written and its lesson saved as a standing order', async () => {
    expect(op.afterAction?.markdown).toContain('## Lessons kept as standing orders');
    const eng: UnitDetailView = (await t.agent.get(`/api/units/${units.eng}`).expect(200)).body;
    expect(eng.unit.standingOrders.map((o) => o.text)).toContainEqual(
      expect.stringMatching(/^Before handing over, check: Login tests/),
    );
    expect(eng.unit.updatedBy).toBe('system:hq');
  });

  it('the shared cross-unit record tells the whole story', () => {
    const md = op.record!.markdown;
    expect(md).toContain('**Phase:** closed');
    expect(md).toMatch(/Handoff Engineers → Inspection/);
    expect(md).toMatch(/Sent back by Inspection to Engineers/);
    expect(md).toMatch(/Deployed to production/);
    // A lesson Inspection flagged for Engineers went up to HQ's shared record.
    expect(md).toMatch(/Lesson for Engineers from Inspection: Engineers: include tests/);
  });

  it('appears on the operations board', async () => {
    const board = (await t.agent.get('/api/operations').expect(200)).body;
    expect(board.map((o: { operation: { id: string } }) => o.operation.id)).toContain(opId);
  });
});
