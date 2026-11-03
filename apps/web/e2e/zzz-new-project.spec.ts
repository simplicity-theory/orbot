import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/**
 * A new theatre whose product is one HTML file: opened from the Theatres page, it lands on its
 * first operation with the repository and the site assigned, both show in the Supply Depot, and
 * the theatre's page lists what it holds and the operation. Runs last: what it opens stays in
 * the shared record the other specs read.
 */
test('open a single-HTML theatre: operation launched with its repository and site', async ({
  page,
}) => {
  await page.goto('/theatres');
  await page.getByRole('button', { name: 'New theatre' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New theatre' });
  await dialog.getByLabel('Theatre name').fill('Pocket Ledger');
  await dialog
    .getByLabel('First intent')
    .fill('A personal ledger that works offline and keeps its data in the browser.');
  await expectAccessible(page, 'new theatre dialog');
  await dialog.getByRole('button', { name: 'Open theatre and launch' }).click();

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
  await expect(page.locator('.page-header__eyebrow')).toContainText('Pocket Ledger');
  await expectAccessible(page, 'operation of a new project');

  // The theatre's page: what it holds, and the operation run in it.
  await page
    .locator('.page-header__eyebrow')
    .getByRole('link', { name: /Pocket Ledger/ })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Theatre Pocket Ledger' }),
  ).toBeVisible();
  const held = page.getByRole('list', { name: 'Theatre resources' });
  await expect(held).toContainText('Pocket Ledger');
  await expect(held).toContainText('Pocket Ledger site');
  await expect(held).toContainText('main');
  await expect(page.getByRole('link', { name: 'Operation Pocket Ledger' })).toBeVisible();
  await expectAccessible(page, 'theatre page');
  await page.goto('/theatres');
  await expect(page.getByRole('link', { name: 'Theatre Pocket Ledger' })).toBeVisible();
  await expectAccessible(page, 'theatres board');

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
