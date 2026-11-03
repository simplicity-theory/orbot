import type {
  ChatSendResult,
  NewTheatreView,
  OperationDetailView,
  SupplyView,
  TheatreDetailView,
  TheatreSummary,
} from '@orbot/shared';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * A theatre is a project: it holds the repository and the site once, and every operation
 * launched in it starts with both (D121). Opened from the web and in chat; closed only once its
 * operations are over.
 */
describe('Theatres', () => {
  let t: TestApp;

  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const theatre = async (id: string): Promise<TheatreDetailView> =>
    (await t.agent.get(`/api/theatres/${id}`).expect(200)).body;

  beforeAll(async () => {
    t = await startTestApp();
    await makeUnitWithBot(t.app, { name: 'Engineers' });
    await makeUnitWithBot(t.app, { name: 'Logistics', role: 'Deploy', prefix: 'L' });
  });
  afterAll(() => t.close());

  it('opens with a template repository and a site, and launches the first operation equipped with both', async () => {
    const r: NewTheatreView = (
      await t.agent
        .post('/api/theatres')
        .send({
          name: 'Ledger',
          description: 'A personal ledger.',
          repository: { kind: 'template', template: 'single-html' },
          site: true,
          intent: 'Build the first version.',
        })
        .expect(201)
    ).body;
    expect(r.theatre).toMatchObject({ name: 'Ledger', status: 'open' });
    expect(r.repository?.spec).toMatchObject({
      kind: 'repository',
      project: { kind: 'single-html' },
    });
    expect(r.site?.spec.kind).toBe('environment');
    expect((r.site?.spec as { site?: unknown }).site).toBeTruthy();
    expect(r.theatre.supplyIds).toEqual([r.repository!.id, r.site!.id]);
    expect(r.theatre.repoSupplyId).toBe(r.repository!.id);
    expect(r.operation?.theatreId).toBe(r.theatre.id);
    expect(r.operation?.supplyIds).toEqual([r.repository!.id, r.site!.id]);

    const v = await waitFor(async () => {
      const x = await op(r.operation!.id);
      return x.operation.phase !== 'intent' ? x : null;
    });
    expect(v.theatre).toEqual({ id: r.theatre.id, name: 'Ledger' });
    expect(v.resources.mainRepositoryId).toBe(r.repository!.id);

    const list: TheatreSummary[] = (await t.agent.get('/api/theatres').expect(200)).body;
    expect(list.map((x) => x.theatre.name)).toEqual(['Ledger']);
    expect(list[0]!.site).toMatchObject({ name: 'Ledger site', url: `/api/sites/${r.site!.id}/` });
    expect(list[0]!.operations.map((o) => o.name)).toEqual(['Ledger']);
  });

  it('a second intent in the theatre starts with what the theatre holds; nothing is assigned twice', async () => {
    const [th] = (await t.agent.get('/api/theatres').expect(200)).body as TheatreSummary[];
    const launched = (
      await t.agent
        .post(`/api/theatres/${th!.theatre.id}/operations`)
        .send({ intent: 'Add recurring entries.', name: 'Recurring' })
        .expect(201)
    ).body;
    expect(launched.theatreId).toBe(th!.theatre.id);
    expect(launched.supplyIds).toEqual(th!.theatre.supplyIds);
    const d = await theatre(th!.theatre.id);
    expect(d.operations.map((o) => o.operation.name).sort()).toEqual(['Ledger', 'Recurring']);
  });

  it('holds an existing repository from the depot, and takes resources on and off', async () => {
    const repo: SupplyView = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'billing', location: await makeRepo() })
        .expect(201)
    ).body;
    const r: NewTheatreView = (
      await t.agent
        .post('/api/theatres')
        .send({ name: 'Billing', repository: { kind: 'existing', supplyId: repo.id }, site: false })
        .expect(201)
    ).body;
    expect(r.theatre.repoSupplyId).toBe(repo.id);
    expect(r.site).toBeNull();
    const env: SupplyView = (
      await t.agent
        .post('/api/supply/environments')
        .send({ name: 'staging', tier: 'staging' })
        .expect(201)
    ).body;
    const after: TheatreDetailView = (
      await t.agent
        .post(`/api/theatres/${r.theatre.id}/resources`)
        .send({ supplyId: env.id })
        .expect(201)
    ).body;
    expect(after.resources.map((s) => s.name)).toEqual(['billing', 'staging']);
    const released: TheatreDetailView = (
      await t.agent
        .post(`/api/theatres/${r.theatre.id}/resources/release`)
        .send({ supplyId: env.id })
        .expect(200)
    ).body;
    expect(released.resources.map((s) => s.name)).toEqual(['billing']);
  });

  it('in chat: "Open a theatre called X: …" opens it and launches the first operation', async () => {
    const r: ChatSendResult = (
      await t.agent
        .post('/api/chat/hq')
        .send({ text: 'Open a theatre called Pocket Notes: a notes app that works offline.' })
        .expect(201)
    ).body;
    await settled(t.app);
    expect(r.readback.body.text).toBe('Wilco.');
    expect(r.readback.body.items[0]!.summary).toMatch(
      /^Theatre Pocket Notes opened on Pocket Notes, publishing to Pocket Notes site\. Operation Pocket Notes launched in it/,
    );
    const list: TheatreSummary[] = (await t.agent.get('/api/theatres').expect(200)).body;
    expect(list.map((x) => x.theatre.name).sort()).toEqual(['Billing', 'Ledger', 'Pocket Notes']);
  });

  it('closes only once its operations are over', async () => {
    const list: TheatreSummary[] = (await t.agent.get('/api/theatres').expect(200)).body;
    const ledger = list.find((x) => x.theatre.name === 'Ledger')!;
    const refused = await t.agent
      .post(`/api/theatres/${ledger.theatre.id}/close`)
      .send({ note: 'Done' })
      .expect(409);
    expect(refused.body.error.message).toMatch(/still has 2 operation\(s\) under way/);
    for (const o of ledger.operations) {
      await t.agent.post(`/api/operations/${o.id}/cancel`).send({ note: 'Test' }).expect(200);
    }
    const closed: TheatreDetailView = (
      await t.agent
        .post(`/api/theatres/${ledger.theatre.id}/close`)
        .send({ note: 'Done' })
        .expect(200)
    ).body;
    expect(closed.theatre).toMatchObject({ status: 'closed', closed: { note: 'Done' } });
    await t.agent
      .post(`/api/theatres/${ledger.theatre.id}/operations`)
      .send({ intent: 'More.' })
      .expect(400);
  });
});
