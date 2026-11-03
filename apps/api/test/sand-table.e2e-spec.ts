import type { ChatSendResult, OperationDetailView } from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Sand table: HQ rehearses an operation's plan against the record before the
 * work is done, and lists what would stop it. A rehearsal changes nothing.
 */
describe('Sand table', () => {
  let t: TestApp;
  let engId: string;
  let inspId: string;
  let logId: string;
  let opId: string;

  const op = async (): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${opId}`).expect(200)).body;
  const texts = (v: OperationDetailView, severity: string) =>
    v.sandTable!.body.findings.filter((f) => f.severity === severity).map((f) => f.text);

  let repo: string;
  let envId: string;

  beforeAll(async () => {
    t = await startTestApp();
    // Caps hold work only once compute limits are on (off by default, D114).
    const st = (await t.agent.get('/api/settings').expect(200)).body;
    await t.agent
      .put('/api/settings')
      .send({ computeLimits: 'on', reason: 'Test', expectedVersion: st.version })
      .expect(200);
    const repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    repo = repoId;
    // In the depot from the start (an operation needs it to plan a deploy), not yet issued.
    envId = (
      await t.agent
        .post('/api/supply/environments')
        .send({ name: 'production', tier: 'production' })
        .expect(201)
    ).body.id;
    engId = (await makeUnitWithBot(t.app, { supplyIds: [repoId] })).unit.entityId;
    inspId = (await makeUnitWithBot(t.app, { name: 'Inspection', prefix: 'I', role: 'QA' })).unit
      .entityId;
    const guard = await makeUnitWithBot(t.app, { name: 'Guard', prefix: 'G', role: 'Security' });
    logId = (await makeUnitWithBot(t.app, { name: 'Logistics', prefix: 'L', role: 'DevOps' })).unit
      .entityId;
    const record = t.app.get(RecordService);
    const ctx = { actor: 'system:test', reason: 'Fixture' };
    await record.revise(
      'unit',
      guard.unit.entityId,
      (u) => ({
        ...u,
        standingOrders: [{ id: 'so-1', text: 'Low-severity findings also block release.' }],
      }),
      ctx,
    );
    await record.revise('unit', engId, (u) => ({ ...u, computeBudget: 3 }), ctx);
  });
  afterAll(() => t.close());

  it('HQ rehearses as soon as the O Group is done: no-go, with what to do about each blocker', async () => {
    opId = (
      await t.agent
        .post('/api/operations')
        .send({
          intent: 'Ship audit logging to production.',
          name: 'Ledger',
          supplyIds: [repo, envId],
        })
        .expect(201)
    ).body.id;
    const v = await waitFor(async () => {
      const x = await op();
      return x.sandTable ? x : null;
    });
    expect(v.sandTable).toMatchObject({ actor: 'system:hq', body: { verdict: 'no-go' } });
    expect(texts(v, 'blocker')).toEqual([
      'Logistics has no production environment: the deploy will block.',
      "Engineers' compute budget runs out: the plan needs about 4 units, 3 are left.",
    ]);
    expect(texts(v, 'risk')).toContain(
      "Guard's standing order may hold the work: “Low-severity findings also block release.”",
    );
    const deploy = v.sandTable!.body.findings.find((f) => f.text.startsWith('Logistics has no'))!;
    expect(deploy).toMatchObject({
      unitId: logId,
      fix: "Give Logistics deploy rights to the operation's production environment (or site): in chat to HQ, “Give Logistics deploy rights to <its name>”, or issue it from the Supply Depot.",
      link: '/chat/hq',
    });
    expect(v.sandTable!.body.estimate).toEqual({ tasks: 4, units: 16 });
    expect(v.needsYou).toContainEqual(
      expect.objectContaining({
        kind: 'sand-table',
        label: 'Sand table: no-go for Operation Ledger (2 blockers)',
        link: `/operations/${opId}#sand-table`,
      }),
    );
    expect(v.timeline.map((e) => e.kind)).toContain('sitrep');
  });

  it('put the blockers right and rehearse again: go', async () => {
    await settled(t.app);
    await t.agent.post('/api/supply/allot').send({ supplyId: envId, unitId: logId }).expect(200);
    await t.agent
      .put(`/api/units/${engId}/budget`)
      .send({ units: 100, reason: 'Enough for Ledger' })
      .expect(200);
    const v: OperationDetailView = (
      await t.agent.post(`/api/operations/${opId}/sand-table`).expect(201)
    ).body;
    expect(v.sandTable!.actor).toMatch(/^commander:/);
    expect(v.sandTable!.body.verdict).toBe('go');
    expect(texts(v, 'blocker')).toEqual([]);
    expect(v.needsYou.some((n) => n.kind === 'sand-table')).toBe(false);
  });

  it('a stood-down unit is a blocker; chat rehearses through HQ', async () => {
    await t.agent
      .post('/api/stand-down')
      .send({ scope: 'unit', targetId: inspId, reason: 'Rig rebuild' })
      .expect(200);
    const r: ChatSendResult = (
      await t.agent
        .post('/api/chat/hq')
        .send({ text: 'Rehearse Ledger on the sand table.' })
        .expect(201)
    ).body;
    expect(r.readback.body.items[0]!.summary).toBe(
      "Sand table for Operation Ledger: no-go — Inspection is stood down (Rig rebuild): its mission won't start.",
    );
    expect(r.readback.body.items[0]!.reversible).toBe(false);
  });
});
