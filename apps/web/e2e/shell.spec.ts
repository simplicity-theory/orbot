import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

test.describe('app shell', () => {
  test('ORBAT shows every unit, the product name, and what needs me', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'ORBOT home' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
    const units = page.getByRole('list', { name: 'Units' });
    for (const name of ['Engineers', 'Logistics', 'Inspection', 'Guard']) {
      await expect(units.getByRole('heading', { name })).toBeVisible();
    }
    const engineers = page.getByRole('article', { name: 'Engineers' });
    await expect(engineers.getByRole('region', { name: 'Needs you in Engineers' })).toContainText(
      'E-2 blocked',
    );
    await expect(engineers).toContainText('failed');
    await expect(page.getByRole('link', { name: /items need you/ })).toContainText('2');
  });

  test('left rail navigates and collapses; breadcrumbs mirror the chain of command', async ({
    page,
  }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main' });
    await rail.getByRole('link', { name: 'Archive' }).click();
    await expect(page).toHaveURL(/\/archive$/);
    await expect(rail.getByRole('link', { name: 'Archive' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('ORBAT');

    await rail.getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(rail.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
    await page.reload();
    await expect(rail.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
    await rail.getByRole('button', { name: 'Expand navigation' }).click();
  });

  test('two clicks from the ORBAT to a bot, with breadcrumbs back up', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('article', { name: 'Engineers' })
      .getByRole('link', { name: 'Engineers' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Engineers' })).toBeVisible();
    await page.getByRole('link', { name: 'E-1', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E-1' })).toBeVisible();
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toContainText('ORBAT');
    await expect(crumbs).toContainText('Engineers');
    await expect(crumbs).toContainText('Bot E-1');
    await crumbs.getByRole('link', { name: 'Engineers' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Engineers' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'E-1' })).toBeVisible();
  });

  test('theme toggle switches dark/light and persists', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('glossary tooltip explains military terms on focus', async ({ page }) => {
    await page.goto('/');
    const term = page.locator('h1 .term');
    await term.focus();
    // Visible tooltip for sighted users…
    await expect(page.locator('.cdk-overlay-container')).toContainText('Order of battle');
    // …and the same definition as the term's accessible description for screen readers.
    await expect(term).toHaveAccessibleDescription(/Order of battle/);
    await term.press('Escape');
    await expect(page.locator('.cdk-overlay-container')).not.toContainText('Order of battle');
  });

  test('screens with nothing to show explain themselves', async ({ page }) => {
    await page.goto('/archive');
    await expect(page.getByRole('heading', { name: 'Search the permanent record' })).toBeVisible();
    await page.goto('/no/such/place');
    await expect(page.getByRole('heading', { name: 'Nothing at this address' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to the ORBAT' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
  });
});

test.describe('accessibility (axe, WCAG 2.2 AA)', () => {
  const screens = ['/', '/approvals', '/sitreps', '/archive', '/operations', '/settings'];
  for (const theme of ['dark', 'light'] as const) {
    test(`main screens pass in ${theme} theme`, async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
      for (const path of screens) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectAccessible(page, `${path} (${theme})`);
      }
    });
  }
});
