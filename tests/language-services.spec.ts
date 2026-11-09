import { test, expect } from '@playwright/test';

test('language services describe hierarchy and the editor asks for a server', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Language services', exact: true }).click();
  await expect(page.getByText('Semantic tokens, inlay hints, and call and type hierarchy are requested when the server offers them.')).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Call hierarchy' })).toBeEnabled();
  await page.getByRole('button', { name: 'Call hierarchy' }).click();
  await expect(page.locator('.editor-navigation [role=status]')).toHaveText('Connect a language server that supports this hierarchy.');
  await page.getByRole('button', { name: 'Type hierarchy' }).click();
  await expect(page.locator('.editor-navigation [role=status]')).toHaveText('Connect a language server that supports this hierarchy.');
});
