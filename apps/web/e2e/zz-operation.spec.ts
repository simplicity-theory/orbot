import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';

/** Phase 4: an operation from intent to production, driven from the UI. Runs last. */
test('state intent, approve the plans and the deploy, give deploy rights in chat — the operation closes with an After Action review', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Guard's seeded standing order would hold its review on low-severity findings: lift it first.
  await page.goto('/chat/hq');
  const hqBox = page.getByRole('textbox', { name: /Message/ });
  await hqBox.fill('Guard, stop blocking on low-severity findings.');
  await hqBox.press('Enter');
  await expect(page.getByRole('article', { name: 'Overseer reply' }).last()).toContainText(
    'Wilco.',
  );

  await page.goto('/operations');
  await expect(page.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible();
  await page.getByRole('button', { name: 'State intent' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'State intent' });
  await dialog.getByLabel('Intent').fill('Ship audit logging to production.');
  await dialog.getByLabel(/Code name/).fill('Ledger');
  await dialog.getByRole('button', { name: 'Launch operation' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Operation Ledger' })).toBeVisible();
  const needs = page.getByRole('region', { name: 'Needs you' });
  // Three units brief back (Inspection's gate approves its own plan).
  await expect(needs.getByRole('article')).toHaveCount(3, { timeout: 15_000 });
  await expectAccessible(page, 'operation page');
  for (let i = 0; i < 3; i++) {
    await needs.getByRole('article').first().getByRole('button', { name: 'Approve' }).click();
    await expect(needs.getByRole('article')).toHaveCount(2 - i, { timeout: 10_000 });
  }

  // Work flows Engineers → Inspection (send-back, fix, re-check) → Guard → Logistics; the deploy waits for me.
  const approveDeploy = page.getByRole('button', { name: 'Approve deploy' });
  await expect(approveDeploy).toBeVisible({ timeout: 30_000 });
  await approveDeploy.click();
  await expect(
    page.getByRole('status').filter({ hasText: /Production deploy approved/ }),
  ).toBeVisible();

  // Logistics has no deploy rights: blocked. Grant them in chat, with the typed confirmation.
  await page.keyboard.press('Escape');
  await page.locator('body').press('c');
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await drawer.getByLabel('Talk to').selectOption({ label: 'Logistics Overseer' });
  const box = drawer.getByRole('textbox', { name: /Message/ });
  await box.fill('Grant Logistics production deploy rights.');
  await box.press('Enter');
  const reply = drawer.getByRole('article', { name: 'Overseer reply' }).last();
  await reply.getByLabel('Type “confirm” to go ahead').fill('confirm');
  await reply.getByRole('button', { name: 'Confirm' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Logistics now has deploy rights to production.' }),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Close chat' }).click();

  await expect(page.getByRole('list', { name: /Operation phase/ })).toHaveAttribute(
    'aria-label',
    'Operation phase: Closed',
    { timeout: 30_000 },
  );
  await expect(page.getByText(/Deployed to production at/)).toBeVisible();
  await expect(page.getByRole('region', { name: /After Action review/ })).toContainText(
    'Lessons kept as standing orders',
  );

  await page.goto('/operations');
  await expect(page.getByRole('link', { name: 'Operation Ledger' })).toBeVisible();
  await expectAccessible(page, 'operations board');
});
