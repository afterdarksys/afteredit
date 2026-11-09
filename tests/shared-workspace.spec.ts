import { test, expect } from '@playwright/test';
import { nativeHarness } from './nativeHarness';

test('GUI shares versioned buffers and preserves a conflicting local draft', async ({ page }) => {
  await nativeHarness(page);
  await page.addInitScript(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    let buffer = { path: '/project/note.txt', text: 'initial\n', version: 1, dirty: false };
    w.remoteEdit = () => { buffer = { ...buffer, text: 'from CLI\n', version: buffer.version + 1, dirty: true }; };
    const capabilities = { root: '/project', protocol: 1, methods: ['session.status', 'buffer.open', 'buffer.get', 'buffer.edit', 'buffer.save'] };
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'service_start') return { endpoint: '/private/session.sock', capabilities };
      if (command !== 'service_request') return original(command, args);
      w.testCalls.push({ command, args });
      if (args.method === 'capabilities') return capabilities;
      if (args.method === 'buffer.edit' || args.method === 'buffer.save') {
        if (args.params.version !== buffer.version) throw new Error('Version conflict');
        buffer = { ...buffer, text: args.params.text ?? buffer.text, version: buffer.version + 1, dirty: args.method === 'buffer.edit' };
      }
      return { ...buffer };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Shared workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Start or join current workspace' }).click();
  await page.getByLabel('File path', { exact: true }).fill('note.txt');
  await page.getByRole('button', { name: 'Open shared file' }).click();
  const editor = page.getByLabel('Shared buffer', { exact: true });
  await editor.fill('from GUI\n');
  await page.getByRole('button', { name: 'Publish draft', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Shared workspace', exact: true })).toContainText('Revision 2');
  await editor.fill('my pending work\n');
  await page.evaluate(() => (window as any).remoteEdit());
  await expect(page.getByRole('region', { name: 'Conflicting shared edit' })).toBeVisible();
  await expect(editor).toHaveValue('my pending work\n');
  await expect(page.getByLabel('Latest shared text')).toHaveValue('from CLI\n');
  await expect(page.getByRole('button', { name: 'Save shared file' })).toBeDisabled();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download draft copy' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('note.txt.recovery.txt');
  await page.getByRole('button', { name: 'Replace local draft with displayed shared version' }).click();
  await expect(editor).toHaveValue('from CLI\n');
  await editor.fill('merged\n');
  await editor.press('Control+s');
  await expect(page.getByRole('status').filter({ hasText: 'Saved to disk and shared' })).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Shared workspace', exact: true }).click();
  await expect(editor).toHaveValue('merged\n');
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(calls.filter((c: any) => c.command === 'service_request' && c.args.method === 'buffer.save')).toHaveLength(1);
  expect(calls.filter((c: any) => c.command === 'save_file')).toHaveLength(0);
});

test('shared workspace checks an SSH host and opens a remote file', async ({ page }) => {
  await nativeHarness(page);
  await page.addInitScript(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    const opened = { path: '/srv/app/main.rs', text: 'fn main() {}\n', version: 1, dirty: false };
    const capabilities = { root: '/srv/app', protocol: 1, methods: ['capabilities', 'files', 'buffer.open', 'buffer.get', 'buffer.edit', 'buffer.save'] };
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'ssh_workspace_connect') {
        w.testCalls.push({ command, args });
        return { endpoint: 'ssh://dev/srv/app', capabilities };
      }
      if (command !== 'service_request') return original(command, args);
      w.testCalls.push({ command, args });
      if (args.method === 'files') return [{ name: 'main.rs', path: '/srv/app/main.rs', directory: false }];
      if (args.method === 'buffer.open' || args.method === 'buffer.get') return { ...opened };
      if (args.method === 'capabilities') return capabilities;
      throw new Error(`Unexpected shared request ${args.method}`);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Shared workspace', exact: true }).click();
  const remote = page.getByRole('group', { name: 'Remote host' });
  await expect(remote).toContainText('No password is stored.');
  await expect(remote).toContainText('This panel does not open it yet.');
  await expect(remote.locator('option[value=sah]')).toHaveAttribute('disabled', '');
  await expect(page.getByRole('button', { name: 'Start or join current workspace' })).toBeEnabled();
  await page.getByLabel('SSH host').fill('dev');
  await page.getByLabel('Remote project').fill('/srv/app');
  await page.getByRole('button', { name: 'Check and open remote project' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Remote project is open. Files stay on that host.' })).toBeVisible();
  await page.getByRole('button', { name: 'main.rs', exact: true }).click();
  await expect(page.getByLabel('Shared buffer', { exact: true })).toHaveValue('fn main() {}\n');
  const calls = await page.evaluate(() => (window as any).testCalls as { command: string; args: Record<string, unknown> }[]);
  const connect = calls.filter(c => c.command === 'ssh_workspace_connect');
  expect(connect).toHaveLength(1);
  expect(connect[0].args).toEqual({ host: 'dev', workspace: '/srv/app' });
  expect(JSON.stringify(connect[0].args)).not.toMatch(/password|identity|ProxyCommand|ssh /i);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('ssh.workspace.v1:/project') || 'null'))).toEqual({ host: 'dev', path: '/srv/app' });
});
