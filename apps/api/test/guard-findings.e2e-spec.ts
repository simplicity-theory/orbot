import type { ApprovalsView, SupplyView, TaskDetailView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { GUARD_STANDING_ORDERS } from '../src/seed/seed.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * What Guard does with what it finds: every finding is recorded; a small one is fixed on the
 * spot and committed; a low one never holds the work; a high one whose fix means large
 * changes holds the work for the Commander. The orders are the unit's (seeded); the simulated
 * reviews play them out.
 */
describe('Guard findings: record, fix what is small, hold only on a high finding', () => {
  let t: TestApp;
  let unitId: string;
  let botIds: string[];
  let repo: SupplyView;

  const review = async (scenario: string, botId: string, status: string) => {
    const id = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId,
          botId,
          title: `Security review (${scenario})`,
          description: 'Review the branch for vulnerabilities.',
          repoSupplyId: repo.id,
          credentialNames: [],
          scenario,
        })
        .expect(201)
    ).body.id as string;
    await t.agent.post(`/api/tasks/${id}/run`).expect(202);
    const d = await waitFor(async () => {
      const x: TaskDetailView = (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
      return x.task.status === status ? x : null;
    });
    await settled(t.app);
    return (await t.agent.get(`/api/tasks/${id}`).expect(200)).body as TaskDetailView & typeof d;
  };

  beforeAll(async () => {
    t = await startTestApp();
    repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    const fx = await makeUnitWithBot(t.app, {
      name: 'Guard',
      role: 'Security',
      prefix: 'G',
      bots: 2,
      supplyIds: [repo.id],
      standingOrders: GUARD_STANDING_ORDERS,
    });
    unitId = fx.unit.entityId;
    botIds = fx.bots.map((b) => b.entityId);
  });
  afterAll(() => t.close());

  it('a low finding is recorded and fixed on the spot; the work goes on', async () => {
    const d = await review('guard-check', botIds[0]!, 'done');
    const diary = d.events
      .filter((e) => e.kind === 'diary.entry')
      .map((e) => (e.body as { text: string }).text);
    expect(diary).toContainEqual(expect.stringMatching(/^Finding \(low\):.*Fixed on the spot/));
    const ws = d.task.workspace!;
    expect(await git(ws.path, ['log', '--format=%s', `${ws.baseCommit}..HEAD`])).toContain(
      'Fix low finding: escape the request path in error responses',
    );
    expect(
      await git(ws.path, ['show', 'HEAD:orbot/security-review-' + d.task.number + '.md']),
    ).toContain('| low | Error responses echoed the request path unescaped | Fixed');
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention.filter((a) => a.entityId === d.task.id)).toEqual([]);
  });

  it('a high finding whose fix means large changes holds the work for the Commander, recorded first', async () => {
    const d = await review('guard-check-blocker', botIds[1]!, 'blocked');
    expect(d.task.statusReason).toMatch(/^Finding \(high\): session tokens are stored unhashed/);
    expect(d.task.statusAction).toMatch(/^Order the fix in chat .* or change the hold policy/);
    const diary = d.events
      .filter((e) => e.kind === 'diary.entry')
      .map((e) => (e.body as { text: string }).text);
    expect(diary).toContainEqual(expect.stringMatching(/^Finding \(high\):.*Holding the work/));
    expect(diary).toContainEqual(expect.stringMatching(/^Finding \(low\):.*Recorded, not holding/));
    // Recorded in the handover before holding.
    expect(d.handover?.markdown).toContain('Finding (high): session tokens are stored unhashed');
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention).toContainEqual(
      expect.objectContaining({ kind: 'blocked-bot', unitName: 'Guard', entityId: d.task.id }),
    );
  });

  it('in automatic mode nothing holds: the same high finding is recorded and the review finishes', async () => {
    const unit = (
      await t.agent
        .put(`/api/units/${unitId}/hold-policy`)
        .send({ policy: { holdFrom: 'never', fixUpTo: 'small' }, reason: 'Hardening week is over' })
        .expect(200)
    ).body;
    expect(unit.holdPolicy).toEqual({ holdFrom: 'never', fixUpTo: 'small' });
    const d = await review('guard-check-blocker', botIds[0]!, 'done');
    const diary = d.events
      .filter((e) => e.kind === 'diary.entry')
      .map((e) => (e.body as { text: string }).text);
    expect(diary).toContainEqual(
      expect.stringMatching(/^Finding \(high\):.*Recorded, not holding/),
    );
    expect(d.handover?.markdown).toContain('findings recorded');
  });

  it('with "fix anything" the large fix is made on the spot instead', async () => {
    await t.agent
      .put(`/api/units/${unitId}/hold-policy`)
      .send({ policy: { holdFrom: 'high', fixUpTo: 'large' } })
      .expect(200);
    const d = await review('guard-check-blocker', botIds[1]!, 'done');
    const ws = d.task.workspace!;
    expect(await git(ws.path, ['log', '--format=%s', `${ws.baseCommit}..HEAD`])).toContain(
      'Fix high finding: hash session tokens at rest',
    );
  });

  it('in chat: the policy is set in words, read back, and undone', async () => {
    const r = (
      await t.agent
        .post(`/api/chat/${unitId}`)
        .send({ text: 'Hold only on critical findings.' })
        .expect(201)
    ).body;
    await settled(t.app);
    expect(r.readback.body.items[0]!.summary).toBe(
      "Guard's hold policy: Findings are fixed on the spot whatever the size of the fix; a critical finding that is not fixed holds the work for the Commander.",
    );
    const unit = await t.app.get(RecordService).requireActive('unit', unitId);
    expect(unit.body.holdPolicy).toEqual({ holdFrom: 'critical', fixUpTo: 'large' });
    const log = (await t.agent.get('/api/orders').query({ unitId }).expect(200)).body as {
      entry: { id: string; body: { action: { kind: string } } };
    }[];
    const entry = log.find((l) => l.entry.body.action.kind === 'hold-policy')!;
    await t.agent.post(`/api/orders/${entry.entry.id}/undo`).expect(200);
    await settled(t.app);
    expect((await t.app.get(RecordService).requireActive('unit', unitId)).body.holdPolicy).toEqual({
      holdFrom: 'high',
      fixUpTo: 'large',
    });
  });

  it('an operation can override every unit’s policy for its own work, and go back', async () => {
    const op = (
      await t.agent
        .post('/api/operations')
        .send({ intent: 'Harden the login.', name: 'Bastion', supplyIds: [repo.id] })
        .expect(201)
    ).body;
    const set = (
      await t.agent
        .put(`/api/operations/${op.id}/hold-policy`)
        .send({ policy: { holdFrom: 'low', fixUpTo: 'none' } })
        .expect(200)
    ).body;
    expect(set.holdPolicy).toEqual({ holdFrom: 'low', fixUpTo: 'none' });
    const cleared = (
      await t.agent.put(`/api/operations/${op.id}/hold-policy`).send({ policy: null }).expect(200)
    ).body;
    expect(cleared.holdPolicy).toBeNull();
  });

  it('the force is seeded with these orders, and only the demo adds the tightened one', () => {
    expect(GUARD_STANDING_ORDERS.map((o) => o.text)).toEqual([
      'Record every finding in the War Diary and the handover, with its severity.',
      'Fix what the hold policy lets you fix on the spot and commit it; record the rest.',
      'Hold the work only as the hold policy says, with the finding, so the Commander decides.',
    ]);
  });
});
