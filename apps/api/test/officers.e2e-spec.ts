import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { ChatSendResult, MeView, OfficerView, UnitDetailView } from '@orbot/shared';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 5, Other officers: more people sign in, each with a rank. The Commander commands
 * everything; a Captain commands their units; an Observer reads. By any path: the API,
 * chat, confirmations and Undo. Passwords are in no record and no response.
 */
describe('Officers and ranks', () => {
  let t: TestApp;
  let engId: string;
  let guardId: string;
  let captain: OfficerView;
  let ada: TestAgent;
  let obs: TestAgent;
  const ADA_PASSWORD = 'correct-horse-battery-staple';
  const OBS_PASSWORD = 'observer-password-0042';

  const signIn = async (login: string, passphrase: string) => {
    const a = request.agent(t.app.getHttpServer());
    await a.post('/api/auth/login').send({ login, passphrase }).expect(200);
    return a;
  };

  beforeAll(async () => {
    t = await startTestApp();
    const repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    engId = (await makeUnitWithBot(t.app, { supplyIds: [repoId] })).unit.entityId;
    guardId = (await makeUnitWithBot(t.app, { name: 'Guard', prefix: 'G', role: 'Security' })).unit
      .entityId;
  });
  afterAll(() => t.close());

  it('the Commander appoints officers; passwords go to the secrets store, nowhere else', async () => {
    captain = (
      await t.agent
        .post('/api/officers')
        .send({
          name: 'Ada',
          login: 'Ada',
          rank: 'captain',
          unitIds: [engId],
          password: ADA_PASSWORD,
        })
        .expect(201)
    ).body;
    expect(captain).toMatchObject({ name: 'Ada', login: 'ada', rank: 'captain', unitIds: [engId] });
    await t.agent
      .post('/api/officers')
      .send({ name: 'Obi', login: 'obi', rank: 'observer', password: OBS_PASSWORD })
      .expect(201);
    await t.agent
      .post('/api/officers')
      .send({ name: 'Short', login: 'short', rank: 'observer', password: 'too-short' })
      .expect(400);
    await t.agent
      .post('/api/officers')
      .send({ name: 'Ada again', login: 'ada', rank: 'observer', password: ADA_PASSWORD })
      .expect(409);

    const everything = JSON.stringify([
      (await t.agent.get('/api/officers').expect(200)).body,
      (await t.agent.get('/api/record/events').query({ limit: 1000 }).expect(200)).body,
      (await t.agent.get(`/api/record/${captain.id}/history`).expect(200)).body,
    ]);
    expect(everything).not.toContain(ADA_PASSWORD);
    expect(everything).not.toContain('scrypt$');
    // The depot lists supply, not officers' credentials.
    const secrets = (await t.agent.get('/api/supply/secrets').expect(200)).body as {
      name: string;
    }[];
    expect(secrets.some((s) => s.name.startsWith('officer-login.'))).toBe(false);
  });

  it('officers sign in with their login and password', async () => {
    await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'ada', passphrase: 'wrong-password-123' })
      .expect(401);
    ada = await signIn('ada', ADA_PASSWORD);
    obs = await signIn('OBI', OBS_PASSWORD);
    const me: MeView = (await ada.get('/api/auth/me').expect(200)).body;
    expect(me).toMatchObject({
      principal: { kind: 'officer', id: captain.id, displayName: 'Ada', rank: 'captain' },
      rank: 'captain',
      unitIds: [engId],
    });
    expect((await obs.get('/api/auth/me').expect(200)).body.rank).toBe('observer');
    // Everyone can read.
    await obs.get('/api/orbat').expect(200);
  });

  it('a Captain commands their own units, and nothing else', async () => {
    await ada
      .post('/api/missions')
      .send({ unitId: engId, goal: 'Add audit logging', definitionOfDone: ['Logged'] })
      .expect(201);
    const refused = await ada
      .post('/api/missions')
      .send({ unitId: guardId, goal: 'Scan the deps', definitionOfDone: ['Scanned'] })
      .expect(403);
    expect(refused.body.error.message).toBe('Captain Ada does not command Guard.');
    expect(
      (await ada.put('/api/settings').send({ reason: 'x', expectedVersion: 0 }).expect(403)).body
        .error.message,
    ).toBe('Only a Commander can order that; Captain Ada commands particular units.');
    await ada.post('/api/supply/repositories').send({ name: 'x', location: '/tmp' }).expect(403);
    await ada.post('/api/stand-down').send({ scope: 'all', reason: 'Mine' }).expect(403);

    // Approving their unit's plan is theirs to do, on the record under their name.
    await settled(t.app);
    const unit: UnitDetailView = (await ada.get(`/api/units/${engId}`).expect(200)).body;
    const bb = unit.missions[0]!.backbrief!;
    await ada
      .post(`/api/backbriefs/${bb.id}/approve`)
      .send({ note: null, expectedVersion: bb.version })
      .expect(200);
    const approved = (await t.agent.get(`/api/backbriefs/${bb.id}`).expect(200)).body;
    expect(approved.decision.by).toBe(`officer:${captain.id}`);
  });

  it('chat orders outside their command are read back as not done', async () => {
    const r: ChatSendResult = (
      await ada
        .post('/api/chat/hq')
        .send({
          text: 'Engineers, stand down. Guard, stand down. Give Engineers 20 more compute budget.',
        })
        .expect(201)
    ).body;
    const rb = r.readback.body;
    expect(rb.text).toBe('Wilco.');
    expect(rb.items.map((i) => i.summary)).toEqual([
      'Engineers stood down: Commander’s order in chat. Nothing was running.',
    ]);
    expect(rb.unclear).toContain(
      'Not done: Stand down Guard — Captain Ada does not command Guard.',
    );
    expect(rb.unclear).toContain(
      "Not done: Raise Engineers' compute budget by 20 units — Only a Commander can order that; Captain Ada commands particular units.",
    );
    // Undo of someone else's order outside their command is refused too.
    const cmd: ChatSendResult = (
      await t.agent.post('/api/chat/hq').send({ text: 'Guard, stand down.' }).expect(201)
    ).body;
    await ada.post(`/api/orders/${cmd.readback.body.items[0]!.ordersLogId}/undo`).expect(403);
  });

  it('an Observer reads and asks, but orders nothing', async () => {
    const r = await obs
      .post('/api/missions')
      .send({ unitId: engId, goal: 'x', definitionOfDone: ['y'] })
      .expect(403);
    expect(r.body.error.message).toBe(
      "Observer Obi is an Observer: Observers read, they don't give orders.",
    );
    const chat: ChatSendResult = (
      await obs.post(`/api/chat/${engId}`).send({ text: 'Engineers, resume work.' }).expect(201)
    ).body;
    expect(chat.readback.body.items).toEqual([]);
    expect(chat.readback.body.text).toBe('Not done: that order is outside your command.');
  });

  it('officers change their own password, not other people’s', async () => {
    await obs
      .post(`/api/officers/${captain.id}/password`)
      .send({ password: 'x'.repeat(20) })
      .expect(403);
    const me: MeView = (await obs.get('/api/auth/me').expect(200)).body;
    await obs
      .post(`/api/officers/${me.principal.id}/password`)
      .send({ password: 'a-brand-new-password' })
      .expect(204);
    await signIn('obi', 'a-brand-new-password');
  });

  it('a retired officer is signed out at once and cannot sign in again', async () => {
    await t.agent
      .put(`/api/officers/${captain.id}`)
      .send({ retired: true, reason: 'Posted elsewhere' })
      .expect(200);
    const r = await ada.get('/api/orbat').expect(401);
    expect(r.body.error.message).toBe('Your appointment has ended.');
    await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'ada', passphrase: ADA_PASSWORD })
      .expect(401);
    // Kept on the record, never deleted.
    const list = (await t.agent.get('/api/officers').expect(200)).body as OfficerView[];
    expect(list.find((o) => o.id === captain.id)?.retired).toBe(true);
  });
});
