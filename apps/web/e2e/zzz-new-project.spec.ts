import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/**
 * A new project whose deployment is one HTML file: started from the Operations page, it lands on
 * its operation with the repository and the site assigned, and both show in the Supply Depot.
 * Runs last: the project it starts stays in the shared record the other specs read.
 */
test('start a new single-HTML project: operation launched with its repository and site', async ({
  page,
}) => {
  await page.goto('/operations');
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Project name').fill('Pocket Ledger');
  await dialog
    .getByLabel('Intent')
    .fill('A personal ledger that works offline and keeps its data in the browser.');
  await expectAccessible(page, 'new project dialog');
  await dialog.getByRole('button', { name: 'Start project and launch' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Operation Pocket Ledger' }),
  ).toBeVisible();
  const resources = page.getByRole('region', { name: 'Resources' });
  const assigned = resources.getByRole('list', { name: 'Assigned resources' });
  await expect(assigned).toContainText('Pocket Ledger');
  await expect(assigned).toContainText('Pocket Ledger site');
  await expect(resources).toContainText(
    'A production environment to deploy to · Pocket Ledger site',
  );
  await expect(resources).not.toContainText('Waiting at the O Group');
  await expectAccessible(page, 'operation of a new project');

  await page.goto('/supply');
  const repo = page.getByRole('listitem').filter({ hasText: 'Pocket Ledger' }).first();
  await expect(repo).toContainText('single HTML file');
  await expect(repo).toContainText('One self-contained HTML file, index.html');
  await page.goto('/supply?section=environments');
  const site = page.getByRole('listitem').filter({ hasText: 'Pocket Ledger site' }).first();
  await expect(site).toContainText('static site');
  await expect(site).toContainText('production');
  await expect(site).toContainText('nothing published yet');
  await expectAccessible(page, 'depot with a static site');

  // Starting a repository from a template on its own, in the depot.
  await page.goto('/supply');
  await page.getByRole('button', { name: 'Connect repository' }).first().click();
  const add = page.getByRole('dialog', { name: 'Connect repository' });
  await add.getByLabel('Start a new one from a template').check();
  await add.getByLabel('Name').fill('Scratch Pad');
  await expect(add.getByText(/The product is index.html alone/)).toBeVisible();
  await expectAccessible(page, 'start a repository from a template');
  await add.getByRole('button', { name: 'Start repository' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Scratch Pad' }).first()).toContainText(
    'single HTML file',
  );
});
