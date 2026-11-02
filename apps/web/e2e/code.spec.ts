import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** The code itself: a task's diff, a commit from the bot's notes, and the repository's history. */
test('from a bot’s notes to the commit and its diff, and through the repository’s history', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('article', { name: 'Engineers' })
    .getByRole('link', { name: 'Engineers' })
    .click();
  await page
    .getByRole('region', { name: 'Tasks', exact: true })
    .getByRole('link', { name: /Add rate limiter middleware/ })
    .click();

  // The task's own changes: its commits and the whole diff.
  const changes = page.getByRole('region', { name: /Code changes/ });
  await expect(changes).toContainText('demo-app');
  await expect(changes.getByRole('link', { name: /^[0-9a-f]{10} / }).first()).toBeVisible();
  await expect(changes.getByRole('table', { name: /^Changes to / }).first()).toBeVisible();
  await expectAccessible(page, 'task code changes');

  // A commit in the working record links to the commit.
  const record = page.getByRole('list', { name: 'Working record' });
  await record
    .getByRole('button', { name: /Commit/ })
    .first()
    .click();
  await page
    .getByRole('region', { name: 'Selected entry' })
    .getByRole('link', { name: /View commit/ })
    .click();
  await expect(page).toHaveURL(/\/supply\/repositories\/[^/]+\/commits\/[0-9a-f]{40}$/);
  const lede = page.locator('.page-header__lede');
  await expect(lede).toContainText('Committed by E-1');
  await expect(lede.getByRole('link', { name: /^task #\d+$/ })).toBeVisible();
  await expect(page.getByRole('table', { name: /^Changes to / }).first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
    /Supply Depot.*demo-app/,
  );
  await expectAccessible(page, 'commit (dark)');
  await setTheme(page, 'light');
  await expectAccessible(page, 'commit (light)');
  await setTheme(page, 'dark');

  // The repository's history, on the task's branch.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'demo-app' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'demo-app' })).toBeVisible();
  const branch = page.getByLabel('Branch');
  await expect(branch).toHaveValue('main');
  const taskBranch = await branch
    .locator('optgroup[label="Tasks"] option')
    .first()
    .getAttribute('value');
  await branch.selectOption(taskBranch!);
  await expect(page).toHaveURL(/\?ref=orbot%2Ftask-\d+/);
  const commits = page.getByRole('region', { name: /Commits on/ });
  await expect(commits).toContainText(taskBranch!);
  await expect(commits).toContainText('Committed by');
  await expectAccessible(page, 'repository history');

  // The Supply Depot links each repository to its history.
  await page.goto('/supply');
  await expect(page.getByRole('link', { name: 'History & diffs' }).first()).toBeVisible();
});
