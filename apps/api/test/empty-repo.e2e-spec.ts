import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationDetailView, SupplyView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { makeUnitWithBot, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * An empty repository (a GitHub repository with no commits) gets its first commit from ORBOT
 * when it is connected, so an operation can open its integration branch there (D120).
 */
describe('An empty repository', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
    await makeUnitWithBot(t.app, { name: 'Engineers' });
  });
  afterAll(() => t.close());

  it('gets a first commit when connected, and an operation can be issued on it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbot-empty-repo-'));
    await git(dir, ['init', '--quiet', '-b', 'main']);
    const repo: SupplyView = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'blank', location: dir })
        .expect(201)
    ).body;
    const path = repo.spec.kind === 'repository' ? repo.spec.localPath : '';
    expect(await git(path, ['log', '--format=%s', 'main'])).toBe(
      'First commit (the repository was empty)',
    );
    const sitreps = (await t.agent.get('/api/record/events').query({ kinds: 'sitrep' }).expect(200))
      .body as { body: { text: string } }[];
    expect(sitreps.map((e) => e.body.text)).toContainEqual(
      expect.stringMatching(/^blank was empty: ORBOT made its first commit/),
    );

    const id = (
      await t.agent
        .post('/api/operations')
        .send({ intent: 'Add a status endpoint.', name: 'Blank', supplyIds: [repo.id] })
        .expect(201)
    ).body.id as string;
    const v = await waitFor(async () => {
      const x: OperationDetailView = (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
      return x.operation.integrationBranch && x.missions.length ? x : null;
    });
    expect(await git(path, ['branch', '--list', v.operation.integrationBranch!])).toContain(
      'orbot/op-',
    );
  });
});
