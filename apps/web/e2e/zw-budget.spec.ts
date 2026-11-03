import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/** Phase 5: compute budget caps, set from the unit page and shown on the ORBAT. */
test('set a unit’s compute budget cap and see it on the ORBAT', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('article', { name: 'Logistics' });
  await expect(card.getByRole('meter', { name: 'Compute budget of Logistics' })).toBeVisible();
  await card.getByRole('link', { name: 'Logistics' }).click();

  const panel = page.getByRole('region', { name: 'Compute budget' });
  await expect(panel).toContainText('cap 100 not enforced');
  await panel.getByRole('button', { name: 'Set budget…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compute budget for Logistics' });
  await expect(dialog).toContainText('warns at 80%');
  await dialog.getByLabel('Cap (units)').fill('40');
  await dialog.getByLabel('Reason').fill('Quarter-end freeze');
  await dialog.getByRole('button', { name: 'Set budget' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Budget for Logistics set.' }),
  ).toBeVisible();
  await expect(panel).toContainText('cap 40 not enforced');
  await expect(panel.getByRole('meter', { name: 'Compute budget of Logistics' })).toHaveAttribute(
    'aria-valuemax',
    '40',
  );
  await expectAccessible(page, 'unit budget');

  await page.goto('/');
  await expect(page.getByRole('article', { name: 'Logistics' })).toContainText(
    'cap 40 not enforced',
  );

  // Put it back for the specs that follow.
  await page
    .getByRole('article', { name: 'Logistics' })
    .getByRole('link', { name: 'Logistics' })
    .click();
  await page
    .getByRole('region', { name: 'Compute budget' })
    .getByRole('button', { name: 'Set budget…' })
    .click();
  await dialog.getByLabel('Cap (units)').fill('100');
  await dialog.getByLabel('Reason').fill('Freeze over');
  await dialog.getByRole('button', { name: 'Set budget' }).click();
  await expect(page.getByRole('region', { name: 'Compute budget' })).toContainText(
    'cap 100 not enforced',
  );
});
