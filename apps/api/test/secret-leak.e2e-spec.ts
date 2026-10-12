import { randomBytes } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { TaskDetailView } from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { RedactingLogger } from '../src/redaction/redacting-logger.js';
import { makeRepo, makeUnitWithBot, waitFor } from './fixtures.js';
import { asRole, startTestApp, TEST_PASSPHRASE, type TestApp } from './helpers.js';

/**
 * Principle 5: secrets stay out of every record. These tests try to leak a
 * stored credential through every path we have and then scan everything.
 */
describe('secrets never leak', () => {
  let t: TestApp;
  let unitId: string;
  let botId: string;
  let repoId: string;
  const SECRET = `sk-live-${randomBytes(18).toString('base64url')}`;
  const SECRET_B64 = Buffer.from(SECRET).toString('base64');
  const wsMessages: string[] = [];
  let socket: Socket;

  const assertClean = (s: string, where: string) => {
    expect(s.includes(SECRET), `${where} contains the secret`).toBe(false);
    expect(s.includes(SECRET_B64), `${where} contains the base64 secret`).toBe(false);
  };

  async function runTask(scenario: string): Promise<TaskDetailView> {
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId,
          botId,
          title: `Leak attempt ${scenario}`,
          repoSupplyId: repoId,
          credentialNames: ['leaky-token'],
          scenario,
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    return waitFor(async () => {
      const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
      return ['done', 'failed'].includes(d.task.status) ? d : null;
    });
  }

  beforeAll(async () => {
    t = await startTestApp();
    await t.app.listen(0);
    const port = (t.app.getHttpServer().address() as { port: number }).port;
    const login = await t.agent
      .post('/api/auth/login')
      .send({ passphrase: TEST_PASSPHRASE })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    socket = io(`http://127.0.0.1:${port}`, {
      path: '/api/ws',
      extraHeaders: { cookie },
      transports: ['websocket'],
    });
    socket.onAny((_e, payload) => wsMessages.push(JSON.stringify(payload)));
    await new Promise<void>((res, rej) => {
      socket.on('connect', () => res());
      socket.on('connect_error', rej);
    });

    const repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'r', location: await makeRepo() })
        .expect(201)
    ).body;
    repoId = repo.id;
    const fx = await makeUnitWithBot(t.app);
    unitId = fx.unit.entityId;
    botId = fx.bot.entityId;
  });
  afterAll(async () => {
    socket?.close();
    await t.close();
  });

  it('storing a credential never echoes the value', async () => {
    const r = await t.agent
      .post('/api/supply/credentials')
      .send({ name: 'leaky-token', value: SECRET })
      .expect(201);
    assertClean(JSON.stringify(r.body), 'store response');
    expect(r.body.spec).toEqual({ kind: 'credential', secretName: 'leaky-token' });
    const list = await t.agent.get('/api/supply/secrets').expect(200);
    assertClean(JSON.stringify(list.body), 'secrets list');
    expect(list.body[0]).toEqual(expect.objectContaining({ name: 'leaky-token', revoked: false }));
  });

  it('via chat: a message containing the secret is masked in the record', async () => {
    const ev = await t.app.get(RecordService).event(
      'chat.message',
      {
        channel: unitId,
        from: 'commander',
        text: `here is the token: ${SECRET}`,
        relayedFrom: null,
      },
      { unitId },
      'commander:commander',
    );
    assertClean(JSON.stringify(ev), 'chat event');
    expect(ev.body.text).toBe('here is the token: [REDACTED:secret]');
  });

  it('via diary, sitrep, working record and handover: a rogue bot is masked everywhere', async () => {
    const d = await runTask('rogue-leak');
    expect(d.task.status).toBe('done');
    assertClean(JSON.stringify(d), 'task view');
    const kinds = d.events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['diary.entry', 'sitrep', 'bot.step', 'redaction.applied']),
    );
    const diary = d.events.find((e) => e.kind === 'diary.entry')!;
    expect(JSON.stringify(diary.body)).toContain('[REDACTED:secret]');
    expect(d.handover!.markdown).toContain('[REDACTED:secret]');
  });

  it('via errors: a runtime crash quoting the secret is masked in the task, the log and the response', async () => {
    const d = await runTask('rogue-crash');
    expect(d.task.status).toBe('failed');
    expect(d.task.statusReason).toContain('[REDACTED:secret]');
    assertClean(JSON.stringify(d), 'crashed task view');
    assertClean(t.logs.text, 'logs after crash');
  });

  it('via API error messages', async () => {
    const r = await t.agent
      .post('/api/supply/repositories')
      .send({ name: 'x', location: `/no/such/${SECRET}` })
      .expect(400);
    assertClean(JSON.stringify(r.body), 'error response');
    expect(r.body.error.message).toContain('[REDACTED:secret]');
  });

  it('via API responses: a document containing the secret is stored and returned masked', async () => {
    const r = await t.agent
      .post('/api/documents')
      .send({
        kind: 'note',
        unitId,
        title: 'notes',
        markdown: `deploy with ${SECRET} and ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`,
      })
      .expect(201);
    assertClean(JSON.stringify(r.body), 'document response');
    expect(r.body.markdown).toBe('deploy with [REDACTED:secret] and [REDACTED:github-token]');
  });

  it('via logs: anything logged is masked', () => {
    const logger = t.app.get(RedactingLogger);
    logger.log(`connecting with ${SECRET}`, 'LeakTest');
    logger.error(new Error(`bad token ${SECRET}`), 'LeakTest');
    logger.raw.info({ password: 'hunter2-not-the-secret', token: SECRET }, 'structured');
    assertClean(t.logs.text, 'logs');
    expect(t.logs.text).toContain('connecting with [REDACTED:secret]');
    expect(t.logs.text).not.toContain('hunter2-not-the-secret');
  });

  it('via the WebSocket feed', () => {
    expect(wsMessages.length).toBeGreaterThan(10);
    assertClean(wsMessages.join('\n'), 'websocket messages');
  });

  it('the value is nowhere in the record database, and only encrypted in the secrets store', async () => {
    const dump = await asRole(t.config.recordDb.owner, async (c) => {
      const out: string[] = [];
      for (const table of ['record_version', 'record_supersession', 'record_event']) {
        const { rows } = await c.query<{ row: string }>(`SELECT t::text AS row FROM ${table} t`);
        out.push(...rows.map((r) => r.row));
      }
      return out.join('\n');
    });
    expect(dump.length).toBeGreaterThan(1000);
    assertClean(dump, 'record database');

    const secrets = await asRole(t.config.secretsDb, async (c) => {
      const { rows } = await c.query<{ row: string }>(
        `SELECT encode(ciphertext, 'escape') || name AS row FROM secret`,
      );
      return rows.map((r) => r.row).join('\n');
    });
    assertClean(secrets, 'secrets database');
  });

  it('records that a credential was used, by name', async () => {
    const used = await t.app
      .get(RecordService)
      .listEvents({ kinds: ['credential.used'], limit: 100 });
    expect(used.length).toBeGreaterThan(0);
    for (const u of used)
      expect(u.body).toEqual(expect.objectContaining({ secretName: 'leaky-token' }));
  });
});
