import { expect, test } from '@playwright/test';
import type { OrbatView, SupplyView } from '@orbot/shared';
import { expectAccessible } from './axe';

/** Phase 5: HQ tracks who touches what. Two bots change the same file; the map shows it. */
test('two tasks change the same file: the Deconfliction map and the task page show it', async ({
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
  const bots = unit.bots.filter((b) => b.status === 'idle').slice(-2);
  const tasks = [];
  for (const [i, bot] of bots.entries()) {
    const task = await (
      await api.post('/api/tasks', {
        data: {
          unitId: unit.unit.id,
          botId: bot.id,
          title: ['Raise the API rate limit', 'Lower the login rate limit'][i],
          repoSupplyId: repo.id,
          scenario: 'shared-file',
        },
      })
    ).json();
    expect((await api.post(`/api/tasks/${task.id}/run`)).status()).toBe(202);
    tasks.push(task);
  }

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await expect(page.getByRole('heading', { level: 1, name: 'Deconfliction' })).toBeVisible();
  const overlaps = page.getByRole('region', { name: /Overlaps/ });
  await expect(overlaps).toContainText('src/config/limits.js', { timeout: 15_000 });
  await expect(overlaps).toContainText('both bots were told');
  const row = page.getByRole('row').filter({ hasText: 'src/config/limits.js' });
  await expect(row).toContainText('Raise the API rate limit');
  await expect(row).toContainText('Lower the login rate limit');
  await expectAccessible(page, 'deconfliction map');

  await row.getByRole('link', { name: /Raise the API rate limit/ }).click();
  const panel = page.getByRole('region', { name: 'Overlaps with other work' });
  await expect(panel).toContainText('src/config/limits.js is also changed by');
  await expect(panel).toContainText('Lower the login rate limit');
  await expect(page.getByText('HQ deconfliction').first()).toBeVisible();

  // Let both finish (they would otherwise hold for a minute): pause, then resume from the handover.
  for (const bot of bots) {
    await api.post('/api/stand-down', {
      data: { scope: 'bot', targetId: bot.id, reason: 'Demo over' },
    });
    await api.post('/api/stand-down/lift', {
      data: { scope: 'bot', targetId: bot.id, reason: 'Demo over' },
    });
  }
  for (const t of tasks) {
    await expect
      .poll(async () => (await (await api.get(`/api/tasks/${t.id}`)).json()).task.status)
      .toBe('done');
  }
});
