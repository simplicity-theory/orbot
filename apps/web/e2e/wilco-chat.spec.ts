import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** Phase 3: command by chat. Runs last (it changes Guard's orders and supply). */
test.describe.configure({ mode: 'serial' });

async function openGuardChat(page: Page) {
  await page.goto('/');
  await page.getByRole('article', { name: 'Guard' }).getByRole('heading').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Guard' })).toBeVisible();
  await page.keyboard.press('c');
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function say(drawer: ReturnType<Page['getByRole']>, text: string) {
  const replies = drawer.getByRole('article', { name: 'Overseer reply' });
  const before = await replies.count();
  const box = drawer.getByRole('textbox', { name: /Message/ });
  await box.fill(text);
  await box.press('Enter');
  await expect(replies).toHaveCount(before + 1);
  // Pin this reply: later confirmations add more replies after it.
  return replies.nth(before);
}

test('an order in chat changes live work: rule change and supply grant, read back with links and Undo', async ({
  page,
}) => {
  const drawer = await openGuardChat(page);
  // Pre-targeted to the Overseer of the unit on screen.
  await expect(drawer.getByLabel('Talk to')).toHaveValue(/[0-9a-f-]{36}/);
  await expect(drawer.getByRole('log', { name: /Guard Overseer/ })).toBeVisible();

  const reply = await say(
    drawer,
    'Stop blocking on low-severity findings. I’ll give you access to the payments repo.',
  );
  await expect(reply).toContainText('Wilco.');
  const changes = reply.getByRole('list', { name: 'Changes made' }).getByRole('listitem');
  await expect(changes).toHaveCount(2);
  await expect(changes.nth(0)).toContainText('dropped “Low-severity findings also block release.”');
  await expect(changes.nth(1)).toContainText('payments-service (repository) issued to Guard.');
  await expectAccessible(page, 'chat drawer with read-back');

  // No other input: the held-up Guard tasks finish on their own.
  await drawer.getByRole('button', { name: 'Close chat' }).click();
  const tasks = page.getByRole('region', { name: 'Tasks', exact: true });
  await expect(tasks.locator('orb-status')).toHaveText([/Done/, /Done/], { timeout: 15_000 });

  // Undo the supply grant from the read-back.
  await page.keyboard.press('c');
  await changes.nth(1).getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /^Undone: payments-service/ }),
  ).toBeVisible();
  await expect(changes.nth(1)).toContainText('Undone');

  // The read-back links straight to the change.
  await changes.nth(0).getByRole('link', { name: 'Guard rules' }).click();
  await expect(page).toHaveURL(/section=rules/);
  await expect(page.getByRole('region', { name: 'Standing orders' })).toContainText(
    'Stop blocking on low-severity findings.',
  );
});

test('musing is not ordering: Yes, do it / No', async ({ page }) => {
  const drawer = await openGuardChat(page);
  const reply = await say(drawer, 'I might give you more budget.');
  await expect(reply).toContainText('Did you mean that as an order?');
  await reply.getByRole('button', { name: 'Yes, do it' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Guard compute budget raised by 10' }),
  ).toBeVisible();
  await expect(reply).toContainText('You confirmed it');

  const second = await say(drawer, 'Maybe you could have more budget.');
  await second.getByRole('button', { name: 'No' }).click();
  await expect(second).toContainText('You said no — nothing changed.');
});

test('irreversible orders need the typed confirmation', async ({ page }) => {
  const drawer = await openGuardChat(page);
  const reply = await say(drawer, 'Grant Guard production deploy rights.');
  await expect(reply).toContainText('That cannot be undone.');
  const confirm = reply.getByRole('button', { name: 'Confirm' });
  await expect(confirm).toBeDisabled();
  await reply.getByLabel('Type “confirm” to go ahead').fill('confirm');
  await confirm.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Guard now has deploy rights to production.' }),
  ).toBeVisible();
  await expect(reply).toContainText('You confirmed it');
});

test('promised supply that is not connected: the reply says what is missing and opens the depot', async ({
  page,
}) => {
  const drawer = await openGuardChat(page);
  const reply = await say(drawer, 'I’ll give you access to the billing repo.');
  await expect(reply).toContainText(/Not connected in the Supply Depot.*billing repository/);
  await reply.getByRole('link', { name: 'Open Supply Depot' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Supply Depot' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'An Overseer asked for billing repository' }),
  ).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('billing');
  await expectAccessible(page, 'supply depot');
});

test('the orders log lists every chat change with its message, and deep links work', async ({
  page,
}) => {
  await page.goto('/orders');
  await expect(page.getByRole('heading', { level: 1, name: 'Orders log' })).toBeVisible();
  const entry = page
    .locator('.entry')
    .filter({ hasText: 'payments-service (repository) issued to Guard.' })
    .first();
  await expect(entry).toContainText('Undone');
  await entry.getByRole('link', { name: /Stop blocking on low-severity findings/ }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}\?m=/);
  await expect(page.locator('.msg.highlight')).toContainText(
    'Stop blocking on low-severity findings.',
  );
  await expectAccessible(page, 'full-page chat');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.goto('/orders');
    await expectAccessible(page, `orders log (${theme})`);
  }
});

test('the command palette opens chat with a unit, and HQ routes orders to the named unit', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const input = page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox');
  await input.fill('chat with hq');
  await input.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await expect(drawer.getByLabel('Talk to')).toHaveValue('hq');
  const reply = await say(drawer, 'Logistics, document the rollback procedure.');
  await expect(reply).toContainText('via HQ');
  await expect(reply).toContainText('New mission for Logistics');
});
