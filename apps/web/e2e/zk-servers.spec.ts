import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, setTheme } from './axe';

async function depotSection(page: Page, name: RegExp) {
  await page
    .getByRole('navigation', { name: 'Supply Depot sections' })
    .getByRole('link', { name })
    .click();
}

/** Servers bots log in to: a multi-line key as a credential, then the server form. */
test('Supply Depot: store an SSH key and connect a server (an unreachable one is refused)', async ({
  page,
}) => {
  await page.goto('/supply');
  await depotSection(page, /Credentials/);
  await expect(page).toHaveURL(/section=credentials/);
  await page.getByRole('button', { name: 'Store credential' }).first().click();
  const cred = page.getByRole('dialog', { name: 'Store credential' });
  await cred.getByLabel('Name', { exact: true }).fill('web-key');
  await cred.getByRole('checkbox', { name: /several lines/ }).check();
  const value = cred.getByRole('textbox', { name: 'Value', exact: true });
  await expect(value).toHaveJSProperty('tagName', 'TEXTAREA');
  await value.fill(
    '-----BEGIN OPENSSH PRIVATE KEY-----\nnotarealkey\n-----END OPENSSH PRIVATE KEY-----',
  );
  await cred.getByRole('button', { name: 'Store credential' }).click();
  await expect(page.getByText('Stored credential web-key')).toBeVisible();
  await expect(cred).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Credentials' })).toContainText('web-key');

  await depotSection(page, /Servers & environments/);
  await page.getByRole('button', { name: 'Add server or environment' }).first().click();
  const form = page.getByRole('dialog', { name: 'Add server or environment' });
  await form.getByLabel('Name').fill('web1');
  // A dev environment is always a server: its fields show without the checkbox.
  await form.getByRole('radio', { name: /Dev server/ }).check();
  await expect(form.getByRole('checkbox', { name: /server bots log in to/ })).toHaveCount(0);
  await expect(form.getByText(/its own folder/)).toBeVisible();
  await form.getByRole('radio', { name: /Staging/ }).check();
  await form.getByRole('checkbox', { name: /server bots log in to/ }).check();
  await expect(form.getByRole('button', { name: 'Connect server' })).toBeDisabled();
  await form.getByLabel('Host').fill('127.0.0.1');
  await form.getByLabel('Port').fill('1');
  await form.getByLabel('User').fill('deploy');
  await form.getByLabel('SSH key (credential)').selectOption('web-key');
  await expectAccessible(page, 'connect a server (dark)');
  await form.getByRole('button', { name: 'Connect server' }).click();
  // The refusal stays in the dialog, so nothing typed is lost.
  await expect(form.getByRole('alert')).toContainText('Could not reach SSH on 127.0.0.1:1.');
  // The theme switch reloads the page: open the server form again for the light check.
  await setTheme(page, 'light');
  await page.getByRole('button', { name: 'Add server or environment' }).first().click();
  await form.getByRole('checkbox', { name: /server bots log in to/ }).check();
  await expect(form.getByLabel('Host')).toBeVisible();
  await expectAccessible(page, 'connect a server (light)');
  await setTheme(page, 'dark');
});
