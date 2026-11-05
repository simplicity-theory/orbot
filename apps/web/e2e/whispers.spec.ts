import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** The whispers board: leave an unsigned note from the rail, read it back, nothing says who. */
test('leave a whisper and read the board', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: 'Whispers' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Whispers' })).toBeVisible();
  await expectAccessible(page, 'whispers (dark)');

  const note = `Rumour has it the clock test is flaky at midnight (${Date.now()}).`;
  await page.getByLabel('Leave a whisper').fill(note);
  await page.getByRole('button', { name: 'Whisper' }).click();
  const board = page.getByRole('list', { name: 'The board' });
  const item = board.getByRole('listitem').filter({ hasText: note });
  await expect(item).toBeVisible();
  await expect(item).toContainText('Heard');
  await expect(item).not.toContainText('Commander');
  await expect(page.getByLabel('Leave a whisper')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Whisper' })).toBeDisabled();

  await setTheme(page, 'light');
  await expectAccessible(page, 'whispers (light)');
  await setTheme(page, 'dark');
});
