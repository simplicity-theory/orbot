import { expect, test } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

/** Servers bots log in to: a multi-line key as a credential, then the server form. */
test('Supply Depot: store an SSH key and connect a server (an unreachable one is refused)', async ({
  page,
}) => {
  await page.goto('/supply');
  await page.getByRole('button', { name: 'credential' }).click();
  await expect(page.getByRole('button', { name: 'Store credential' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('web-key');
  await page.getByRole('checkbox', { name: /several lines/ }).check();
  const value = page.getByRole('textbox', { name: 'Value', exact: true });
  await expect(value).toHaveJSProperty('tagName', 'TEXTAREA');
  await value.fill(
    '-----BEGIN OPENSSH PRIVATE KEY-----\nnotarealkey\n-----END OPENSSH PRIVATE KEY-----',
  );
  await page.getByRole('button', { name: 'Store credential' }).click();
  await expect(page.getByText('Stored credential web-key')).toBeVisible();

  await page.getByRole('button', { name: 'environment', exact: true }).click();
  const form = page.locator('form').filter({ has: page.locator('#env-name') });
  await form.getByLabel('Name').fill('web1');
  // A dev environment is always a server: its fields show without the checkbox.
  await form.getByLabel('Tier').selectOption('dev');
  await expect(form.getByRole('checkbox', { name: /server bots log in to/ })).toHaveCount(0);
  await expect(form.getByText(/their own folder on it/)).toBeVisible();
  await form.getByLabel('Tier').selectOption('staging');
  await form.getByRole('checkbox', { name: /server bots log in to/ }).check();
  await expect(form.getByRole('button', { name: 'Connect server' })).toBeDisabled();
  await form.getByLabel('Host').fill('127.0.0.1');
  await form.getByLabel('Port').fill('1');
  await form.getByLabel('User').fill('deploy');
  await form.getByLabel('SSH key (credential)').selectOption('web-key');
  await expectAccessible(page, 'connect a server (dark)');
  await form.getByRole('button', { name: 'Connect server' }).click();
  await expect(page.getByText('Could not reach SSH on 127.0.0.1:1.')).toBeVisible();
  // The theme switch reloads the page: open the server form again for the light check.
  await setTheme(page, 'light');
  await page.getByRole('button', { name: 'environment', exact: true }).click();
  await form.getByRole('checkbox', { name: /server bots log in to/ }).check();
  await expect(form.getByLabel('Host')).toBeVisible();
  await expectAccessible(page, 'connect a server (light)');
  await setTheme(page, 'dark');
});
