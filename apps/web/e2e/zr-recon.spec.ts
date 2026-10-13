import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/** Phase 5: send a unit on recon from its page; the report lands on the task and with the unit. */
test('order a recon, read the report, and find it with the unit', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('article', { name: 'Engineers' })
    .getByRole('link', { name: 'Engineers' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Engineers' })).toBeVisible();
  await page.getByRole('button', { name: 'Recon…' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Recon' });
  await expect(dialog).toContainText('It changes nothing.');
  await dialog.getByLabel('What should it find out?').fill('How is the login endpoint tested?');
  await expectAccessible(page, 'recon dialog');
  await dialog.getByRole('button', { name: 'Send on recon' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Recon: How is the login endpoint tested?' }),
  ).toBeVisible();
  const report = page.getByRole('region', { name: 'Recon report', exact: true });
  await expect(report).toContainText('What I found', { timeout: 15_000 });
  await expect(report).toContainText('Read-only: nothing was changed.');
  await expectAccessible(page, 'recon task with report');

  await page.getByRole('link', { name: 'Engineers', exact: true }).first().click();
  await page.getByRole('link', { name: 'Recon', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recon reports', exact: true })).toContainText(
    'Recon: How is the login endpoint tested',
  );
  await expectAccessible(page, 'unit recon reports');
});

test('the intent dialog offers recon first', async ({ page }) => {
  await page.goto('/operations');
  await page.getByRole('button', { name: 'State intent' }).first().click();
  await expect(
    page
      .getByRole('dialog', { name: 'State intent' })
      .getByRole('checkbox', { name: /first: the building unit surveys/ }),
  ).not.toBeChecked();
});
