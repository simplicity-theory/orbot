import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/** Phase 5: stand down a unit, and everything; resume from the banner or with Undo. */
test.describe.configure({ mode: 'serial' });

test('stand a unit down from its page, see it everywhere, and resume from the banner', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('article', { name: 'Inspection' })
    .getByRole('link', { name: 'Inspection' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inspection' })).toBeVisible();

  await page.getByRole('button', { name: 'Stand down Inspection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stand down Inspection' });
  await expect(dialog).toContainText('pauses with a handover');
  await dialog.getByLabel('Reason').fill('Test rig is being rebuilt');
  await dialog.getByRole('button', { name: 'Stand down' }).click();

  const banner = page.getByRole('region', { name: 'Stand-down orders in force' });
  await expect(banner).toContainText('Inspection stood down: Test rig is being rebuilt');
  await expect(page.locator('.page-header orb-status')).toContainText('Stood down');
  await expectAccessible(page, 'unit stood down');

  // The order shows on every screen, and the ORBAT card says so too.
  await page.goto('/');
  await expect(banner).toContainText('Inspection stood down');
  await expect(page.getByRole('article', { name: 'Inspection' })).toContainText('Stood down');

  await banner.getByRole('button', { name: 'Resume work: Inspection' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Inspection: back to work.' }),
  ).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test('stand everything down from the header, and undo it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stand down all units' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stand down all units' });
  await dialog.getByLabel('Reason').fill('Incident review');
  await dialog.getByRole('button', { name: 'Stand down' }).click();

  const banner = page.getByRole('region', { name: 'Stand-down orders in force' });
  await expect(banner).toContainText('All units stood down: Incident review');
  await expect(page.getByRole('button', { name: 'Stand down all units' })).toHaveCount(0);
  await expectAccessible(page, 'everything stood down');

  await page
    .getByRole('status')
    .filter({ hasText: 'All units stood down.' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stand down all units' })).toBeVisible();
});
