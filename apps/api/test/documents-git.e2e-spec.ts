import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FmEntryView, UnitDetailView, VersionWithStatus } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { DOCS_BRANCH } from '../src/documents/document-store.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/** Unit documents live as Markdown in the unit's repository and edits there come back as new versions. */
describe('unit documents in the repository', () => {
  let t: TestApp;
  let unitId: string;
  let repoId: string;
  let repoPath: string;
  let docsDir: string;
  let keep: FmEntryView;
  let drop: FmEntryView;

  const unit = async (): Promise<UnitDetailView> =>
    (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
  const file = (rel: string) => readFileSync(join(docsDir, rel), 'utf8');
  const humanEdit = async (rel: string, edit: (s: string) => string) => {
    writeFileSync(join(docsDir, rel), edit(file(rel)));
    await git(join(t.config.workspacesDir, 'docs', repoId), [
      'commit',
      '-qam',
      `Human edit to ${rel}`,
    ]);
  };

  beforeAll(async () => {
    t = await startTestApp();
    const repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    repoId = repo.id;
    repoPath = repo.spec.localPath;
    const fx = await makeUnitWithBot(t.app, { supplyIds: [repoId] });
    unitId = fx.unit.entityId;
    docsDir = join(t.config.workspacesDir, 'docs', repoId, '.orbot/units/engineers');
    keep = (
      await t.agent
        .post(`/api/units/${unitId}/field-manual`)
        .send({ title: 'Branching', body: 'One task, one branch.', reason: 't' })
        .expect(201)
    ).body;
    drop = (
      await t.agent
        .post(`/api/units/${unitId}/field-manual`)
        .send({ title: 'Fax policy', body: 'Fax everything.', reason: 't' })
        .expect(201)
    ).body;
    const u = await unit();
    await t.agent
      .put(`/api/units/${unitId}/standing-orders`)
      .send({
        orders: [{ text: 'Every change ships with tests.' }],
        reason: 't',
        expectedVersion: u.unit.version,
      })
      .expect(200);
    await settled(t.app);
  });
  afterAll(() => t.close());

  it('mirrors the record into committed Markdown on the unit-docs branch', async () => {
    const u = await unit();
    expect(u.docsMirror).toEqual({
      repository: 'app',
      branch: DOCS_BRANCH,
      path: '.orbot/units/engineers',
    });
    const fm = await git(repoPath, [
      'show',
      `${DOCS_BRANCH}:.orbot/units/engineers/field-manual.md`,
    ]);
    expect(fm).toContain('## Branching');
    expect(fm).toContain(`<!-- fm:${keep.id} -->`);
    expect(file('standing-orders.md')).toContain('- Every change ships with tests.');
    // The default branch is untouched: docs live on their own branch.
    expect(await git(repoPath, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('.orbot');
  });

  it('imports human edits as new versions, attributed to the repository', async () => {
    await humanEdit('field-manual.md', (s) =>
      s
        .replace('One task, one branch.', 'One task, one branch. Rebase before handing over.')
        .replace(/## Fax policy[\s\S]*?(?=## |$)/, '')
        .concat('\n## Pairing\n\nPair on anything touching auth.\n'),
    );
    await humanEdit('standing-orders.md', (s) => s.concat('- No Friday deploys.\n'));
    const r = await t.agent.post(`/api/units/${unitId}/documents/sync`).expect(200);
    expect(r.body.imported).toEqual(
      expect.arrayContaining(['field-manual.md', 'standing-orders.md']),
    );
    await settled(t.app);

    const u = await unit();
    const branching = u.fieldManual.find((e) => e.id === keep.id)!;
    expect(branching.body).toBe('One task, one branch. Rebase before handing over.');
    expect(branching.updatedBy).toBe('system:git-import');
    expect(branching.sources.map((s) => s.kind)).toEqual(['commander', 'git']);
    expect(u.fieldManual.map((e) => e.title)).toContain('Pairing');
    expect(u.retiredEntries.map((e) => e.id)).toContain(drop.id);
    expect(u.unit.standingOrders.map((o) => o.text)).toEqual([
      'Every change ships with tests.',
      'No Friday deploys.',
    ]);

    const history: VersionWithStatus[] = (
      await t.agent.get(`/api/record/${keep.id}/history`).expect(200)
    ).body;
    expect(history[0]!.superseded?.reason).toBe('Edited in the repository (field-manual.md)');
  });

  it('restores the War Diary if someone edits it (diary entries are immutable)', async () => {
    const botId = (await unit()).bots.find((b) => !b.isOverseer)!.id;
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'x', repoSupplyId: repoId, scenario: 'happy-path' })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    const day = new Date().toISOString().slice(0, 10);
    const original = file(`war-diary/${day}.md`);
    await humanEdit(`war-diary/${day}.md`, () => '# rewritten history\n');
    const r = await t.agent.post(`/api/units/${unitId}/documents/sync`).expect(200);
    expect(r.body.imported).toEqual([`war-diary/${day}.md (read-only, restored)`]);
    await settled(t.app);
    expect(file(`war-diary/${day}.md`)).toBe(original);
  });

  it('every mirror commit is in the record', async () => {
    const events = (
      await t.agent.get('/api/record/events').query({ unitId, kinds: 'docs.synced' }).expect(200)
    ).body;
    expect(events.length).toBeGreaterThan(1);
    const log = await git(repoPath, ['log', '--format=%H', DOCS_BRANCH]);
    for (const e of events.filter((x: { body: { commit: string | null } }) => x.body.commit))
      expect(log).toContain(e.body.commit);
  });
});
