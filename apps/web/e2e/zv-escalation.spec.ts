import { expect, test } from '@playwright/test';
import type { OrbatView, SupplyView } from '@orbot/shared';
import { expectAccessible } from './axe';

/**
 * Phase 5: stuck work goes up the chain. An Inspection bot goes silent; with a one-second stall
 * threshold its Overseer checks in, then pauses it, and HQ escalates it to the Commander.
 */
test('a stalled task is escalated to me; I acknowledge it, then set the thresholds in Settings', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const api = page.request;
  const settings = await (await api.get('/api/settings')).json();
  await api.put('/api/settings', {
    data: {
      escalation: { ...settings.escalation, stallSeconds: 1 },
      reason: 'Demo: a very short stall threshold',
      expectedVersion: settings.version,
    },
  });

  const orbat: OrbatView = await (await api.get('/api/orbat')).json();
  const unit = orbat.units.find((u) => u.unit.name === 'Inspection')!;
  const supply: SupplyView[] = await (await api.get('/api/supply')).json();
  const repo = supply.find(
    (s) => s.spec.kind === 'repository' && unit.unit.supplyIds.includes(s.id),
  )!;
  const task = await (
    await api.post('/api/tasks', {
      data: {
        unitId: unit.unit.id,
        botId: unit.bots[0]!.id,
        title: 'Rebuild the artifact cache',
        repoSupplyId: repo.id,
        scenario: 'long-haul',
      },
    })
  ).json();
  expect((await api.post(`/api/tasks/${task.id}/run`)).status()).toBe(202);

  await page.goto('/approvals');
  const item = page.getByRole('listitem').filter({ hasText: 'Escalation · stall' });
  await expect(item).toContainText(`Task #${task.number} “Rebuild the artifact cache” stalled`, {
    timeout: 20_000,
  });
  await expectAccessible(page, 'approvals with an escalation');

  // The chain is on the task's record: Overseer, then HQ, then me.
  await item.getByRole('link').click();
  await expect(page.getByText('Escalation · Overseer').first()).toBeVisible();
  await expect(page.getByText('Escalation · HQ').first()).toBeVisible();
  await expect(page.getByText('Escalation · To you').first()).toBeVisible();

  await page.goto('/approvals');
  await item.getByRole('button', { name: /^Acknowledge/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Escalation acknowledged.' }),
  ).toBeVisible();
  await expect(item).toHaveCount(0);

  // Back to a sensible threshold, through Settings.
  await page.goto('/settings');
  await page.getByLabel('Stall: no progress for (minutes)').fill('10');
  await page.getByLabel('Why the change?').fill('Back to normal');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible();
  const after = await (await api.get('/api/settings')).json();
  expect(after.escalation.stallSeconds).toBe(600);
});
