import type {
  ChatSendResult,
  NewTheatreView,
  OperationDetailView,
  SupplyView,
  TheatreDetailView,
  TheatreSummary,
} from '@orbot/shared';
import { git } from '../src/common/git.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * A theatre is a project: it holds the repository and the site once, and every operation
 * launched in it starts with both (D121). A fully automatic theatre (the default) pre-approves
 * plans, trims a single-file project to its build, and at the end HQ lands the work on the
 * default branch and publishes the site (D122). Opened from the web and in chat; closed only
 * once its operations are over.
 */
describe('Theatres', () => {
  let t: TestApp;

  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const theatre = async (id: string): Promise<TheatreDetailView> =>
    (await t.agent.get(`/api/theatres/${id}`).expect(200)).body;
  const theatres = async (): Promise<TheatreSummary[]> =>
    (await t.agent.get('/api/theatres').expect(200)).body;

  let engineers: { unitId: string; botId: string };

  beforeAll(async () => {
    t = await startTestApp();
    const eng = await makeUnitWithBot(t.app, {
      name: 'Engineers',
      roe: { mayDoAlone: ['Run the tests'], mustEscalate: ['Adding a dependency'] },
    });
    engineers = { unitId: eng.unit.entityId, botId: eng.bot.entityId };
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
    expect(r.theatre).toMatchObject({ name: 'Ledger', status: 'open', autonomy: 'full' });
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

    const list = await theatres();
    expect(list.map((x) => x.theatre.name)).toEqual(['Ledger']);
    expect(list[0]!.site).toMatchObject({ name: 'Ledger site', url: `/api/sites/${r.site!.id}/` });
    expect(list[0]!.operations.map((o) => o.name)).toEqual(['Ledger']);
  });

  it('fully automatic: build only, pre-approved; at the end HQ lands on main and publishes the site', async () => {
    const [th] = await theatres();
    const opId = th!.operations[0]!.id;
    const v = await waitFor(async () => {
      const x = await op(opId);
      return x.operation.deployment ? x : null;
    }, 30_000);
    expect(v.operation.autonomous).toBe(true);
    expect(v.missions.map((m) => m.mission.stage)).toEqual(['build']);
    expect(v.missions[0]!.mission.preApproved).toBe(true);
    const d = v.operation.deployment!;
    expect(d.environment).toBe('Ledger site');
    expect(d.taskId).toBeNull();
    expect(d.url).toContain(`/api/sites/${th!.site!.id}/`);
    const texts = v.timeline.map((e) => (e.body as { text?: string }).text ?? '');
    expect(texts).toContainEqual(
      expect.stringMatching(/^Automatic single-file project: build only/),
    );
    expect(texts).toContainEqual(
      expect.stringMatching(/^Operation Ledger landed on main: Ledger is at/),
    );
    expect(texts).toContainEqual(
      expect.stringMatching(/^Published to Ledger site: .*\/api\/sites\//),
    );
    // The code is on main, and the site serves the file.
    const repo = th!.repository!;
    const local = repo.spec.kind === 'repository' ? repo.spec.localPath : '';
    expect(await git(local, ['rev-parse', 'main'])).toBe(
      await git(local, ['rev-parse', v.operation.integrationBranch!]),
    );
    const page = await t.agent.get(`/api/sites/${th!.site!.id}/`).expect(200);
    expect(page.text).toContain('<title>Ledger</title>');
    const again = await theatres();
    expect(again[0]!.site?.published).toBe(true);
  });

  it('in chat: an intent with no theatre named goes to the only open theatre', async () => {
    const r: ChatSendResult = (
      await t.agent.post('/api/chat/hq').send({ text: 'Add a dark mode toggle.' }).expect(201)
    ).body;
    await settled(t.app);
    expect(r.readback.body.items[0]!.summary).toMatch(
      /^Operation Dark Mode Toggle launched in Theatre Ledger/,
    );
    const [th] = await theatres();
    expect(th!.operations.map((o) => o.name)).toEqual(
      expect.arrayContaining(['Dark Mode Toggle', 'Ledger']),
    );
  });

  it('a second intent in the theatre starts with what the theatre holds', async () => {
    const [th] = await theatres();
    const launched = (
      await t.agent
        .post(`/api/theatres/${th!.theatre.id}/operations`)
        .send({ intent: 'Add recurring entries.', name: 'Recurring' })
        .expect(201)
    ).body;
    expect(launched.theatreId).toBe(th!.theatre.id);
    expect(launched.supplyIds).toEqual(th!.theatre.supplyIds);
    const d = await theatre(th!.theatre.id);
    expect(d.operations.map((o) => o.operation.name)).toEqual(
      expect.arrayContaining(['Ledger', 'Recurring']),
    );
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

  it('in chat: "Open a theatre called X: …" opens it and launches the first operation; several open, an intent must name one', async () => {
    const r: ChatSendResult = (
      await t.agent
        .post('/api/chat/hq')
        .send({ text: 'Open a theatre called Pocket Notes: a notes app that works offline.' })
        .expect(201)
    ).body;
    await settled(t.app);
    expect(r.readback.body.text).toBe('Wilco.');
    expect(r.readback.body.items[0]!.summary).toMatch(
      /^Theatre Pocket Notes opened \(fully automatic\) on Pocket Notes, publishing to Pocket Notes site\. Operation Pocket Notes launched in it/,
    );
    expect((await theatres()).map((x) => x.theatre.name).sort()).toEqual([
      'Billing',
      'Ledger',
      'Pocket Notes',
    ]);
    const named: ChatSendResult = (
      await t.agent
        .post('/api/chat/hq')
        .send({ text: 'Add tags to notes in theatre Pocket Notes.' })
        .expect(201)
    ).body;
    await settled(t.app);
    expect(named.readback.body.items[0]!.summary).toMatch(
      /^Operation Tags Notes launched in Theatre Pocket Notes/,
    );
  });

  it('in an automatic theatre HQ answers a permission request for the Commander; the task carries on', async () => {
    const list = await theatres();
    const notes = list.find((x) => x.theatre.name === 'Pocket Notes')!;
    const launched = (
      await t.agent
        .post(`/api/theatres/${notes.theatre.id}/operations`)
        .send({ intent: 'Add note numbering.', name: 'Numbering' })
        .expect(201)
    ).body;
    const v = await waitFor(async () => {
      const x = await op(launched.id);
      return x.missions.find((m) => m.unit.id === engineers.unitId) ? x : null;
    });
    const mission = v.missions.find((m) => m.unit.id === engineers.unitId)!.mission;
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: engineers.unitId,
          botId: engineers.botId,
          missionId: mission.id,
          title: 'Add the numbering library',
          repoSupplyId: notes.theatre.repoSupplyId,
          scenario: 'needs-permission',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    const done = await waitFor(async () => {
      const x = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
      return x.task.status === 'done' ? x : null;
    }, 30_000);
    expect(done.task.permission).toMatchObject({ status: 'approved', by: 'system:hq' });
    expect(done.task.permission.note).toMatch(/^Automatic theatre: HQ decides for the Commander/);
  });

  it('in an automatic theatre HQ starts a failed task again on the same branch; it reaches the Commander only when it fails again', async () => {
    const list = await theatres();
    const notes = list.find((x) => x.theatre.name === 'Pocket Notes')!;
    const launched = (
      await t.agent
        .post(`/api/theatres/${notes.theatre.id}/operations`)
        .send({ intent: 'Add note colours.', name: 'Colours' })
        .expect(201)
    ).body;
    const v = await waitFor(async () => {
      const x = await op(launched.id);
      return x.missions.find((m) => m.unit.id === engineers.unitId) ? x : null;
    });
    const mission = v.missions.find((m) => m.unit.id === engineers.unitId)!.mission;
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: engineers.unitId,
          botId: engineers.botId,
          missionId: mission.id,
          title: 'Colour the notes',
          repoSupplyId: notes.theatre.repoSupplyId,
          scenario: 'out-of-turns',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    const done = await waitFor(async () => {
      const x = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
      return x.task.status === 'done' ? x : null;
    }, 30_000);
    const statuses = done.events
      .filter((e: { kind: string }) => e.kind === 'task.status')
      .map((e: { body: { to: string } }) => e.body.to);
    expect(statuses).toEqual(['working', 'failed', 'working', 'done']);
    expect(done.task.description).toMatch(
      /Frago: HQ started it again \(attempt 2, automatic theatre\): the last run stopped: Stopped after 40 turns without finishing\./,
    );
    const texts = (await op(launched.id)).timeline.map(
      (e) => (e.body as { text?: string }).text ?? '',
    );
    expect(texts).toContainEqual(
      expect.stringMatching(
        /^HQ started task #\d+ again for the Commander \(automatic theatre, attempt 2\)/,
      ),
    );
    const inbox = (await t.agent.get('/api/approvals').expect(200)).body;
    expect(inbox.attention.map((a: { entityId: string }) => a.entityId)).not.toContain(task.id);
  });

  it('a gated theatre waits for the Commander; it closes only once its operations are over', async () => {
    const r: NewTheatreView = (
      await t.agent
        .post('/api/theatres')
        .send({
          name: 'Gate',
          repository: { kind: 'template', template: 'single-html' },
          site: true,
          autonomy: 'approve',
          intent: 'Build it carefully.',
        })
        .expect(201)
    ).body;
    expect(r.operation?.autonomous).toBe(false);
    const waiting = await waitFor(async () => {
      const x = await op(r.operation!.id);
      return x.operation.phase === 'backbrief' && x.missions[0]?.backbrief ? x : null;
    });
    expect(waiting.missions[0]!.backbrief?.status).toBe('awaiting-approval');
    // Not automatic: a failed task is the Commander's to retry.
    const failing = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: engineers.unitId,
          botId: engineers.botId,
          missionId: waiting.missions[0]!.mission.id,
          title: 'Build it',
          repoSupplyId: r.repository!.id,
          scenario: 'out-of-turns',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${failing.id}/run`).expect(202);
    await waitFor(async () => {
      const x = (await t.agent.get(`/api/tasks/${failing.id}`).expect(200)).body;
      return x.task.status === 'failed' ? x : null;
    });
    await settled(t.app);
    expect((await t.agent.get(`/api/tasks/${failing.id}`).expect(200)).body.task.status).toBe(
      'failed',
    );
    const refused = await t.agent
      .post(`/api/theatres/${r.theatre.id}/close`)
      .send({ note: 'Done' })
      .expect(409);
    expect(refused.body.error.message).toMatch(/still has 1 operation\(s\) under way/);
    await t.agent
      .post(`/api/operations/${r.operation!.id}/cancel`)
      .send({ note: 'Test' })
      .expect(200);
    const closed: TheatreDetailView = (
      await t.agent.post(`/api/theatres/${r.theatre.id}/close`).send({ note: 'Done' }).expect(200)
    ).body;
    expect(closed.theatre).toMatchObject({ status: 'closed', closed: { note: 'Done' } });
    await t.agent
      .post(`/api/theatres/${r.theatre.id}/operations`)
      .send({ intent: 'More.' })
      .expect(400);
  });
});
