import type { ChatSendResult, ChatView, OrdersLogEntryView, UnitDetailView } from '@orbot/shared';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

describe('command by chat', () => {
  let t: TestApp;
  let eng: string;
  let guard: string;
  let repoId: string;
  let botId: string;

  const say = async (channel: string, text: string): Promise<ChatSendResult> => {
    const r = (await t.agent.post(`/api/chat/${channel}`).send({ text }).expect(201)).body;
    await settled(t.app);
    return r;
  };
  const unit = async (id: string): Promise<UnitDetailView> =>
    (await t.agent.get(`/api/units/${id}`).expect(200)).body;
  const log = async (): Promise<OrdersLogEntryView[]> =>
    (await t.agent.get('/api/orders').expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    await t.agent
      .post('/api/supply/environments')
      .send({ name: 'production', tier: 'production' })
      .expect(201);
    const e = await makeUnitWithBot(t.app, { name: 'Engineers', supplyIds: [repoId] });
    eng = e.unit.entityId;
    botId = e.bot.entityId;
    guard = (await makeUnitWithBot(t.app, { name: 'Guard', supplyIds: [repoId] })).unit.entityId;
  });
  afterAll(() => t.close());

  it('a question is answered and changes nothing', async () => {
    const before = (await log()).length;
    const r = await say(eng, 'How is Engineers doing?');
    expect(r.readback.body.kinds).toEqual(['question']);
    expect(r.readback.body.items).toEqual([]);
    expect(r.readback.body.text).toMatch(/^Engineers: 0 working/);
    expect((await log()).length).toBe(before);
  });

  it('an order creates a mission; the Overseer’s plan goes ahead without waiting (you ordered it)', async () => {
    const r = await say(eng, 'Add rate limiting to the API.');
    expect(r.readback.body.text).toBe('Wilco.');
    expect(r.readback.body.kinds).toEqual(['order']);
    expect(r.readback.body.items[0]!.summary).toBe(
      'New mission for Engineers: “Add rate limiting to the API”. You ordered it, so the Overseer’s plan goes ahead without waiting for approval.',
    );
    const u = await unit(eng);
    expect(u.missions.map((m) => m.mission.goal)).toEqual(['Add rate limiting to the API']);
    expect(u.missions[0]!.backbrief?.status).toBe('approved');
    expect(u.missions[0]!.mission.preApproved).toBe(true);
    // Nothing waits for the Commander: the order was the decision.
    expect(u.backbriefs).toEqual([]);
  });

  it('Undo of an order withdraws the mission (a new entry; the old one stays)', async () => {
    const entry = (await log()).find((l) => l.entry.body.action.kind === 'create-mission')!;
    await t.agent.post(`/api/orders/${entry.entry.id}/undo`).expect(200);
    await settled(t.app);
    const u = await unit(eng);
    expect(u.backbriefs).toEqual([]);
    expect(u.missions[0]!.mission.status).toBe('withdrawn');
    const after = await log();
    expect(after.find((l) => l.entry.id === entry.entry.id)!.reversedBy).toBeTruthy();
  });

  it('a frago stands down matching work in progress, and Undo resumes it', async () => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId: eng, botId, title: 'Build the mobile layout', repoSupplyId: repoId })
        .expect(201)
    ).body;
    const r = await say(eng, 'Drop the mobile layout for now.');
    expect(r.readback.body.kinds).toEqual(['frago']);
    expect(r.readback.body.items[0]!.summary).toMatch(/stood down #\d+ Build the mobile layout/);
    expect((await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body.task.status).toBe(
      'stood-down',
    );
    await t.agent.post(`/api/orders/${r.readback.body.items[0]!.ordersLogId}/undo`).expect(200);
    await settled(t.app);
    // Commander-issued work restarts on resume; at simulation speed it is already done.
    expect(['queued', 'working', 'done']).toContain(
      (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body.task.status,
    );
  });

  it('"Resume #N: …" on a blocked task restarts it with the note as a frago', async () => {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: eng,
          botId,
          title: 'Wire the client',
          repoSupplyId: repoId,
          scenario: 'blocked-on-dependency',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await waitFor(async () =>
      (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body.task.status === 'blocked'
        ? true
        : null,
    );
    const r = await say(eng, `Resume #${task.number}: the upstream client is in now.`);
    expect(r.readback.body.items[0]!.summary).toMatch(/^Resumed #\d+ Wire the client/);
    const d = await waitFor(async () => {
      const x = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
      return x.events.filter((e: { kind: string }) => e.kind === 'run.started').length >= 2
        ? x
        : null;
    });
    expect(d.task.description).toContain('Frago: Resume #');
    expect(d.task.description).toContain('the upstream client is in now');
  });

  it('musing is not ordering: nothing changes until the Commander says so', async () => {
    const before = (await unit(eng)).unit.computeBudget;
    const r = await say(eng, 'I might give you more budget.');
    expect(r.readback.body.text).toBe('Did you mean that as an order?');
    expect(r.readback.body.items).toEqual([]);
    const pending = r.readback.body.pending[0]!;
    expect(pending.reason).toBe('musing');
    expect((await unit(eng)).unit.computeBudget).toBe(before);

    await t.agent.post(`/api/pending/${pending.pendingId}/confirm`).send({}).expect(200);
    await settled(t.app);
    expect((await unit(eng)).unit.computeBudget).toBe(before + 10);
    await t.agent.post(`/api/pending/${pending.pendingId}/confirm`).send({}).expect(409);

    const r2 = await say(eng, 'Maybe you could have more budget.');
    await t.agent
      .post(`/api/pending/${r2.readback.body.pending[0]!.pendingId}/decline`)
      .expect(200);
    expect((await unit(eng)).unit.computeBudget).toBe(before + 10);

    // "Do it" in chat confirms what the Overseer last proposed; said again, nothing is open.
    const r3 = await say(eng, 'Perhaps a bit more budget.');
    expect(r3.readback.body.pending).toHaveLength(1);
    const yes = await say(eng, 'Do it.');
    expect(yes.readback.body.text).toBe('Wilco.');
    expect(yes.readback.body.items).toHaveLength(1);
    expect((await unit(eng)).unit.computeBudget).toBe(before + 20);
    const again = await say(eng, 'Do it.');
    expect(again.readback.body.items).toEqual([]);
    expect(again.readback.body.text).not.toBe('Wilco.');
  });

  it('irreversible orders wait for a typed one-line confirmation', async () => {
    const r = await say(eng, 'Grant Engineers production deploy rights.');
    expect(r.readback.body.text).toBe('That cannot be undone. Confirm and I will act.');
    const p = r.readback.body.pending[0]!;
    expect(p).toMatchObject({ reason: 'irreversible', phrase: 'confirm' });
    expect((await unit(eng)).supply.map((s) => s.name)).not.toContain('production');

    const wrong = await t.agent
      .post(`/api/pending/${p.pendingId}/confirm`)
      .send({ phrase: 'yes' })
      .expect(400);
    expect(wrong.body.error.action).toBe('Type “confirm” to go ahead.');
    const done = (
      await t.agent
        .post(`/api/pending/${p.pendingId}/confirm`)
        .send({ phrase: 'Confirm' })
        .expect(200)
    ).body;
    expect(done.body.items[0]).toMatchObject({
      reversible: false,
      summary: 'Engineers now has deploy rights to production.',
    });
    await settled(t.app);
    expect((await unit(eng)).supply.map((s) => s.name)).toContain('production');
  });

  it('promised supply that is not connected changes nothing and says exactly what is missing', async () => {
    const before = (await unit(eng)).supply.length;
    const r = await say(eng, 'I’ll give you access to the billing repo.');
    expect(r.readback.body.items).toEqual([]);
    expect(r.readback.body.missing).toEqual(['billing repository']);
    expect(r.readback.body.text).toMatch(/not in the Supply Depot/);
    expect((await unit(eng)).supply.length).toBe(before);
  });

  it('a cross-unit order is routed via HQ and lands in the other unit’s channel', async () => {
    const r = await say(eng, 'Guard, review the session cookie flags.');
    expect(r.readback.body.items[0]).toMatchObject({
      routedVia: 'hq',
      summary: expect.stringContaining('New mission for Guard'),
    });
    const guardChat: ChatView = (await t.agent.get(`/api/chat/${guard}`).expect(200)).body;
    const relay = guardChat.items.find((i) => (i.body as { from?: string }).from === 'hq')!;
    expect((relay.body as { text: string }).text).toMatch(
      /^Order from the Commander, relayed by HQ: New mission for Guard/,
    );
    expect((relay.body as { relayedFrom: string }).relayedFrom).toBe(eng);
  });

  it('to HQ, an order naming no unit launches an operation; anything else asks which unit', async () => {
    const r = await say('hq', 'Add audit logging.');
    expect(r.readback.body.items[0]).toMatchObject({
      routedVia: 'hq',
      summary: expect.stringMatching(/^Operation Audit Logging launched/),
    });
    const r2 = await say('hq', 'The login page needs a dark theme.');
    expect(r2.readback.body.items).toEqual([]);
    expect(r2.readback.body.unclear[0]).toMatch(/which unit should do this/);
  });

  it('the chat view shows both sides, undo state and answered pending items', async () => {
    const v: ChatView = (await t.agent.get(`/api/chat/${eng}`).expect(200)).body;
    expect(v.label).toBe('Engineers Overseer (E-0)');
    expect(v.items.filter((i) => i.kind === 'chat.message').length).toBeGreaterThan(5);
    expect(v.items.filter((i) => i.kind === 'chat.readback').length).toBeGreaterThan(5);
    expect(Object.keys(v.reversed).length).toBeGreaterThanOrEqual(2);
    expect(Object.values(v.resolved)).toEqual(expect.arrayContaining(['confirmed', 'declined']));
  });

  it('secrets typed into chat are masked in the record and the reply', async () => {
    const r = await say(eng, 'Use token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 for the push?');
    expect(r.message.body.text).toContain('[REDACTED:github-token]');
    expect(JSON.stringify(r)).not.toContain('ghp_aBcD');
  });

  it('an unknown channel is a plain-language 404', async () => {
    const r = await t.agent
      .post('/api/chat/11111111-1111-4111-8111-111111111111')
      .send({ text: 'hi' })
      .expect(404);
    expect(r.body.error.message).toMatch(/No unit/);
  });
});
