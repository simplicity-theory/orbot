import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** Phase 2: one unit under command. Runs after shell/record specs (it changes the seed state). */

async function openEngineers(page: Page, section?: string) {
  await page.goto('/');
  await page
    .getByRole('article', { name: 'Engineers' })
    .getByRole('link', { name: 'Engineers' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Engineers' })).toBeVisible();
  if (section)
    await page
      .getByRole('navigation', { name: 'Unit sections' })
      .getByRole('link', { name: new RegExp(section) })
      .click();
}

test.describe.configure({ mode: 'serial' });

test('a backbrief is approved inline on the ORBAT, without leaving the page', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('article', { name: 'Engineers' });
  await card.getByRole('button', { name: 'Review' }).click();
  const bb = card.getByRole('article', { name: 'Harden session handling' });
  await expect(bb).toContainText('Rotate session ids on login');
  await bb.getByRole('button', { name: 'Approve' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Approved\. 2 task\(s\) issued to Engineers/ }),
  ).toBeVisible();
  await expect(card.getByRole('region', { name: 'Needs you in Engineers' })).not.toContainText(
    'Harden session handling',
  );
  await expect(page.getByRole('button', { name: /items need you/ })).toContainText('2');
});

test('a new mission is planned, sent back, re-planned and approved with changes', async ({
  page,
}) => {
  await openEngineers(page);
  await page.getByRole('button', { name: 'New mission' }).click();
  const dialog = page.getByRole('dialog', { name: 'New mission' });
  await dialog.getByLabel('Goal').fill('Add audit logging');
  await dialog.getByLabel(/Definition of done/).fill('Log every login\nLog every logout');
  await dialog.getByRole('button', { name: 'Give mission' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Mission given to Engineers.' }),
  ).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/approvals$/);
  const bb = page.getByRole('article', { name: 'Add audit logging' });
  await expect(bb).toContainText('Log every logout');

  await bb.getByRole('button', { name: 'Send back…' }).click();
  await bb.getByLabel('What should the Overseer change?').fill('Logout first, please');
  await bb.getByRole('button', { name: 'Send back' }).click();
  await expect(bb).toContainText('round 2');
  await expect(bb).toContainText('Logout first, please');

  await bb.getByRole('button', { name: 'Amend…' }).click();
  await bb.getByLabel('Task 1 title').fill('Log every login, with IP');
  await bb.getByLabel('What did you change, and why?').fill('Capture the IP too');
  await expectAccessible(page, 'approvals (amending)');
  await bb.getByRole('button', { name: 'Approve with changes' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Approved with changes\. 2 task\(s\) issued/ }),
  ).toBeVisible();

  await openEngineers(page);
  // At simulation speed 0 the work is already done: the mission shows as complete.
  await expect(page.getByRole('region', { name: 'Missions' })).toContainText(
    /Complete:.*Add audit logging/,
  );
  await expect(page.getByRole('region', { name: 'Tasks', exact: true })).toContainText(
    'Log every login, with IP',
  );
});

test('the Field Manual: provenance, edit with undo, history', async ({ page }) => {
  await openEngineers(page, 'Field Manual');
  await expect(page).toHaveURL(/section=field-manual/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
    /Engineers.*Field Manual/,
  );
  // A lesson promoted from a handover, linked to its source.
  const lesson = page.locator('.entry').filter({ hasText: 'Test suite is slow on a cold cache' });
  await expect(lesson.getByRole('link', { name: /Task #\d+ handover v1/ }).first()).toBeVisible();

  const branching = page.locator('.entry').filter({ hasText: 'Branching' });
  await branching.getByRole('button', { name: 'Edit' }).click();
  // Only one entry is in edit mode at a time.
  await page
    .getByLabel('Text', { exact: true })
    .fill('One task, one branch. Rebase before handing over.');
  await page.getByLabel('Why the change?').fill('Fewer merge conflicts');
  await page.getByRole('button', { name: 'Save new version' }).click();
  const toast = page.getByRole('status').filter({ hasText: '“Branching” saved as version 2.' });
  await expect(toast).toBeVisible();
  await expect(branching).toContainText('Rebase before handing over.');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(branching).not.toContainText('Rebase before handing over.');
  await expect(branching).toContainText('v3');

  await branching.getByRole('link', { name: 'History' }).click();
  const versions = page.getByRole('navigation', { name: 'Versions' });
  await expect(versions.getByRole('link')).toHaveCount(3);
  await expect(versions).toContainText('Undo: Fewer merge conflicts');
});

test('each unit section is reachable and accessible, in both themes', async ({ page }) => {
  for (const theme of ['dark', 'light'] as const) {
    await page.goto('/');
    await setTheme(page, theme);
    await openEngineers(page);
    await expectAccessible(page, `unit overview (${theme})`);
    for (const section of ['Field Manual', 'War Diary', 'Handovers', 'Rules', 'Supply']) {
      await page
        .getByRole('navigation', { name: 'Unit sections' })
        .getByRole('link', { name: new RegExp(section) })
        .click();
      await expect(
        page
          .getByRole('navigation', { name: 'Unit sections' })
          .getByRole('link', { name: new RegExp(section) }),
      ).toHaveAttribute('aria-current', 'page');
      await expectAccessible(page, `unit ${section} (${theme})`);
    }
  }
  await setTheme(page, 'dark');
});

test('a handover reads as a document, can be edited (new version) and undone', async ({ page }) => {
  await openEngineers(page, 'Handovers');
  await page
    .getByRole('link', { name: /Handover: Task #\d+ — Add rate limiter middleware/ })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'Next steps' })).toBeVisible();
  await expectAccessible(page, 'document page');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Markdown').fill('# Handover\n\n## State\nCorrected by the Commander.\n');
  await page.getByLabel('Why the change?').fill('Correction');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved as version 2.' })).toBeVisible();
  await expect(page.locator('.markdown')).toContainText('Corrected by the Commander.');
  await page
    .getByRole('status')
    .filter({ hasText: 'Saved as version 2.' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(page.locator('.markdown')).not.toContainText('Corrected by the Commander.');
  await expect(page.locator('.page-header__eyebrow')).toContainText('version 3');
});

test('cold-start check runs from the unit view', async ({ page }) => {
  await openEngineers(page);
  const card = page.getByRole('region', { name: 'Cold-start check' });
  await card.getByRole('button', { name: 'Run check now' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Cold-start check: \d+\/100/ }),
  ).toBeVisible();
  await expect(card).toContainText('/100');
});

test('a bot is replaced: the new one takes over its work and shows what it was briefed with', async ({
  page,
}) => {
  await openEngineers(page);
  await page.getByRole('link', { name: 'E-2', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Last brief' })).toContainText(
    /\d+ Field Manual.*entries/,
  );
  await page.getByRole('button', { name: 'Replace bot…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace a bot' });
  await dialog.getByLabel('Reason').fill('Rotating E-2 out');
  await dialog.getByRole('button', { name: 'Replace' }).click();
  await expect(page.getByRole('status').filter({ hasText: /E-\d+ replaces E-2\./ })).toBeVisible();
  await expect(page.locator('orb-status').first()).toContainText('Stood down');
  await expect(
    page.getByRole('status').filter({ hasText: 'This bot is stood down' }),
  ).toBeVisible();
});

test('command palette and keyboard shortcuts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('bot e-1');
  await expect(palette.getByRole('option').first()).toContainText('Bot E-1');
  await expectAccessible(page, 'command palette');
  await input.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'E-1' })).toBeVisible();

  await page.keyboard.press('Control+k');
  await input.fill('cold-start engineers');
  await input.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: /Engineers cold-start check: \d+\/100/ }),
  ).toBeVisible();

  await page.keyboard.press('Control+k');
  await input.fill('quokka');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/archive\?q=quokka/);

  await page.locator('body').press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Go to Approvals');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await page.keyboard.press('g');
  await page.keyboard.press('o');
  await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
});

test('the Needs-you popover resolves items in place', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /items need you/ }).click();
  const inbox = page.getByRole('dialog', { name: 'Needs you' });
  await expect(inbox).toBeVisible();
  await expectAccessible(page, 'needs-you popover');
  await page.keyboard.press('Escape');
  await expect(inbox).toHaveCount(0);
});
