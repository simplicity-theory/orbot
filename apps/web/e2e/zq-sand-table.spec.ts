import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** Phase 5: rehearse an operation's plan on the sand table. */
test('rehearse the plan from the operation page and read the findings', async ({ page }) => {
  await page.goto('/operations');
  await page.getByRole('link', { name: 'Operation Gatekeeper' }).click();
  const panel = page.getByRole('region', { name: 'Sand table' });
  await expect(panel).toContainText('HQ rehearses the plan once the missions are issued');
  await panel.getByRole('button', { name: 'Rehearse the plan' }).click();
  await expect(panel.locator('.verdict')).toContainText(/Go|No-go/);
  await expect(panel).toContainText('compute units');
  await expect(panel.getByRole('button', { name: 'Rehearse again' })).toBeVisible();
  await expectAccessible(page, 'sand table (dark)');
  await setTheme(page, 'light');
  await expectAccessible(page, 'sand table (light)');
  await setTheme(page, 'dark');
});
