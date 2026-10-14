import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/** Settings: put the whole force on one runtime (e.g. Claude Code on your own plan). */
test('Settings: switch every bot to one runtime', async ({ page }) => {
  await page.goto('/settings');
  const select = page.getByLabel('Run every bot on');
  await expect(select).toHaveValue('simulated');
  await page.getByRole('button', { name: 'Switch all bots' }).click();
  await expect(page.getByText('Every bot already runs on simulated.')).toBeVisible();
  await expectAccessible(page, 'settings with runtime switch');
});
