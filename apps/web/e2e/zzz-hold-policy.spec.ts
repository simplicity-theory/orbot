import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/** The hold policy: set on a unit's Rules tab, overridden on an operation. Runs last. */
test('set what holds the work on a unit, then override it for one operation', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('article', { name: 'Guard' })
    .getByRole('link', { name: 'Guard', exact: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: /Guard/ })).toBeVisible();
  const url = new URL(page.url());
  await page.goto(`${url.pathname}?section=rules`);

  const section = page.getByRole('region', { name: 'What holds the work' });
  await expect(section).toContainText('Findings with a small fix are fixed on the spot');
  await section.getByRole('button', { name: 'Change hold policy' }).click();
  const form = section.getByRole('form', { name: 'Hold policy for Guard' });
  await form.getByLabel('What holds the work for you').selectOption('never');
  await form.getByLabel('What a bot may fix on its own').selectOption('large');
  await form.getByLabel(/Why the change/).fill('Hardening week is over');
  await expectAccessible(page, 'hold policy form');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(section).toContainText('nothing ever holds the work (automatic)');
  await expect(section.getByText('automatic', { exact: true })).toBeVisible();

  // The operation keeps each unit's own policy until overridden.
  await page.goto('/operations');
  await page.getByRole('link', { name: /Operation Gatekeeper/ }).click();
  const op = page.getByRole('region', { name: 'What holds the work' });
  await expect(op).toContainText('Each unit’s own hold policy applies');
  await op.getByRole('button', { name: 'Change hold policy' }).click();
  const opForm = op.getByRole('form', { name: /Hold policy for Operation Gatekeeper/ });
  await opForm.getByLabel(/Override every unit/).check();
  await opForm.getByLabel('What holds the work for you').selectOption('low');
  await opForm.getByLabel('What a bot may fix on its own').selectOption('none');
  await opForm.getByRole('button', { name: 'Save' }).click();
  await expect(op).toContainText('Findings are recorded, never fixed by the bot');
  await expectAccessible(page, 'operation with a hold policy override');
});
