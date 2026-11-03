import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type {
  ChatSendResult,
  NewProjectView,
  OperationDetailView,
  SupplyView,
  TaskView,
} from '@orbot/shared';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { SitesService } from '../src/servers/sites.service.js';
import { makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * A new project whose deployment is one HTML file and no server: ORBOT starts the repository
 * from a template, gives the project a static site it publishes itself, and the operation runs
 * through the whole chain to a published, downloadable page. Chat starts one the same way.
 */
describe('New project: a single HTML file, published by ORBOT', () => {
  let t: TestApp;
  let units: Record<string, string>;
  let project: NewProjectView;
  let op: OperationDetailView;

  const detail = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const chat = async (text: string): Promise<ChatSendResult> => {
    const r = (await t.agent.post('/api/chat/hq').send({ text }).expect(201)).body;
    await settled(t.app);
    return r;
  };

  beforeAll(async () => {
    t = await startTestApp();
    const eng = await makeUnitWithBot(t.app, {
      name: 'Engineers',
      role: 'Developers',
      prefix: 'E',
    });
    const ins = await makeUnitWithBot(t.app, {
      name: 'Inspection',
      role: 'QA',
      prefix: 'I',
      gate: 'escalations-only',
    });
    const grd = await makeUnitWithBot(t.app, { name: 'Guard', role: 'Security', prefix: 'G' });
    const log = await makeUnitWithBot(t.app, { name: 'Logistics', role: 'DevOps', prefix: 'L' });
    units = {
      eng: eng.unit.entityId,
      ins: ins.unit.entityId,
      grd: grd.unit.entityId,
      log: log.unit.entityId,
    };

    project = (
      await t.agent
        .post('/api/projects')
        .send({
          name: 'Ledger',
          kind: 'single-html',
          intent: 'A personal ledger that works offline and keeps its data in the browser.',
          deployRightsUnitId: units.log,
        })
        .expect(201)
    ).body;
    await settled(t.app);

    // Backbriefs in, the deploy waits for the Commander, then ships.
    op = await detail(project.operation!.id);
    for (const m of op.missions) {
      if (m.backbrief?.status === 'awaiting-approval') {
        await t.agent
          .post(`/api/backbriefs/${m.backbrief.id}/approve`)
          .send({ expectedVersion: m.backbrief.version })
          .expect(200);
      }
    }
    await settled(t.app);
    op = await waitFor(async () => {
      const d = await detail(project.operation!.id);
      return d.needsYou.some((n) => n.action === 'approve-deploy') ? d : null;
    });
    const deploy = op.missions.at(-1)!.tasks[0]!;
    await t.agent
      .post(`/api/tasks/${deploy.id}/deploy-decision`)
      .send({ approve: true })
      .expect(200);
    await settled(t.app);
    op = await waitFor(async () => {
      const d = await detail(project.operation!.id);
      return d.operation.deployment ? d : null;
    });
  }, 120_000);
  afterAll(() => t.close());

  it('started the repository from the single-HTML template, with its shape on the depot item', async () => {
    const repo = project.repository;
    expect(repo.spec).toMatchObject({
      kind: 'repository',
      defaultBranch: 'main',
      project: { kind: 'single-html', entry: 'index.html' },
    });
    const local = repo.spec.kind === 'repository' ? repo.spec.localPath : '';
    expect((await git(local, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n')).toEqual([
      'README.md',
      'index.html',
    ]);
    expect(await git(local, ['log', '--format=%s', 'main'])).toBe(
      'Start the project: one self-contained HTML file',
    );
    expect(await git(local, ['show', 'HEAD:index.html'])).toContain('<title>Ledger</title>');
    expect(await git(local, ['show', 'HEAD:README.md'])).toContain('one self-contained HTML file');
    // Its folder is under the workspaces, named after the project.
    expect(repo.spec.kind === 'repository' ? repo.spec.location : '').toBe(
      join(t.config.workspacesDir, 'source', 'ledger'),
    );
  });

  it('gave the project a production static site, held by Logistics, that meets the plan’s deploy need', async () => {
    expect(project.site).toMatchObject({
      name: 'Ledger site',
      connected: true,
      spec: {
        kind: 'environment',
        details: { tier: 'production' },
        server: null,
        site: { entry: 'index.html', last: null },
      },
    });
    const log = await t.app.get(RecordService).requireActive('unit', units.log!);
    expect(log.body.supplyIds).toContain(project.site.id);
    expect(op.resources).toMatchObject({ blocked: false, missing: [] });
    expect(op.resources.assigned.map((s) => s.name)).toEqual(['Ledger', 'Ledger site']);
    expect(op.operation.repoSupplyId).toBe(project.repository.id);
    expect(op.missions.map((m) => [m.unit.name, m.mission.stage])).toEqual([
      ['Engineers', 'build'],
      ['Inspection', 'inspect'],
      ['Guard', 'guard'],
      ['Logistics', 'deploy'],
    ]);
  });

  it('the deploy published index.html to the site: on the record with its URL, kept by version', async () => {
    const d = op.operation.deployment!;
    const url = `${t.config.webOrigin}/api/sites/${project.site.id}/`;
    expect(d).toMatchObject({ environment: 'Ledger site', ref: 'deploy/ledger-site', url });
    const event = op.timeline.find((e) => e.kind === 'deployment')!;
    expect(event.body).toMatchObject({ environment: 'Ledger site', commit: d.commit, url });
    expect(
      op.timeline.filter((e) => e.kind === 'sitrep').map((e) => (e.body as { text: string }).text),
    ).toContainEqual(
      expect.stringContaining(`Deployed to Ledger site (${d.commit.slice(0, 10)}): ${url}`),
    );

    const site: SupplyView = (await t.agent.get('/api/supply').expect(200)).body.find(
      (s: SupplyView) => s.id === project.site.id,
    );
    expect(site.spec.kind === 'environment' ? site.spec.site?.last : null).toMatchObject({
      commit: d.commit,
      taskId: d.taskId,
    });
    const dir = site.spec.kind === 'environment' ? site.spec.site!.dir : '';
    const versions = await readdir(join(dir, 'versions'));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toContain(d.commit.slice(0, 10));
    expect(await readFile(join(dir, 'current', 'index.html'), 'utf8')).toContain(
      '<title>Ledger</title>',
    );
    // Only the entry file was published: the README stays in the repository.
    expect(await readdir(join(dir, 'current'))).toEqual(['index.html']);
  });

  it('serves the published page to anyone, sandboxed, and offers it as a download', async () => {
    const anyone = request(t.app.getHttpServer());
    const page = await anyone.get(`/api/sites/${project.site.id}/`).expect(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toMatch(/^sandbox allow-scripts/);
    expect(page.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(page.text).toContain('<title>Ledger</title>');
    await anyone.get(`/api/sites/${project.site.id}/index.html`).expect(200);
    await anyone.get(`/api/sites/${project.site.id}`).expect(302);

    const file = await anyone.get(`/api/sites/${project.site.id}/download`).expect(200);
    expect(file.headers['content-disposition']).toBe('attachment; filename="ledger-site.html"');
    expect(file.body.toString()).toContain('<title>Ledger</title>');

    // Nothing but what was published: no README, no other version, nothing outside the site.
    await anyone.get(`/api/sites/${project.site.id}/README.md`).expect(404);
    await anyone.get(`/api/sites/${project.site.id}/..%2Fversions`).expect(404);
    await anyone.get(`/api/sites/${project.site.id}/versions/`).expect(404);
    const other = (
      await t.agent
        .post('/api/supply/environments')
        .send({ name: 'Scratch site', tier: 'staging', site: true })
        .expect(201)
    ).body as SupplyView;
    expect((await anyone.get(`/api/sites/${other.id}/`).expect(404)).body.error.message).toBe(
      'Nothing is published here.',
    );
  });

  it('refuses to publish to the production site outside an approved deploy', async () => {
    const build = op.missions[0]!.tasks[0]!;
    const task = await t.app.get(RecordService).requireActive('task', build.id);
    const bot: TaskView = (await t.agent.get(`/api/tasks/${build.id}`).expect(200)).body;
    // Engineers hold no site; Logistics does, but a work task on it is not an approved deploy.
    const sites = t.app.get(SitesService);
    const asLogistics = {
      ...task,
      body: { ...task.body, unitId: units.log!, kind: 'work' as const },
    };
    await expect(
      sites.publish(
        asLogistics,
        { kind: 'bot', id: bot.botId!, displayName: 'L-1' },
        {
          unitId: units.log!,
          botId: bot.botId,
          taskId: task.entityId,
          missionId: null,
          operationId: null,
        },
        'Ledger site',
        [],
      ),
    ).rejects.toThrow(/Refused: Ledger site is a production site/);
    await expect(
      sites.publish(
        asLogistics,
        { kind: 'bot', id: bot.botId!, displayName: 'L-1' },
        {
          unitId: units.log!,
          botId: bot.botId,
          taskId: task.entityId,
          missionId: null,
          operationId: null,
        },
        'Nowhere',
        [],
      ),
    ).rejects.toThrow(/holds no site called "Nowhere"/);
  });

  it('in chat: “Start a new project called …” starts one, with or without an intent', async () => {
    const r = await chat('Start a new project called Notes: a notes app that works offline.');
    expect(r.readback.body.items).toEqual([
      expect.objectContaining({
        summary: expect.stringMatching(
          /^Project Notes started: repository Notes \(one HTML file\) and its site Notes site are in the Supply Depot\. Operation Notes launched with both/,
        ),
      }),
    ]);
    const link = r.readback.body.items[0]!.links[0]!.link;
    const notes = await detail(link.split('/').pop()!);
    expect(notes.operation.intent).toBe('A notes app that works offline.');
    expect(notes.resources.assigned.map((s) => s.name)).toEqual(['Notes', 'Notes site']);

    const bare = await chat('Start a new project called Scratch Pad');
    expect(bare.readback.body.items[0]!.summary).toMatch(
      /^Project Scratch Pad started: .* State your intent, using both, when you are ready\.$/,
    );
    const names = ((await t.agent.get('/api/supply').expect(200)).body as SupplyView[]).map(
      (s) => s.name,
    );
    expect(names).toEqual(expect.arrayContaining(['Scratch Pad', 'Scratch Pad site']));

    // A name already taken is refused before anything is made.
    expect(
      (
        await t.agent
          .post('/api/projects')
          .send({ name: 'notes', kind: 'single-html', intent: null })
          .expect(400)
      ).body.error.message,
    ).toBe('A repository called Notes is already in the Supply Depot.');
  });
});
