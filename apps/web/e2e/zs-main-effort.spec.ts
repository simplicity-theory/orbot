import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** Phase 5: name the main effort on an operation, see it everywhere, clear it in chat, undo. */
test.describe.configure({ mode: 'serial' });

test('make an operation the main effort, and see it on the ORBAT and the board', async ({
  page,
}) => {
  await page.goto('/operations');
  await page.getByRole('link', { name: 'Operation Gatekeeper' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Operation Gatekeeper' })).toBeVisible();

  await page.getByRole('button', { name: 'Make main effort' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Operation Gatekeeper is now the main effort.' }),
  ).toBeVisible();
  const header = page.locator('.page-header');
  await expect(header).toContainText('Main effort');
  await expect(header).toContainText('Its tasks go first');
  await expect(page.getByRole('button', { name: 'Clear main effort' })).toBeVisible();
  await expectAccessible(page, 'operation, main effort');

  await page.goto('/operations');
  await expect(page.getByRole('listitem', { name: 'Operation Gatekeeper' })).toContainText(
    'Main effort',
  );

  await page.goto('/');
  const strip = page.locator('.effort');
  await expect(strip).toContainText('Operation Gatekeeper');
  await expect(strip).toContainText('Named by the Commander');
  await setTheme(page, 'light');
  await expectAccessible(page, 'ORBAT with a main effort (light)');
  await setTheme(page, 'dark');
  await strip.getByRole('link', { name: 'Operation Gatekeeper' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Operation Gatekeeper' })).toBeVisible();
});

test('clear it in chat to HQ; name it again and undo from the toast', async ({ page }) => {
  await page.goto('/chat/hq');
  await expect(page.getByRole('log')).toHaveAttribute('aria-busy', 'false');
  const box = page.getByRole('textbox', { name: /Message/ });
  await box.fill('No main effort any more.');
  await box.press('Enter');
  await expect(page.getByRole('article', { name: 'Overseer reply' }).last()).toContainText(
    'No main effort any more: work goes in normal queue order.',
  );

  await page.goto('/');
  await expect(page.locator('.effort')).toContainText('No main effort');

  await page.goto('/operations');
  await page.getByRole('link', { name: 'Operation Gatekeeper' }).click();
  await page.getByRole('button', { name: 'Make main effort' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Operation Gatekeeper is now the main effort.' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(page.getByRole('button', { name: 'Make main effort' })).toBeVisible();
  await expect(page.locator('.page-header')).not.toContainText('Its tasks go first');
});

test('Settings: whether supporting work makes way for the main effort', async ({ page }) => {
  await page.goto('/settings');
  const box = page.getByRole('checkbox', { name: /pauses \(with a handover\) to free a bot/ });
  await expect(box).toBeChecked();
});
