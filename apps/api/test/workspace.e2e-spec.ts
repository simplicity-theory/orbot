import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupplyView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { makeRepo } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * A task picked up again gets what was integrated since. When that conflicts with the task's
 * own commits, the branch restarts from the integrated work and the earlier commits are kept
 * on a named branch: nothing is lost, and the task can start.
 */
describe('Workspaces: picking a task up again after the integrated work changed', () => {
  let t: TestApp;
  let repo: SupplyView;
  let localPath: string;

  beforeAll(async () => {
    t = await startTestApp();
    repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    localPath = repo.spec.kind === 'repository' ? repo.spec.localPath : '';
    await git(localPath, ['branch', 'orbot/op-1', 'main']);
  });
  afterAll(() => t.close());

  const task = (number: number) =>
    ({
      number,
      baseRef: 'orbot/op-1',
      kind: 'check',
      title: 'Review',
      description: '',
      unitId: '00000000-0000-4000-8000-000000000001',
    }) as never;

  it('merges cleanly when it can, and restarts the branch (keeping its commits) when it cannot', async () => {
    const ws = t.app.get(WorkspaceManager);
    const supply = (await t.app.get(RecordService).requireActive('supply', repo.id)).body;
    const first = await ws.prepare(repo.id, supply, task(7));
    expect(first.restarted).toBeNull();
    // The task adds a file; meanwhile the integrated work adds a different one: a clean merge.
    writeFileSync(join(first.path, 'review.md'), '# review\n');
    await git(first.path, ['add', '-A']);
    await git(first.path, ['commit', '--quiet', '-m', 'Task #7: review notes']);
    const integration = join(localPath, '..', 'op-1-wt');
    await git(localPath, ['worktree', 'add', '--quiet', integration, 'orbot/op-1']);
    writeFileSync(join(integration, 'feature.js'), 'export const a = 1;\n');
    await git(integration, ['add', '-A']);
    await git(integration, ['commit', '--quiet', '-m', 'Integrate orbot/task-8']);
    const second = await ws.prepare(repo.id, supply, task(7));
    expect(second.restarted).toBeNull();
    expect(await git(first.path, ['ls-files'])).toContain('feature.js');

    // Now both sides add package.json differently, and the task has an uncommitted edit too.
    writeFileSync(
      join(first.path, 'package.json'),
      '{ "scripts": { "security": "node check.js" } }\n',
    );
    await git(first.path, ['add', '-A']);
    await git(first.path, ['commit', '--quiet', '-m', 'Task #7: add a security check']);
    writeFileSync(join(first.path, 'draft.md'), 'not committed yet\n');
    writeFileSync(join(integration, 'package.json'), '{ "scripts": { "test": "node test.js" } }\n');
    await git(integration, ['add', '-A']);
    await git(integration, ['commit', '--quiet', '-m', 'Integrate orbot/task-9']);
    const before = await git(first.path, ['rev-parse', 'HEAD']);
    const third = await ws.prepare(repo.id, supply, task(7));
    expect(third.restarted).toMatchObject({
      conflicts: ['package.json'],
      kept: expect.stringMatching(/^orbot\/task-7-kept-[0-9a-f]{8}$/),
    });
    // What is kept is the branch as it was, plus one commit for what was not committed yet.
    expect(await git(localPath, ['rev-parse', `${third.restarted!.kept}~1`])).toBe(before);
    expect(await git(localPath, ['rev-parse', third.restarted!.kept])).toBe(third.restarted!.from);
    // The branch is the integrated work now, clean, and the earlier commits are all kept.
    expect(await git(first.path, ['rev-parse', 'HEAD'])).toBe(third.baseCommit);
    expect(await git(first.path, ['status', '--porcelain'])).toBe('');
    expect(await git(first.path, ['show', 'HEAD:package.json'])).toContain('"test"');
    const kept = third.restarted!.kept;
    const log = (await git(localPath, ['log', '--format=%s', kept])).split('\n');
    expect(log[0]).toBe('Work left uncommitted before the branch was restarted');
    expect(log).toEqual(
      expect.arrayContaining([
        'Task #7: add a security check',
        'Task #7: review notes',
        'Integrate orbot/task-8',
        'init',
      ]),
    );
    expect(await git(localPath, ['show', `${kept}:draft.md`])).toBe('not committed yet');
    expect(await git(localPath, ['show', `${kept}:package.json`])).toContain('"security"');

    // Picked up once more with nothing new to merge: no restart.
    const fourth = await ws.prepare(repo.id, supply, task(7));
    expect(fourth.restarted).toBeNull();
  });
});
