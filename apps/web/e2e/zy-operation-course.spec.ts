import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/** A throwaway git repository to connect as a second one. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbot-ui-repo-'));
  writeFileSync(join(dir, 'README.md'), '# subframe\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '--quiet', '-b', 'main');
  git('add', '-A');
  git(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '-m',
    'init',
  );
  return dir;
}

/** Move an operation to another repository once its missions are out, then cancel it. */
test('make another repository the main one, then cancel the operation', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/supply');
  const res = await page.request.post('/api/supply/repositories', {
    data: { name: 'subframe', location: makeRepo() },
  });
  expect(res.ok()).toBe(true);

  await page.goto('/operations');
  await page.getByRole('button', { name: 'State intent' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'State intent' });
  await dialog.getByLabel('Intent').fill('Ship a changelog page to production.');
  await dialog.getByLabel(/Code name/).fill('Pivot');
  await dialog.getByRole('group', { name: 'Repositories' }).getByLabel('demo-app').check();
  await dialog.getByRole('group', { name: 'Environments' }).getByLabel('production').check();
  await dialog.getByRole('button', { name: 'Launch operation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Operation Pivot' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Missions in handoff order' })).toBeVisible({
    timeout: 15_000,
  });

  const resources = page.getByRole('region', { name: 'Resources' });
  const assigned = resources.getByRole('list', { name: 'Assigned resources' });
  await expect(assigned.getByRole('listitem').filter({ hasText: 'demo-app' })).toContainText(
    'main',
  );
  // The main repository cannot be taken off while missions are out; another can be made main.
  await expect(
    resources.getByRole('button', { name: 'Take demo-app off the operation' }),
  ).toHaveCount(0);
  await resources.getByLabel('Resource to assign').selectOption({ label: 'subframe (repository)' });
  await resources.getByRole('button', { name: 'Assign' }).click();
  await resources.getByRole('button', { name: 'Make subframe the main repository' }).click();
  const move = page.getByRole('dialog', { name: 'Move Operation Pivot to subframe' });
  await expect(move).toContainText('stays on demo-app');
  await expectAccessible(page, 'move to another repository');
  await move.getByRole('button', { name: 'Move to subframe' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Operation Pivot moves to subframe.' }),
  ).toBeVisible();
  await expect(assigned.getByRole('listitem').filter({ hasText: 'subframe' })).toContainText(
    'main',
  );
  // demo-app is an ordinary resource now.
  await resources.getByRole('button', { name: 'Take demo-app off the operation' }).click();
  await expect(assigned).not.toContainText('demo-app');

  // Abort and start over, one mission at a time: the stage is issued again to the same unit.
  const missions = page.getByRole('list', { name: 'Missions and their tasks' });
  const first = missions.getByRole('listitem').first();
  await first.getByRole('button', { name: 'Start over…' }).click();
  const restart = page.getByRole('dialog', { name: /^Start the mission/ });
  await expect(restart).toContainText('briefs back afresh');
  await restart.getByLabel('Why (optional)').fill('Wrong brief');
  await expectAccessible(page, 'start a mission over');
  await restart.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Mission started over.' })).toBeVisible();
  await expect(page.getByRole('region', { name: /Timeline/ })).toContainText(
    'Mission started over',
  );
  // Four withdrawn by the move to subframe, one by starting over.
  await expect(page.locator('main')).toContainText('5 earlier mission(s) withdrawn');

  await page.getByRole('button', { name: 'Cancel operation…' }).click();
  const cancel = page.getByRole('dialog', { name: 'Cancel Operation Pivot' });
  await cancel.getByLabel('Why (optional)').fill('Testing a change of course');
  await expectAccessible(page, 'cancel operation');
  await cancel.getByRole('button', { name: 'Cancel operation' }).click();
  await expect(page.locator('header.page-header')).toContainText(
    'Cancelled: Testing a change of course',
  );
  await expect(page.getByRole('list', { name: /Operation phase/ })).toHaveAttribute(
    'aria-label',
    'Operation phase: Closed',
  );
});
