import type {
  ApprovalsView,
  CampaignSummary,
  ChatSendResult,
  NewTheatreView,
  OperationDetailView,
  TheatreDetailView,
} from '@orbot/shared';
import { makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * A campaign is a sequence of operations toward one end, inside a theatre (D126): the
 * Commander plans the steps once, HQ launches each as an operation when the one before it
 * closes. A cancelled step holds the campaign for the Commander: start it over, skip it, or
 * call the campaign off. Planned from the web and in chat.
 */
describe('Campaigns', () => {
  let t: TestApp;
  let theatreId: string;
  /** A theatre whose operations wait for the Commander's approval: steps that never finish by themselves. */
  let gateId: string;

  const campaign = async (id: string): Promise<CampaignSummary> =>
    (await t.agent.get(`/api/campaigns/${id}`).expect(200)).body;
  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const plan = async (name: string, intents: string[]): Promise<CampaignSummary> =>
    (
      await t.agent
        .post(`/api/theatres/${gateId}/campaigns`)
        .send({ name, steps: intents.map((intent) => ({ intent })) })
        .expect(201)
    ).body;
  const confirm = async (r: ChatSendResult) => {
    await t.agent
      .post(`/api/pending/${r.readback.body.pending[0]!.pendingId}/confirm`)
      .send({ phrase: 'confirm' })
      .expect(200);
    await settled(t.app);
  };

  beforeAll(async () => {
    t = await startTestApp();
    await makeUnitWithBot(t.app, { name: 'Engineers' });
    await makeUnitWithBot(t.app, { name: 'Logistics', role: 'Deploy', prefix: 'L' });
    const r: NewTheatreView = (
      await t.agent
        .post('/api/theatres')
        .send({
          name: 'Ledger',
          repository: { kind: 'template', template: 'single-html' },
          site: true,
        })
        .expect(201)
    ).body;
    theatreId = r.theatre.id;
    const g: NewTheatreView = (
      await t.agent
        .post('/api/theatres')
        .send({
          name: 'Gate',
          repository: { kind: 'template', template: 'single-html' },
          site: true,
          autonomy: 'approve',
        })
        .expect(201)
    ).body;
    gateId = g.theatre.id;
  });
  afterAll(() => t.close());

  it('step 1 launches at once; each next step when the one before it closes; done at the end', async () => {
    const c = (
      await t.agent
        .post(`/api/theatres/${theatreId}/campaigns`)
        .send({
          name: 'Polish',
          description: 'A ledger people like using.',
          steps: [
            { intent: 'Build the first version.' },
            { name: 'Dark mode', intent: 'Add a dark mode toggle.' },
          ],
        })
        .expect(201)
    ).body as CampaignSummary;
    expect(c.campaign).toMatchObject({ name: 'Polish', status: 'under-way', current: 0 });
    expect(c.theatre).toEqual({ id: theatreId, name: 'Ledger' });
    expect(c.steps[0]).toMatchObject({
      name: 'Build the first version',
      status: 'under-way',
      operation: { name: 'Build the first version', phase: expect.any(String) },
    });
    expect(c.steps[1]).toMatchObject({ name: 'Dark mode', status: 'waiting', operation: null });
    const first = await op(c.steps[0]!.operation!.id);
    expect(first.operation.campaignId).toBe(c.campaign.id);
    expect(first.operation.theatreId).toBe(theatreId);
    expect(first.campaign).toEqual({ id: c.campaign.id, name: 'Polish', step: 1, of: 2 });

    const done = await waitFor(async () => {
      const x = await campaign(c.campaign.id);
      return x.campaign.status === 'done' ? x : null;
    }, 90_000);
    expect(done.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(done.steps.map((s) => s.operation?.phase)).toEqual(['closed', 'closed']);
    expect(done.campaign.closed?.note).toBe('Every step done');
    const second = await op(done.steps[1]!.operation!.id);
    expect(second.operation.deployment).toBeTruthy();
    expect(second.campaign?.step).toBe(2);
    const th: TheatreDetailView = (await t.agent.get(`/api/theatres/${theatreId}`).expect(200))
      .body;
    expect(th.campaigns.map((x) => x.campaign.name)).toEqual(['Polish']);
    expect(th.operations.map((o) => o.operation.name).sort()).toEqual([
      'Build the first version',
      'Dark mode',
    ]);
  }, 100_000);

  it('a cancelled step holds the campaign for the Commander: skip it, start it over, or call it off', async () => {
    const c = await plan('Hold', ['Add tags.', 'Add search.']);
    await t.agent
      .post(`/api/operations/${c.steps[0]!.operation!.id}/cancel`)
      .send({ note: 'Wrong idea' })
      .expect(200);
    const held = await waitFor(async () => {
      const x = await campaign(c.campaign.id);
      return x.campaign.status === 'held' ? x : null;
    });
    expect(held.campaign.held).toBe('Operation Add tags (step 1) was cancelled: Wrong idea');
    expect(held.steps[0]!.status).toBe('held');
    expect(held.needsYou[0]).toMatchObject({
      kind: 'campaign',
      title: 'Campaign Hold · step 1 of 2',
      next: 'Start the step over, skip it, or call the campaign off.',
      link: `/campaigns/${c.campaign.id}`,
    });
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention.map((a) => a.title)).toContain('Campaign Hold · step 1 of 2');

    // Skip it: step 2 launches.
    const skipped: CampaignSummary = (
      await t.agent.post(`/api/campaigns/${c.campaign.id}/resume`).send({ skip: true }).expect(200)
    ).body;
    expect(skipped.campaign).toMatchObject({ status: 'under-way', current: 1, held: null });
    expect(skipped.steps[1]!.operation?.name).toBe('Add search');
    const firstTry = skipped.steps[1]!.operation!.id;

    // Cancelled again: start the step over, as a new operation.
    await t.agent.post(`/api/operations/${firstTry}/cancel`).send({ note: '' }).expect(200);
    await waitFor(async () =>
      (await campaign(c.campaign.id)).campaign.status === 'held' ? true : null,
    );
    const again: CampaignSummary = (
      await t.agent.post(`/api/campaigns/${c.campaign.id}/resume`).send({}).expect(200)
    ).body;
    expect(again.campaign.status).toBe('under-way');
    expect(again.steps[1]!.operation!.id).not.toBe(firstTry);
    await t.agent
      .post(`/api/campaigns/${c.campaign.id}/resume`)
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.error.message).toBe('Campaign Hold is under way.'));

    // Call it off: its operation under way is cancelled too.
    const off: CampaignSummary = (
      await t.agent
        .post(`/api/campaigns/${c.campaign.id}/cancel`)
        .send({ note: 'Enough' })
        .expect(200)
    ).body;
    expect(off.campaign).toMatchObject({ status: 'cancelled', closed: { note: 'Enough' } });
    expect(off.steps.map((s) => s.status)).toEqual(['done', 'cancelled']);
    const cancelled = await op(again.steps[1]!.operation!.id);
    expect(cancelled.operation.cancelled?.note).toBe('Campaign Hold called off: Enough');
    await t.agent.post(`/api/campaigns/${c.campaign.id}/cancel`).send({ note: '' }).expect(409);
  });

  it('in chat: "Run a campaign called X: 1. … 2. …" plans it; "cancel the campaign" calls it off after confirmation', async () => {
    const r: ChatSendResult = (
      await t.agent
        .post('/api/chat/hq')
        .send({
          text: 'Run a campaign called Spring in theatre Gate: 1. Add tags. 2. Add search.',
        })
        .expect(201)
    ).body;
    await settled(t.app);
    expect(r.readback.body.text).toBe('Wilco.');
    expect(r.readback.body.items[0]!.summary).toMatch(
      /^Campaign Spring planned in Theatre Gate: 2 step\(s\)\. Step 1 launched as Operation Add tags; each next step launches when the one before it closes\./,
    );
    const link = r.readback.body.items[0]!.links[0]!.link;
    const id = link.replace('/campaigns/', '');
    expect((await campaign(id)).steps.map((s) => s.intent)).toEqual(['Add tags.', 'Add search.']);

    const off: ChatSendResult = (
      await t.agent
        .post('/api/chat/hq')
        .send({ text: 'Cancel the campaign Spring: changed my mind.' })
        .expect(201)
    ).body;
    expect(off.readback.body.pending[0]).toMatchObject({
      reason: 'irreversible',
      summary: 'Call off Campaign Spring: changed my mind',
    });
    await confirm(off);
    expect((await campaign(id)).campaign.status).toBe('cancelled');
  });

  it('a theatre with a campaign under way does not close', async () => {
    const c = await plan('Last', ['Add export.']);
    await t.agent
      .post(`/api/theatres/${gateId}/close`)
      .send({ note: 'Done' })
      .expect(409)
      .expect((r) => expect(r.body.error.message).toMatch(/campaign\(s\) under way: .*Last/));
    await t.agent.post(`/api/campaigns/${c.campaign.id}/cancel`).send({ note: '' }).expect(200);
  });
});
