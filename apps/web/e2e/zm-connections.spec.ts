import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';
import { FakeGitHub } from './fake-github';

test.describe.configure({ mode: 'serial' });
const gh = new FakeGitHub();
test.beforeAll(() => gh.start());
test.afterAll(() => gh.stop());

/** Phase 5: connections to a code host, issue tracker and build pipeline. */
test('connections start empty, and the depot connects a service', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: 'Connections' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
  await expect(page.getByText('Nothing connected')).toBeVisible();
  await expectAccessible(page, 'connections (empty)');

  await page.getByRole('link', { name: 'Supply Depot' }).last().click();
  await page.getByRole('button', { name: 'service' }).click();
  const form = page.locator('form').filter({ hasText: 'Connect service' });
  await expect(form.getByLabel('API URL')).toHaveValue('https://api.github.com');
  await expect(form.getByLabel('For repository').locator('option')).not.toHaveCount(0);
  await expect(form.getByRole('group', { name: 'Use it as' })).toContainText('Build pipeline');
  await expectAccessible(page, 'connect a service (dark)');
  await setTheme(page, 'light');
  await expectAccessible(page, 'connect a service (light)');
  await setTheme(page, 'dark');
});

test('connect GitHub from the depot, then take an issue on from Connections', async ({ page }) => {
  await page.goto('/supply');
  await page.getByRole('button', { name: 'credential' }).click();
  const cred = page.locator('form').filter({ hasText: 'Store credential' });
  await cred.getByLabel('Name').fill('gh-token');
  await cred.getByLabel('Value').fill(gh.token);
  await cred.getByRole('button', { name: 'Store credential' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Stored credential gh-token' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'service' }).click();
  const form = page.locator('form').filter({ hasText: 'Connect service' });
  await form.getByLabel('Name', { exact: true }).fill('GitHub acme/app');
  await form.getByLabel('API URL').fill(gh.url);
  await form.getByLabel('Owner').fill('acme');
  await form.getByLabel('Repository name').fill('app');
  await form.getByLabel(/Push URL/).fill(gh.remote);
  await form.getByLabel('Token (credential)').selectOption({ label: 'gh-token' });
  await form.getByRole('button', { name: 'Connect service' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Connected GitHub acme/app.' }),
  ).toBeVisible();

  await page.goto('/connections');
  const conn = page.getByRole('region', { name: 'GitHub acme/app' });
  await expect(conn).toContainText('acme/app');
  await expect(conn).toContainText('Code host · Issue tracker · Build pipeline');
  const issues = conn.getByRole('list', { name: 'Open issues on GitHub acme/app' });
  await expect(issues).toContainText('#42 Session cookie lacks SameSite');
  await expectAccessible(page, 'connections (connected)');
  await issues.getByLabel('Unit to take on issue #42').selectOption({ label: 'Guard' });
  await issues.getByRole('button', { name: 'Take on' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Issue #42 taken on' })).toBeVisible();
  await expect(issues).toContainText('Taken on by Guard');

  // Disconnect (later specs run without it); the history stays.
  await conn.getByRole('button', { name: 'Disconnect GitHub acme/app' }).click();
  await expect(page.getByText('Nothing connected')).toBeVisible();
});
