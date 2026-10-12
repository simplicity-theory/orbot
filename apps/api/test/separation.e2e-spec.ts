import type { BackbriefView, RecordEvent, UnitDetailView } from '@orbot/shared';
import { ActionsService } from '../src/chat/actions.service.js';
import { BudgetService } from '../src/overseer/budget.service.js';
import { OverseerService } from '../src/overseer/overseer.service.js';
import { StandDownService } from '../src/overseer/stand-down.service.js';
import { RecordService } from '../src/record/record.service.js';
import { SupplyService } from '../src/supply/supply.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Separation of duties: a bot can't approve its own work, change its own rules,
 * or grant itself supply (nor lift its own stand-down) — by any path. Bots have no HTTP
 * identity, so this calls the services the way a bot's actions would reach them.
 */
describe('Separation of duties', () => {
  let t: TestApp;
  let unitId: string;
  let overseer: string;
  let worker: string;
  let repoId: string;
  let otherSupply: string;
  const refusals = async () =>
    (
      (await t.agent.get('/api/record/events').query({ kinds: 'policy.check' }).expect(200))
        .body as RecordEvent<'policy.check'>[]
    ).filter((e) => e.body.reason.startsWith('Separation of duties:'));

  beforeAll(async () => {
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    otherSupply = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'payments', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const fx = await makeUnitWithBot(t.app, { supplyIds: [repoId] });
    unitId = fx.unit.entityId;
    overseer = `bot:${fx.overseer!.entityId}`;
    worker = `bot:${fx.bot.entityId}`;
  });
  afterAll(() => t.close());

  it('an Overseer cannot approve the plan it wrote; the Commander can', async () => {
    await t.agent
      .post('/api/missions')
      .send({ unitId, goal: 'Add audit logging', definitionOfDone: ['Every write is logged'] })
      .expect(201);
    await settled(t.app);
    const unit: UnitDetailView = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
    const bb = unit.missions[0]!.backbrief!;
    expect(bb.status).toBe('awaiting-approval');

    await expect(
      t.app
        .get(OverseerService)
        .approve(bb.id, { note: null, expectedVersion: bb.version }, overseer),
    ).rejects.toThrow(/Refused: E-0 — a bot cannot approve its own work/);
    const still: BackbriefView = (await t.agent.get(`/api/backbriefs/${bb.id}`).expect(200)).body;
    expect(still.status).toBe('awaiting-approval');

    await t.agent
      .post(`/api/backbriefs/${bb.id}/approve`)
      .send({ note: null, expectedVersion: bb.version })
      .expect(200);
  });

  it('on “escalations only”, plans are approved by HQ under delegation — not by their author', async () => {
    const auto = await makeUnitWithBot(t.app, {
      name: 'Inspection',
      prefix: 'I',
      gate: 'escalations-only',
      supplyIds: [repoId],
    });
    await t.agent
      .post('/api/missions')
      .send({
        unitId: auto.unit.entityId,
        goal: 'Load-test the login',
        definitionOfDone: ['p99 under 200 ms'],
      })
      .expect(201);
    await settled(t.app);
    const unit: UnitDetailView = (await t.agent.get(`/api/units/${auto.unit.entityId}`).expect(200))
      .body;
    const bb = unit.missions[0]!.backbrief!;
    expect(bb.status).toBe('approved');
    expect(bb.updatedBy).toBe('system:hq');
  });

  it('a bot cannot change its own unit’s rules, by chat action or directly', async () => {
    await expect(
      t.app.get(ActionsService).run(
        {
          kind: 'rule-change',
          unitId,
          removeOrders: [],
          addOrders: ['Skip code review on Fridays.'],
          removeRoe: [],
          addRoe: [],
        },
        { actor: overseer, reason: 'I decided' },
      ),
    ).rejects.toThrow(/cannot change its own unit’s rules/);
    await expect(
      t.app
        .get(RecordService)
        .revise('unit', unitId, (u) => ({ ...u, approvalGate: 'escalations-only' }), {
          actor: worker,
          reason: 'Fewer approvals',
        }),
    ).rejects.toThrow(/cannot change its own unit’s rules/);
    const unit = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body.unit;
    expect(unit.standingOrders).toEqual([]);
    expect(unit.approvalGate).toBe('backbriefs-and-deploys');
  });

  it('a bot cannot grant itself supply or budget; the Commander can', async () => {
    await expect(
      t.app
        .get(SupplyService)
        .allotToUnit(otherSupply, unitId, { actor: worker, reason: 'Mine now' }),
    ).rejects.toThrow(/cannot grant itself/);
    await expect(
      t.app.get(BudgetService).setUnitCap(unitId, 1000, 'More please', overseer),
    ).rejects.toThrow(/cannot grant itself/);

    await t.app
      .get(SupplyService)
      .allotToUnit(otherSupply, unitId, { actor: 'commander:test', reason: 'Granted' });
    const unit = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body.unit;
    expect(unit.supplyIds).toContain(otherSupply);
  });

  it('a bot cannot approve its own production deploy', async () => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, title: 'Deploy audit logging', repoSupplyId: repoId })
        .expect(201)
    ).body;
    const record = t.app.get(RecordService);
    await record.revise(
      'task',
      task.id,
      (b) => ({
        ...b,
        kind: 'deploy',
        approval: { kind: 'production-deploy', status: 'pending', by: null, at: null, note: null },
      }),
      { actor: 'system:test', reason: 'A production deploy' },
    );
    await expect(
      t.app.get(OverseerService).decideDeploy(task.id, true, null, overseer),
    ).rejects.toThrow(/cannot approve its own work/);
    expect((await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body.task.approval.status).toBe(
      'pending',
    );
  });

  it('a bot cannot lift a stand-down that covers it', async () => {
    const sd = t.app.get(StandDownService);
    await sd.standDown({ scope: 'unit', targetId: unitId }, 'Audit', 'commander:test');
    await expect(sd.lift({ scope: 'unit', targetId: unitId }, 'Done here', worker)).rejects.toThrow(
      /cannot lift a stand-down that covers itself/,
    );
    await sd.lift({ scope: 'unit', targetId: unitId }, 'Audit over', 'commander:test');
  });

  it('every refusal is on the record, by bot, with the rule that refused it', async () => {
    const r = await waitFor(async () => {
      const x = await refusals();
      return x.length >= 7 ? x : null;
    });
    expect(r.every((e) => e.body.allowed === false && e.actor.startsWith('bot:'))).toBe(true);
    expect(r.map((e) => e.body.action).sort()).toEqual(
      [
        'duty:approve-own-work',
        'duty:approve-own-work',
        'duty:change-own-rules',
        'duty:change-own-rules',
        'duty:grant-own-supply',
        'duty:grant-own-supply',
        'duty:lift-own-stand-down',
      ].sort(),
    );
  });
});
