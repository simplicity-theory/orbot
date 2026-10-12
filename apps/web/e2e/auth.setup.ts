import { expect, test as setup } from '@playwright/test';

setup('sign in as the Commander', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Passphrase').fill('test-commander-passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'ORBAT' })).toBeVisible();
  await page.context().storageState({ path: 'e2e/.auth/commander.json' });
});
