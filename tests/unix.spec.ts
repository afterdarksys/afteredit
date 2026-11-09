import { test, expect, type Page } from '@playwright/test';
import { nativeHarness } from './nativeHarness';

async function unixHarness(page: Page) {
  await nativeHarness(page);
  await page.addInitScript(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.unixExit = 0;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.startsWith('unix_') || command === 'run_task') {
        w.testCalls.push({ command, args });
        if (command === 'unix_toolchain') return [
          { name: 'clang', available: true, detail: 'clang fixture' },
          { name: 'cmake', available: true, detail: 'cmake fixture' },
          { name: 'lldb-dap', available: true, detail: 'Found at /usr/bin/lldb-dap. Not executed, because lldb-dap waits for a debug session.' },
        ];
        if (command === 'unix_project') return { cmake: ['.'], makefiles: [{ path: 'Makefile', targets: ['all', 'install'] }], meson: [], autotools: ['src'], kernel: [], compileCommands: ['build/compile_commands.json'] };
        if (command === 'unix_man') return 'PRINTF(3) fixture';
        if (command === 'unix_pkg_config') return { found: args.name === 'libcurl', detail: args.name === 'libcurl' ? '-lcurl' : 'not found' };
        if (command === 'run_task') return { code: w.unixExit || 0, output: w.unixExit ? '/project/note.txt:4:1: error: Unix fixture failure\n' : 'cmake fixture ok\n' };
      }
      return original(command, args);
    };
  });
  await page.goto('/');
  await expect.poll(async () => page.evaluate(() => (window as any).testCalls.filter((call: { command: string }) => call.command.startsWith('unix_')).length)).toBe(0);
}

test('a reviewed CMake build exports compile commands and reaches the run monitor', async ({ page }) => {
  await unixHarness(page);
  await page.getByRole('button', { name: 'Unix development', exact: true }).click();
  await page.getByRole('button', { name: 'Check installed tools' }).click();
  await expect(page.getByText(/lldb-dap: available/)).toContainText('Not executed');
  await page.getByRole('button', { name: 'Discover project' }).click();
  await page.getByRole('combobox', { name: 'Project shape' }).selectOption('CMake · .');
  await page.getByLabel('Trust Unix commands for this project').check();
  await page.getByRole('button', { name: 'Prepare build', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Command review' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Unix command review' })).toContainText('CMAKE_EXPORT_COMPILE_COMMANDS');
  await page.getByRole('button', { name: 'Run reviewed commands' }).click();
  await expect(page.getByText('Unix action completed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Build workflows', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Run monitor', exact: true })).toContainText('cmake · succeeded');
});

test('failed Unix builds open the diagnostic in the editor', async ({ page }) => {
  await unixHarness(page);
  await page.getByRole('button', { name: 'Unix development', exact: true }).click();
  await page.getByRole('button', { name: 'Discover project' }).click();
  await page.getByLabel('Trust Unix commands for this project').check();
  await page.getByRole('button', { name: 'Prepare build', exact: true }).click();
  await page.evaluate(() => { (window as any).unixExit = 65; });
  await page.getByRole('button', { name: 'Run reviewed commands' }).click();
  await expect(page.getByText(/Unix command exited 65\. See output\./)).toBeVisible();
  await page.getByRole('button', { name: /error: \/project\/note.txt:4/ }).click();
  await expect(page.locator('.view-lines')).toContainText('original text');
});

test('man pages use the fixed argument list', async ({ page }) => {
  await unixHarness(page);
  await page.getByRole('button', { name: 'Unix development', exact: true }).click();
  await page.getByLabel('Man page').fill('printf');
  await page.getByLabel('Manual section').fill('3');
  await expect(page.getByText('man -P cat 3 printf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Look up man page' }).click();
  await expect(page.getByLabel('Unix reference')).toContainText('PRINTF');
  const call = await page.evaluate(() => (window as any).testCalls.find((item: { command: string }) => item.command === 'unix_man'));
  expect(call.args).toEqual({ page: 'printf', section: '3' });
});

test('Autotools explains configure and does not offer a reviewed command', async ({ page }) => {
  await unixHarness(page);
  await page.getByRole('button', { name: 'Unix development', exact: true }).click();
  await page.getByRole('button', { name: 'Discover project' }).click();
  await page.getByRole('combobox', { name: 'Project shape' }).selectOption('Autotools · src');
  await page.getByLabel('Trust Unix commands for this project').check();
  await page.getByRole('button', { name: 'Prepare build', exact: true }).click();
  await expect(page.getByText('not ./configure')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Unix command review' })).toHaveCount(0);
});

test('clangd setup is a draft and does not connect', async ({ page }) => {
  await unixHarness(page);
  await page.getByRole('button', { name: 'Unix development', exact: true }).click();
  await page.getByRole('button', { name: 'Discover project' }).click();
  await page.getByRole('button', { name: 'Open clangd setup' }).click();
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('cpp');
  const draft = page.getByLabel('Server command, arguments, environment and initializationOptions');
  await expect(draft).toContainText('compile-commands-dir=build');
  await expect(draft).toContainText('background-index');
  const started = await page.evaluate(() => (window as any).testCalls.some((item: { command: string }) => item.command === 'lsp_start'));
  expect(started).toBe(false);
});
