import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** Phase 5: every bot's service record, on its page. */
test('a bot page shows its service record', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('article', { name: 'Inspection' })
    .getByRole('link', { name: 'Inspection' })
    .click();
  await page.getByRole('link', { name: 'I-1' }).first().click();
  const record = page.getByRole('region', { name: 'Service record' });
  await expect(record).toContainText('Joined Inspection');
  await expect(record.getByRole('definition').first()).toBeVisible();
  await expect(record).toContainText('Success rate');
  await expect(record.getByRole('list', { name: 'Service record entries' })).toContainText(
    'Joined Inspection',
  );
  await expect(record).toContainText('It never goes into a brief');
  await expectAccessible(page, 'service record (dark)');
  await setTheme(page, 'light');
  await expectAccessible(page, 'service record (light)');
  await setTheme(page, 'dark');
});
