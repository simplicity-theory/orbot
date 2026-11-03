import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';
import { FakeGitHub } from './fake-github';

test.describe.configure({ mode: 'serial' });
const gh = new FakeGitHub();
test.beforeAll(() => gh.start());
test.afterAll(() => gh.stop());

/**
 * A theatre goes on GitHub from its page (the repository made there, main pushed), and a
 * campaign planned in it runs its steps one after another as operations until every step is
 * done (D126, D127). Runs last: what it opens (a production site) would make the operation specs ambiguous.
 */
test('put a theatre on GitHub, plan a campaign in it, watch the steps run in turn', async ({
  page,
}) => {
  await page.goto('/theatres');
  await page.getByRole('button', { name: 'New theatre' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New theatre' });
  await dialog.getByLabel('Theatre name').fill('Campaign Trail');
  await dialog.getByRole('button', { name: 'Open theatre', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Theatre Campaign Trail' }),
  ).toBeVisible();

  // On GitHub: the repository is created under the token's user; main is pushed now.
  const bare = mkdtempSync(join(tmpdir(), 'orbot-ui-gh-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare]);
  gh.cloneUrls.set('campaign-trail', bare);
  await page.getByRole('button', { name: 'Put on GitHub…' }).click();
  const ghDialog = page.getByRole('dialog', { name: 'Put Theatre Campaign Trail on GitHub' });
  await expect(ghDialog.getByRole('button', { name: 'Put it on GitHub' })).toBeDisabled();
  await ghDialog.getByLabel('GitHub user or organisation').fill('acme');
  await expect(ghDialog.getByLabel('Repository name')).toHaveAttribute(
    'placeholder',
    'campaign-trail',
  );
  await ghDialog.getByLabel(/Personal access token/).fill(gh.token);
  await ghDialog.getByText('GitHub Enterprise').click();
  await ghDialog.getByLabel('API URL').fill(gh.url);
  await expectAccessible(page, 'put on GitHub dialog');
  await ghDialog.getByRole('button', { name: 'Put it on GitHub' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Theatre Campaign Trail is on GitHub' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'On GitHub: acme/campaign-trail' })).toBeVisible();
  expect(gh.created).toEqual([{ name: 'campaign-trail', private: true }]);
  const pushed = execFileSync('git', ['-C', bare, 'rev-parse', 'main']).toString().trim();
  expect(pushed).toMatch(/^[0-9a-f]{40}$/);

  // Plan a campaign: step 1 launches now.
  await page.getByRole('button', { name: 'Plan a campaign…' }).click();
  const plan = page.getByRole('dialog', { name: 'Plan a campaign' });
  await plan.getByLabel('Campaign name').fill('Polish');
  await plan
    .getByLabel('Steps, one per line, in order')
    .fill('1. Build the first version.\n2. Add a dark mode toggle.');
  await expect(plan.getByText('2 step(s).')).toBeVisible();
  await expectAccessible(page, 'plan a campaign dialog');
  await plan.getByRole('button', { name: 'Plan and launch step 1' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Campaign Polish' })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Campaign steps' }).locator('> li');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText('Operation Build the first version');
  await expect(steps.nth(1)).toContainText('Add a dark mode toggle');
  await expect(steps.nth(1)).toContainText('Queued');
  await expect(
    page.locator('.page-header__eyebrow').getByRole('link', { name: /Campaign Trail/ }),
  ).toBeVisible();
  await expectAccessible(page, 'campaign page (under way)');

  // Fully automatic: step 2 launches when step 1 closes; the campaign ends when both are done.
  await expect(steps.nth(1)).toContainText('Operation Add a dark mode toggle', { timeout: 60_000 });
  await expect(page.locator('.page-header__eyebrow')).toContainText('done', { timeout: 60_000 });
  await expect(page.getByText('2 of 2 step(s) done.')).toBeVisible();
  await expectAccessible(page, 'campaign page (done)');

  // The operation page shows which campaign and step it is; the theatre lists the campaign;
  // main on GitHub followed each landing.
  await steps.nth(1).getByRole('link', { name: 'Operation Add a dark mode toggle' }).click();
  await expect(page.locator('.page-header__eyebrow')).toContainText('step 2 of 2');
  await page
    .locator('.page-header__eyebrow')
    .getByRole('link', { name: /Theatre/ })
    .click();
  const campaigns = page.getByRole('list', { name: 'Campaigns in this theatre' });
  await expect(campaigns).toContainText('Campaign Polish');
  await expect(campaigns).toContainText('2 of 2 step(s) done');
  await expect(page.getByRole('link', { name: 'Open the app' })).toBeVisible();
  await expect
    .poll(() => execFileSync('git', ['-C', bare, 'rev-parse', 'main']).toString().trim())
    .not.toBe(pushed);

  // The same finding was left open by both steps: HQ recommends the fix under Needs you, with
  // one button and no stop (D130). Taken up, it is an operation in the theatre.
  await page.goto('/approvals');
  const recs = page.getByRole('list', { name: 'HQ recommends' });
  await expect(recs).toContainText('Fix: Fix touch targets on the add button are below 24px');
  await expect(recs).toContainText('Left open again after Operation Build the first version');
  await expectAccessible(page, 'needs you with a recommendation');
  await recs.getByRole('button', { name: 'Launch the fix' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Operation launched in Theatre Campaign Trail' }),
  ).toBeVisible();
  await expect(recs).toHaveCount(0);
  await page.goto('/theatres');
  await page.getByRole('link', { name: 'Theatre Campaign Trail' }).click();
  await expect(
    page.getByRole('link', { name: 'Operation Fix: touch targets on the add button' }),
  ).toBeVisible();
  // Each operation shows its time and spend.
  await expect(
    page.getByLabel('Time and spend of Operation Build the first version'),
  ).toContainText('compute units');
});
