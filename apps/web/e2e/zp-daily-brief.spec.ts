import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** Phase 5: the daily brief, and where phone alerts are set up. */
test('read the daily brief from the rail, writing today’s on demand', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: 'Daily brief' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Daily brief' })).toBeVisible();
  await expect(page.getByText('No brief yet')).toBeVisible();
  await page.getByRole('button', { name: "Write today's brief now" }).click();
  const brief = page.getByRole('article');
  await expect(brief).toContainText('Written by HQ at');
  await expect(brief.getByRole('heading', { name: /Needs you \(\d+\)/ })).toBeVisible();
  await expect(brief.getByRole('table')).toContainText('Engineers');
  await expectAccessible(page, 'daily brief (dark)');
  await setTheme(page, 'light');
  await expectAccessible(page, 'daily brief (light)');
  await setTheme(page, 'dark');
});

test('Settings: the brief time, and phone alerts by a stored push URL', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByLabel('At (local time)')).toHaveValue('07:00');
  await expect(page.getByLabel('Time zone')).toHaveValue('UTC');
  await expect(page.getByRole('checkbox', { name: /Alert my phone/ })).not.toBeChecked();
  await expect(page.getByLabel('Push URL (credential)').locator('option:checked')).toHaveText(
    'None',
  );
  await expect(page.getByRole('button', { name: 'Send a test alert' })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Alert me about' })).toContainText('Escalations');
  await expectAccessible(page, 'settings with alerts');
});
