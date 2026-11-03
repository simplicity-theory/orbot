import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

test.describe('one bot, one task, on the record', () => {
  test('the completed task shows every step it took, its workspace and its handover', async ({
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
    await expect(
      page.getByRole('heading', { level: 1, name: 'Add rate limiter middleware' }),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      /ORBAT.*Engineers.*Bot E-1.*Task #\d+/,
    );
    await expect(page.locator('orb-status').first()).toContainText('Done');

    const record = page.getByRole('list', { name: 'Working record' });
    await expect(record).toContainText('Run started');
    await expect(record).toContainText('Workspace');
    await expect(record).toContainText('Commit');
    await expect(record).toContainText('Used demo-app-push-token');

    await record
      .getByRole('button', { name: /^Commit / })
      .first()
      .click();
    await expect(page.getByRole('region', { name: 'Selected entry' })).toContainText(
      '"kind": "commit"',
    );

    await expect(page.getByRole('region', { name: /Handover/ })).toContainText('## Next steps');
    await expectAccessible(page, 'task page');
  });

  test('a blocked bot is one click from the ORBAT, with the reason', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /E-2 blocked on/ }).click();
    // The decision comes first: why it is held, what to do, the bot's open problems, the controls.
    const decision = page.getByRole('region', { name: 'Held for your decision' });
    await expect(decision).toBeVisible();
    const held = decision.getByRole('status').filter({ hasText: 'Upstream API client' });
    await expect(held).toBeVisible();
    await expect(held).toContainText('What to do: Resume the task once the upstream client');
    await expect(decision).toContainText('Open problems the bot reports');
    await expect(decision.getByRole('link', { name: /Give Engineers an order/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume task' })).toBeVisible();
    // The chain of command is on the task: its mission, and the mission's tasks around it.
    const chain = page.getByRole('region', { name: 'Chain of command' });
    await expect(chain).toContainText('(this task)');
    // The orders are there, folded away under the decision.
    const orders = page.locator('details.orders');
    await expect(orders).not.toHaveAttribute('open', '');
  });

  test('archive: search, history with who/when/why, diff, and as-of', async ({ page }) => {
    await page.goto('/archive');
    await page.getByLabel('Search the record').fill('rollback');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/q=rollback/);
    await page
      .getByRole('region', { name: 'Documents' })
      .getByRole('link', { name: 'Logistics Field Manual' })
      .click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Logistics Field Manual' }),
    ).toBeVisible();
    const versions = page.getByRole('navigation', { name: 'Versions' });
    await expect(versions).toContainText('Current');
    await expect(versions).toContainText('Superseded');

    await versions.getByRole('link', { name: /^v2/ }).click();
    const banner = page.getByRole('note');
    await expect(banner).toContainText('Version 2 is archived');
    await expect(banner).toContainText('Added rollback procedure');
    await banner.getByRole('link', { name: /View version 3/ }).click();
    await expect(page.getByRole('note')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Changes' }).click();
    const diff = page.getByRole('table', { name: 'Differences between versions' });
    await expect(diff).toContainText('Rollback');
    await expect(diff.locator('.added').first()).toBeVisible();
    await expectAccessible(page, 'history diff');

    await page.getByLabel('View as it stood on').fill('2000-01-01T00:00');
    await page.getByRole('button', { name: 'Go' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'did not exist yet' })).toBeVisible();

    // Deep links work: reload keeps the view.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('archive search finds old wording only in archived versions', async ({ page }) => {
    await page.goto('/archive?q=%22Staging%20first%2C%20always.%22');
    await expect(page.getByRole('region', { name: 'Documents' })).toContainText(
      'Logistics Field Manual',
    );
    await page.getByLabel('Which tier').selectOption('archive');
    await expect(
      page.getByRole('region', { name: 'Documents' }).getByText('Archived').first(),
    ).toBeVisible();
  });

  test('history page is accessible in light theme', async ({ page }) => {
    await page.goto('/archive?q=rollback');
    await setTheme(page, 'light');
    await page.getByRole('link', { name: 'Logistics Field Manual' }).first().click();
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expectAccessible(page, 'history (light)');
    await setTheme(page, 'dark');
  });
});

test('starting a queued task shows the bot working live, with a toast', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('article', { name: 'Engineers' })
    .getByRole('link', { name: 'Engineers' })
    .click();
  await page
    .getByRole('region', { name: 'Tasks', exact: true })
    .getByRole('link', { name: /Document rate limits/ })
    .click();
  await expect(page.locator('orb-status').first()).toContainText('Queued');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Task #\d+ started/ })).toBeVisible();
  // No reload: the live feed brings the run in as it happens.
  await expect(page.locator('orb-status').first()).toContainText('Done', { timeout: 15_000 });
  await page
    .locator('cdk-virtual-scroll-viewport')
    .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByRole('list', { name: 'Working record' })).toContainText('Run finished');
});
