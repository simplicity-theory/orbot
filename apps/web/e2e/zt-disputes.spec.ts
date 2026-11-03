import { expect, test } from '@playwright/test';
import type { OrbatView, SupplyView } from '@orbot/shared';
import { expectAccessible } from './axe';

/**
 * Phase 5: disputes. An Inspection bot disagrees with Guard; no standing order settles it,
 * so HQ refers it to me. I rule from the Disputes page; the work carries on.
 */
test('a dispute no standing order settles comes to me; I rule and the task resumes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const api = page.request;
  const orbat: OrbatView = await (await api.get('/api/orbat')).json();
  const unit = orbat.units.find((u) => u.unit.name === 'Inspection')!;
  const supply: SupplyView[] = await (await api.get('/api/supply')).json();
  const repo = supply.find(
    (s) => s.spec.kind === 'repository' && unit.unit.supplyIds.includes(s.id),
  )!;
  const bot = unit.bots.find((b) => b.status === 'idle')!;
  const task = await (
    await api.post('/api/tasks', {
      data: {
        unitId: unit.unit.id,
        botId: bot.id,
        title: 'Test the error pages',
        description:
          'Guard wants plain-text error pages; our accessibility checks need branded pages.',
        repoSupplyId: repo.id,
        scenario: 'dispute',
      },
    })
  ).json();
  expect((await api.post(`/api/tasks/${task.id}/run`)).status()).toBe(202);

  await page.goto('/approvals');
  const item = page.getByRole('listitem').filter({ hasText: 'Dispute with Guard' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.getByRole('link').click();
  await expect(page).toHaveURL(/\/disputes#dispute-/);

  const dispute = page.getByRole('article', { name: 'Inspection v Guard' });
  await expect(dispute).toContainText('Waiting for your ruling');
  await expect(dispute).toContainText('no standing order settles this');
  await expectAccessible(page, 'disputes');

  await dispute.getByLabel('Your reasoning').fill('Branded pages; plain text only for the API.');
  await dispute.getByRole('button', { name: 'Rule for Inspection' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Ruled: Inspection prevails. Final.' }),
  ).toBeVisible();
  await expect(dispute).toContainText('You ruled: Inspection prevails (final)');

  await expect
    .poll(async () => (await (await api.get(`/api/tasks/${task.id}`)).json()).task.status, {
      timeout: 15_000,
    })
    .toBe('done');
});
