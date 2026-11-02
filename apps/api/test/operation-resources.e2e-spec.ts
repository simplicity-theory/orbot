import type { ApprovalsView, ChatSendResult, OperationDetailView, SupplyView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Operations have resources: depot items assigned to them. Without what its plan needs (always a
 * repository; production for a deploy; more if HQ says so) an operation holds at the O Group,
 * and says so in Needs you. Resources are assigned from the web or in chat, the same way.
 */
describe('Operation resources', () => {
  let t: TestApp;
  let api: SupplyView;
  let web: SupplyView;
  let engId: string;

  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const start = async (body: Record<string, unknown>) => {
    const id = (await t.agent.post('/api/operations').send(body).expect(201)).body.id as string;
    await settled(t.app);
    return id;
  };
  const chat = async (text: string): Promise<ChatSendResult> => {
    const r = (await t.agent.post('/api/chat/hq').send({ text }).expect(201)).body;
    await settled(t.app);
    return r;
  };

  beforeAll(async () => {
    t = await startTestApp();
    const repo = async (name: string) =>
      (
        await t.agent
          .post('/api/supply/repositories')
          .send({ name, location: await makeRepo() })
          .expect(201)
      ).body as SupplyView;
    api = await repo('ledger-api');
    web = await repo('ledger-web');
    // One building unit: no deploy stage, so a repository is all the plan needs.
    engId = (await makeUnitWithBot(t.app, { gate: 'escalations-only', bots: 2 })).unit.entityId;
  });
  afterAll(() => t.close());

  it('an operation with no repository waits at the O Group, in Needs you, until it has one', async () => {
    const id = await start({ intent: 'Add a status endpoint.', name: 'Pulse' });
    const v = await op(id);
    expect(v.operation.phase).toBe('o-group');
    expect(v.missions).toEqual([]);
    expect(v.resources).toMatchObject({
      blocked: true,
      assigned: [],
      missing: [{ kind: 'repository', label: 'A repository to work in' }],
    });
    const inbox: ApprovalsView = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention).toContainEqual(
      expect.objectContaining({
        kind: 'resources',
        unitName: 'HQ',
        unitId: null,
        label: 'Operation Pulse is waiting for resources: a repository to work in',
        link: `/operations/${id}#resources`,
      }),
    );

    // Only what an operation can use, and only connected.
    const cred = (
      await t.agent.post('/api/supply/credentials').send({ name: 'tok', value: 'secret-1' })
    ).body as SupplyView;
    await t.agent.post(`/api/operations/${id}/resources`).send({ supplyId: cred.id }).expect(200);
    await t.agent
      .post(`/api/operations/${id}/resources/release`)
      .send({ supplyId: cred.id })
      .expect(200);

    // A repository: HQ plans and issues at once; the unit gets the repository.
    const after: OperationDetailView = (
      await t.agent.post(`/api/operations/${id}/resources`).send({ supplyId: api.id }).expect(200)
    ).body;
    expect(after.resources.assigned.map((s) => s.name)).toEqual(['ledger-api']);
    await settled(t.app);
    const done = await op(id);
    expect(done.resources).toMatchObject({ blocked: false, missing: [] });
    expect(done.missions).toHaveLength(1);
    expect(done.operation.repoSupplyId).toBe(api.id);
    expect(done.operation.phase).not.toBe('o-group');
    const eng = await t.app.get(RecordService).requireActive('unit', engId);
    expect(eng.body.supplyIds).toContain(api.id);
    expect((await t.agent.get('/api/approvals').expect(200)).body.attention).not.toContainEqual(
      expect.objectContaining({ kind: 'resources', entityId: id }),
    );
    // Where the work is handed off from stays while the operation runs.
    expect(
      (
        await t.agent
          .post(`/api/operations/${id}/resources/release`)
          .send({ supplyId: api.id })
          .expect(400)
      ).body.error.message,
    ).toBe('ledger-api is where Operation Pulse hands off and deploys from.');
  });

  it('two repositories: the integration branch is opened in both, and work lands where it says', async () => {
    const id = await start({
      intent: 'Add a status page to ledger-web.',
      name: 'Beacon',
      supplyIds: [api.id, web.id],
    });
    const v = await waitFor(async () => {
      const x = await op(id);
      return x.missions[0]?.tasks.some((tk) => tk.status === 'done') ? x : null;
    });
    const branch = v.operation.integrationBranch!;
    for (const r of [api, web]) {
      const path = r.spec.kind === 'repository' ? r.spec.localPath : '';
      expect(await git(path, ['branch', '--list', branch])).toContain(branch);
    }
    const task = v.missions[0]!.tasks[0]!;
    expect(task.repoSupplyId).toBe(web.id);
    await settled(t.app);
    const integration = (await op(id)).timeline.find((e) => e.kind === 'integration');
    expect(integration).toBeDefined();
    const webPath = web.spec.kind === 'repository' ? web.spec.localPath : '';
    expect(await git(webPath, ['log', '--oneline', branch])).toContain('Integrate orbot/task-');
  });

  it('in chat: launch with resources, assign, take off, and undo', async () => {
    // A GPU job: it stays at the O Group (no dev server yet), so it is still open to change.
    const r = await chat('Operation: fine-tune the ranking model on the GPU, using ledger-api.');
    expect(r.readback.body.items[0]!.summary).toMatch(/Resources: ledger-api\.$/);
    const id = r.readback.body.items[0]!.links[0]!.link.split('/').pop()!;
    const name = (await op(id)).operation.name;
    expect((await op(id)).resources.assigned.map((s) => s.name)).toEqual(['ledger-api']);

    const add = await chat(`Use ledger-web for Operation ${name}.`);
    expect(add.readback.body.items).toEqual([
      expect.objectContaining({
        summary: `ledger-web assigned to Operation ${name}.`,
        reversible: true,
        routedVia: 'hq',
      }),
    ]);
    expect((await op(id)).resources.assigned.map((s) => s.name)).toEqual([
      'ledger-api',
      'ledger-web',
    ]);
    // Undo takes it off again.
    await t.agent.post(`/api/orders/${add.readback.body.items[0]!.ordersLogId}/undo`).expect(200);
    await settled(t.app);
    expect((await op(id)).resources.assigned.map((s) => s.name)).toEqual(['ledger-api']);

    const missing = await chat(`Use billing-api for Operation ${name}.`);
    expect(missing.readback.body.missing).toEqual(['billing-api']);
    // A closed operation says so.
    const closed = await chat('Use ledger-web for Operation Pulse.');
    expect(closed.readback.body.unclear).toEqual([
      'Use ledger-web for Operation Pulse — Operation Pulse is closed.',
    ]);
  });

  it('what the plan needs beyond a repository: a GPU dev server blocks until assigned', async () => {
    const id = await start({
      intent: 'Fine-tune a classifier on the GPU.',
      name: 'Forge',
      supplyIds: [api.id],
    });
    const v = await op(id);
    expect(v.resources.blocked).toBe(true);
    expect(v.resources.missing).toEqual([
      expect.objectContaining({ kind: 'server', tier: 'dev', label: 'A dev server with a GPU' }),
    ]);
    expect(v.timeline.map((e) => (e.body as { text?: string }).text ?? '')).toContainEqual(
      expect.stringContaining('waiting for resources: a dev server with a GPU'),
    );
    // A staging environment is not a dev server: still waiting.
    const staging = (
      await t.agent.post('/api/supply/environments').send({ name: 'stage', tier: 'staging' })
    ).body as SupplyView;
    await t.agent
      .post(`/api/operations/${id}/resources`)
      .send({ supplyId: staging.id })
      .expect(200);
    await settled(t.app);
    expect((await op(id)).resources.blocked).toBe(true);
  });
});
