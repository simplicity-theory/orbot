import { expect, test, type Browser } from '@playwright/test';
import { expectAccessible } from './axe';

/** Phase 5: other officers with ranks. The Commander appoints; a Captain commands their units. */
test.describe.configure({ mode: 'serial' });

async function signInAs(browser: Browser, login: string, password: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByRole('radio', { name: 'An officer' }).check();
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
  return page;
}

test('the Commander appoints a Captain of Engineers, and an Observer', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: 'Officers' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Officers' })).toBeVisible();
  await expect(page.getByText('No other officers yet')).toBeVisible();
  await expectAccessible(page, 'officers (empty)');

  for (const o of [
    { name: 'Ada Lovelace', login: 'ada', rank: 'Captain', units: ['Engineers'] },
    { name: 'Obi Okafor', login: 'obi', rank: 'Observer', units: [] },
  ]) {
    await page.getByRole('button', { name: 'Appoint an officer' }).click();
    const d = page.getByRole('dialog', { name: 'Appoint an officer' });
    await d.getByLabel('Name').fill(o.name);
    await d.getByLabel('Login').fill(o.login);
    await d.getByRole('radio', { name: o.rank }).check();
    for (const u of o.units) await d.getByRole('checkbox', { name: u }).check();
    await d.getByLabel(/First password/).fill('a-long-enough-password');
    await expectAccessible(page, `appoint ${o.rank}`);
    await d.getByRole('button', { name: 'Appoint' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${o.name} appointed` })).toBeVisible();
  }
  const table = page.getByRole('table');
  await expect(table.getByRole('row', { name: /Ada Lovelace/ })).toContainText('Engineers');
  await expect(table.getByRole('row', { name: /Obi Okafor/ })).toContainText('Observer');
  await expectAccessible(page, 'officers (two)');
});

test('a Captain commands their own unit, and only that', async ({ browser }) => {
  const page = await signInAs(browser, 'ada', 'a-long-enough-password');
  await expect(page.getByRole('banner')).toContainText('Ada Lovelace');
  await expect(page.getByRole('banner')).toContainText('Captain');
  await expect(page.getByRole('button', { name: 'Stand down all units' })).toHaveCount(0);

  await page
    .getByRole('article', { name: 'Engineers' })
    .getByRole('link', { name: 'Engineers' })
    .click();
  await expect(page.getByRole('button', { name: 'New mission' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stand down Engineers' })).toBeVisible();

  await page.goto('/');
  await page.getByRole('article', { name: 'Guard' }).getByRole('heading').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Guard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New mission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stand down Guard' })).toHaveCount(0);
  await expectAccessible(page, 'captain on another unit');

  await page.goto('/settings');
  await expect(page.getByText('Only a Commander changes settings.')).toBeVisible();
  await page.context().close();
});

test('an Observer reads, with a note saying so', async ({ browser }) => {
  const page = await signInAs(browser, 'obi', 'a-long-enough-password');
  await expect(page.getByRole('note')).toContainText('signed in as an Observer');
  await page
    .getByRole('article', { name: 'Engineers' })
    .getByRole('link', { name: 'Engineers' })
    .click();
  await expect(page.getByRole('button', { name: 'New mission' })).toHaveCount(0);
  await expectAccessible(page, 'observer');
  await page.context().close();
});
