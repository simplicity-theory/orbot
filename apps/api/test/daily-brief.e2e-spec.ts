import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DailyBriefView, RecordEvent } from '@orbot/shared';
import { DailyBriefService } from '../src/overseer/daily-brief.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

interface Push {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * Phase 5, Daily brief with phone alerts: HQ writes the Commander a brief each day, and
 * pushes alerts to the phone (an ntfy-style URL kept in the secrets store) when something
 * needs them. The push URL never appears in the record or any response.
 */
describe('Daily brief and phone alerts', () => {
  let t: TestApp;
  let server: Server;
  let pushes: Push[] = [];
  let pushUrl: string;
  let unitId: string;
  const TOPIC = 'orbot-private-topic-7f3a9c';

  const settings = async () => (await t.agent.get('/api/settings').expect(200)).body;
  const setSettings = async (patch: Record<string, unknown>, expect = 200) => {
    const { version } = await settings();
    return t.agent
      .put('/api/settings')
      .send({ ...patch, reason: 'Test', expectedVersion: version })
      .expect(expect);
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        pushes.push({ path: req.url ?? '', headers: req.headers, body });
        res.writeHead(req.url?.includes('broken') ? 500 : 200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    pushUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${TOPIC}`;
    t = await startTestApp();
    const repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    unitId = (await makeUnitWithBot(t.app, { supplyIds: [repoId] })).unit.entityId;
    await t.agent
      .post('/api/supply/credentials')
      .send({ name: 'phone-alerts', value: pushUrl })
      .expect(201);
  });
  afterAll(async () => {
    await t.close();
    server.close();
  });

  it('alerts need a stored push URL; a test alert reaches the phone and is on the record', async () => {
    await setSettings(
      { alerts: { enabled: true, credentialName: 'no-such-thing', kinds: [] } },
      400,
    );
    await setSettings({
      alerts: {
        enabled: true,
        credentialName: 'phone-alerts',
        kinds: ['approval', 'escalation', 'daily-brief'],
      },
    });
    const sent: RecordEvent<'alert.sent'> = (await t.agent.post('/api/alerts/test').expect(201))
      .body;
    expect(sent.body).toMatchObject({
      kind: 'test',
      title: 'ORBOT test alert',
      credentialName: 'phone-alerts',
      delivered: true,
      error: null,
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      path: `/${TOPIC}`,
      body: 'Phone alerts are working. You will hear from HQ when something needs you.',
    });
    expect(pushes[0]!.headers).toMatchObject({
      title: 'ORBOT test alert',
      priority: 'default',
      tags: 'test',
      click: expect.stringMatching(/\/settings$/),
    });
  });

  it('a plan waiting for approval alerts the phone; a kind not chosen does not', async () => {
    pushes = [];
    await t.agent
      .post('/api/missions')
      .send({ unitId, goal: 'Add audit logging', definitionOfDone: ['Every write is logged'] })
      .expect(201);
    await waitFor(async () => (pushes.length ? true : null));
    expect(pushes[0]!.headers['title']).toBe('A plan waits for your approval');
    expect(pushes[0]!.headers['click']).toMatch(/\/approvals#backbrief-[0-9a-f-]{36}$/);

    await settled(t.app);
    pushes = [];
    await setSettings({
      alerts: { enabled: true, credentialName: 'phone-alerts', kinds: ['daily-brief'] },
    });
    await t.agent
      .post('/api/missions')
      .send({ unitId, goal: 'Rotate the logs', definitionOfDone: ['Logs rotate daily'] })
      .expect(201);
    await settled(t.app);
    expect(pushes).toEqual([]);
  });

  it('HQ writes the daily brief: what needs you, operations, units, what happened', async () => {
    pushes = [];
    const v: DailyBriefView = (await t.agent.post('/api/daily-brief').expect(201)).body;
    const today = new Date().toISOString().slice(0, 10);
    expect(v.latest).toMatchObject({ kind: 'daily-brief', title: `Daily brief — ${today}` });
    const md = v.latest!.markdown;
    expect(md).toContain('_Written by HQ at');
    expect(md).toContain('## Needs you (2)');
    expect(md).toContain('- Backbrief to approve: Engineers — Add audit logging');
    expect(md).toContain('| Engineers |');
    expect(md).toContain('## What happened');
    expect(v.nextAt).toMatch(/^\d{4}-\d\d-\d\dT07:00:00/);
    await waitFor(async () => (pushes.length ? true : null));
    expect(pushes[0]!.headers['title']).toBe(`Daily brief - ${today}`);

    // Written again the same day: the same document (a new version if anything changed).
    const again: DailyBriefView = (await t.agent.post('/api/daily-brief').expect(201)).body;
    expect(again.latest!.id).toBe(v.latest!.id);
    expect(again.earlier).toEqual([]);
    // Already written today: the scheduler leaves it.
    expect(await t.app.get(DailyBriefService).writeIfDue(new Date(`${today}T23:59:00Z`))).toBe(
      false,
    );
  });

  it('the daily brief time is a setting; the time zone must be real', async () => {
    await setSettings(
      { dailyBrief: { enabled: true, at: '06:30', timeZone: 'Mars/Olympus' } },
      400,
    );
    await setSettings({ dailyBrief: { enabled: true, at: '06:30', timeZone: 'Asia/Tokyo' } });
    const v: DailyBriefView = (await t.agent.get('/api/daily-brief').expect(200)).body;
    // 06:30 in Tokyo is 21:30 UTC.
    expect(v.nextAt).toMatch(/T21:30:00/);
    await setSettings({ dailyBrief: { enabled: false, at: '06:30', timeZone: 'Asia/Tokyo' } });
    expect((await t.agent.get('/api/daily-brief').expect(200)).body.nextAt).toBeNull();
  });

  it('a failed delivery is recorded, and the push URL is in no record or response', async () => {
    await t.agent
      .post('/api/supply/credentials')
      .send({ name: 'broken-alerts', value: `${pushUrl}-broken` })
      .expect(201);
    await setSettings({
      alerts: { enabled: true, credentialName: 'broken-alerts', kinds: ['daily-brief'] },
    });
    const sent: RecordEvent<'alert.sent'> = (await t.agent.post('/api/alerts/test').expect(201))
      .body;
    expect(sent.body).toMatchObject({
      delivered: false,
      error: 'The push service answered 500 Internal Server Error.',
    });
    const everything = JSON.stringify([
      (await t.agent.get('/api/alerts').expect(200)).body,
      await settings(),
      (await t.agent.get('/api/record/events').query({ limit: 1000 }).expect(200)).body,
      (await t.agent.get('/api/daily-brief').expect(200)).body,
    ]);
    expect(everything).toContain('phone-alerts');
    expect(everything).not.toContain(TOPIC);
  });
});
