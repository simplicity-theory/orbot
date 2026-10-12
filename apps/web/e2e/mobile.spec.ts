import { expect, test } from '@playwright/test';

test('on a phone the rail is a drawer and the ORBAT, Approvals and Sitreps work', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ORBAT' })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Approvals' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/sitreps');
  await expect(page.getByRole('list', { name: 'Sitreps' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
