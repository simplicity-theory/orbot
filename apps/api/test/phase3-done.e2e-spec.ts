import type {
  ChatSendResult,
  OrdersLogEntryView,
  RecordEvent,
  TaskDetailView,
  UnitDetailView,
  VersionWithStatus,
} from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

const ORDER = 'Stop blocking on low-severity findings. I’ll give you access to the payments repo.';

/**
 * Phase 3 "done when": a rule change and a supply grant given in chat take effect
 * on live work with no other input from the Commander.
 */
describe('Phase 3: orders given in chat reach live work', () => {
  let t: TestApp;
  let guardId: string;
  let paymentsId: string;
  let ruleBlocked: string;
  let supplyBlocked: string;
  let running: string;
  let reply: ChatSendResult;

  const task = async (id: string): Promise<TaskDetailView> =>
    (await t.agent.get(`/api/tasks/${id}`).expect(200)).body;
  const unit = async (): Promise<UnitDetailView> =>
    (await t.agent.get(`/api/units/${guardId}`).expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    const appRepo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    paymentsId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'payments-service', location: await makeRepo() })
        .expect(201)
    ).body.id;
    const fx = await makeUnitWithBot(t.app, { name: 'Guard', bots: 3, supplyIds: [appRepo.id] });
    guardId = fx.unit.entityId;
    const u = await unit();
    await t.agent
      .put(`/api/units/${guardId}/standing-orders`)
      .send({
        orders: [
          { text: 'High and critical findings block release.' },
          { text: 'Low-severity findings also block release.' },
        ],
        reason: 'Initial Guard rules',
        expectedVersion: u.unit.version,
      })
      .expect(200);

    const start = async (botId: string, title: string, scenario: string) => {
      const created = (
        await t.agent
          .post('/api/tasks')
          .send({ unitId: guardId, botId, title, repoSupplyId: appRepo.id, scenario })
          .expect(201)
      ).body;
      await t.agent.post(`/api/tasks/${created.id}/run`).expect(202);
      return created.id as string;
    };
    // Two tasks blocked: one by a standing order, one waiting for supply.
    ruleBlocked = await start(
      fx.bots[0]!.entityId,
      'Security review of the login change',
      'guard-review',
    );
    supplyBlocked = await start(
      fx.bots[1]!.entityId,
      'Review payments token handling',
      'needs-supply',
    );
    await settled(t.app);
    expect((await task(ruleBlocked)).task.status).toBe('blocked');
    expect((await task(supplyBlocked)).task.status).toBe('blocked');

    // A third bot is mid-task, holding on the same standing order.
    running = await start(
      fx.bots[2]!.entityId,
      'Security review of the session change',
      'guard-review-live',
    );
    await waitFor(async () =>
      (await task(running)).events.some(
        (e) => e.kind === 'bot.step' && (e.body as { action: string }).action === 'hold',
      ),
    );

    // The one and only input: a chat message to Guard's Overseer.
    reply = (await t.agent.post(`/api/chat/${guardId}`).send({ text: ORDER }).expect(201)).body;
    await settled(t.app);
  });
  afterAll(() => t.close());

  it('reads back exactly two changes, each logged against the message', async () => {
    const rb = reply.readback.body;
    expect(rb.text).toBe('Wilco.');
    expect(rb.kinds.sort()).toEqual(['rule-change', 'supply-grant']);
    expect(rb.items.map((i) => i.summary)).toEqual([
      'Guard standing orders: dropped “Low-severity findings also block release.”; added “Stop blocking on low-severity findings.”',
      'payments-service (repository) issued to Guard.',
    ]);
    expect(rb.items.every((i) => i.reversible && i.links.length > 0)).toBe(true);

    const log: OrdersLogEntryView[] = (
      await t.agent.get('/api/orders').query({ unitId: guardId }).expect(200)
    ).body;
    const mine = log.filter((l) => l.entry.body.messageId === reply.message.id);
    expect(mine.map((l) => l.entry.body.action.kind).sort()).toEqual([
      'rule-change',
      'supply-grant',
    ]);
    expect(mine.every((l) => l.message?.body.text === ORDER)).toBe(true);
  });

  it('the rule change and the supply grant are in effect, attributed to the chat order', async () => {
    const u = await unit();
    expect(u.unit.standingOrders.map((o) => o.text)).toEqual([
      'High and critical findings block release.',
      'Stop blocking on low-severity findings.',
    ]);
    expect(u.supply.map((s) => s.name)).toContain('payments-service');
    expect(u.unit.supplyIds).toContain(paymentsId);
    expect(u.unit.updatedBy).toBe('commander:commander');
    const h: VersionWithStatus[] = (await t.agent.get(`/api/record/${guardId}/history`).expect(200))
      .body;
    expect(h.some((v) => v.reason === `Chat order: “${ORDER}”`)).toBe(true);
  });

  it('the running bot got a frago, re-read its orders and finished', async () => {
    const d = await task(running);
    expect(d.task.status).toBe('done');
    const kinds = d.events.map((e) => e.kind);
    expect(kinds).toContain('frago');
    const steps = d.events
      .filter((e) => e.kind === 'bot.step')
      .map((e) => (e.body as { action: string }).action);
    expect(steps).toEqual(expect.arrayContaining(['hold', 'frago', 'check-orders']));
  });

  it('both blocked tasks were resumed by the Overseer and finished', async () => {
    for (const id of [ruleBlocked, supplyBlocked]) {
      const d = await task(id);
      expect(d.task.status, d.task.title).toBe('done');
      const statuses = d.versions.map((v) => (v.body as { status: string }).status);
      expect(statuses).toEqual(expect.arrayContaining(['blocked', 'working', 'done']));
    }
    const sitreps = (await t.app
      .get(RecordService)
      .listEvents({ unitId: guardId, kinds: ['sitrep'], limit: 200 })) as RecordEvent<'sitrep'>[];
    expect(sitreps.filter((s) => s.body.text.startsWith('Frago: task #')).length).toBe(2);
  });

  it('nothing else was needed: the only Commander actions after setup were the chat message', async () => {
    const after = (
      await t.app.get(RecordService).listEvents({ unitId: guardId, limit: 1000 })
    ).filter((e) => e.seq > reply.message.seq);
    expect(after.filter((e) => e.actor === 'commander:commander').map((e) => e.kind)).toEqual([
      'orders.log',
      'orders.log',
    ]);
  });

  it('Undo of the rule writes a reversing entry and restores the old order (as a new version)', async () => {
    const ruleEntry = reply.readback.body.items[0]!.ordersLogId;
    await t.agent.post(`/api/orders/${ruleEntry}/undo`).expect(200);
    await settled(t.app);
    const u = await unit();
    expect(u.unit.standingOrders.map((o) => o.text)).toEqual([
      'High and critical findings block release.',
      'Low-severity findings also block release.',
    ]);
    const log: OrdersLogEntryView[] = (
      await t.agent.get('/api/orders').query({ unitId: guardId }).expect(200)
    ).body;
    const original = log.find((l) => l.entry.id === ruleEntry)!;
    expect(original.reversedBy).toBeTruthy();
    expect(log.find((l) => l.entry.id === original.reversedBy)!.entry.body.reverses).toBe(
      ruleEntry,
    );
    await t.agent.post(`/api/orders/${ruleEntry}/undo`).expect(409);
  });
});
