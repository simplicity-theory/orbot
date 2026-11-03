import { expect, test } from '@playwright/test';
import type { OrbatView, SupplyView } from '@orbot/shared';
import { expectAccessible } from './axe';

/**
 * Rules of engagement: an Engineers bot reaches something its unit must escalate (a new
 * dependency) and asks permission. It waits in Needs you; I refuse with a reason, and the bot
 * carries on without it.
 */
test('a bot asks permission under its rules of engagement; I decide in Needs you', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const api = page.request;
  const orbat: OrbatView = await (await api.get('/api/orbat')).json();
  const unit = orbat.units.find((u) => u.unit.name === 'Engineers')!;
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
        title: 'Format report dates',
        description: 'Show dates in the reader’s locale.',
        repoSupplyId: repo.id,
        scenario: 'needs-permission',
      },
    })
  ).json();
  expect((await api.post(`/api/tasks/${task.id}/run`)).status()).toBe(202);

  await page.goto('/approvals');
  const item = page
    .getByRole('listitem')
    .filter({ hasText: `#${task.number}` })
    .filter({ hasText: `${bot.callsign} asks permission` });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item).toContainText('Add a new production dependency');
  await expect(item).toContainText('Must escalate: “Adding a new dependency”');
  await expectAccessible(page, 'approvals with a permission request');

  await item.getByRole('button', { name: 'Refuse…' }).click();
  await item.getByLabel('Why refuse?').fill('Use the standard library.');
  await item.getByRole('button', { name: 'Refuse', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Permission refused (task #${task.number}).` }),
  ).toBeVisible();

  await expect
    .poll(async () => (await (await api.get(`/api/tasks/${task.id}`)).json()).task.status, {
      timeout: 15_000,
    })
    .toBe('done');
  await page.goto(`/units/${unit.unit.id}/bots/${bot.id}/tasks/${task.id}`);
  await expect(
    page.getByRole('status').filter({
      hasText: 'Permission refused: Add a new production dependency — Use the standard library.',
    }),
  ).toBeVisible();
});
