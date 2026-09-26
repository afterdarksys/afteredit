import {test, expect, type Page} from '@playwright/test';
import {nativeHarness} from './nativeHarness';

const path = '/project/note.txt';
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('.view-lines')).toContainText('original text');
}
async function edit(page: Page, text: string) {
  await page.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}
async function bridge(page: Page) {
  await page.evaluate(() => (window as any).testEmit('editor:request', {id:'waiting-command', path:'/project/note.txt'}));
  await expect(page.getByRole('button', {name:'Save & continue', exact:true})).toBeVisible();
}
test.beforeEach(async ({page}) => { await nativeHarness(page); });

test('terminal continuation saves its requested file after switching tabs', async ({page}) => {
  await ready(page);
  await page.evaluate(() => {
    const w = window as any;
    w.testDisk['/project/COMMIT_EDITMSG'] = 'commit message';
    w.testEmit('editor:request', {id:'commit', path:'/project/COMMIT_EDITMSG'});
  });
  await expect(page.locator('.view-lines')).toContainText('commit message');
  await edit(page, 'new commit message');
  await page.getByRole('button', {name:path + ', saved', exact:true}).click();
  await page.getByRole('button', {name:'Save & continue', exact:true}).click();
  await expect(page.getByRole('button', {name:'Save & continue', exact:true})).toHaveCount(0);
  const result = await page.evaluate(() => ({disk:(window as any).testDisk, calls:(window as any).testCalls.filter((c:any) => ['save_file','editor_release'].includes(c.command))}));
  expect(result.disk['/project/COMMIT_EDITMSG']).toBe('new commit message');
  expect(result.disk[path]).toBe('original text');
  expect(result.calls.map((c:any) => c.command)).toEqual(['save_file','editor_release']);
  expect(result.calls[0].args.path).toBe('/project/COMMIT_EDITMSG');
  expect(result.calls[1].args).toEqual({id:'commit', code:0});
});

test('failed bridge save keeps edits and the request pending until a successful retry', async ({page}) => {
  await ready(page); await bridge(page); await edit(page, 'my commit');
  await page.evaluate(() => { (window as any).testDisk['/project/note.txt'] = 'external edit'; });
  await page.getByRole('button', {name:'Save & continue', exact:true}).click();
  await expect(page.locator('footer [role=status]').first()).toContainText('External conflict');
  expect(await page.evaluate(() => (window as any).testCalls.filter((c:any) => c.command === 'editor_release'))).toEqual([]);
  await expect(page.getByRole('button', {name:'Save & continue', exact:true})).toBeVisible();
  await expect(page.locator('.view-lines')).toContainText('my commit');
  await page.evaluate(() => { (window as any).testDisk['/project/note.txt'] = 'original text'; });
  await page.getByRole('button', {name:'Save & continue', exact:true}).click();
  await expect(page.getByRole('button', {name:'Save & continue', exact:true})).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).testDisk['/project/note.txt'])).toBe('my commit');
});

test('a failed bridge save can still be explicitly aborted', async ({page}) => {
  await ready(page); await bridge(page); await edit(page, 'unsaved');
  await page.evaluate(() => { (window as any).testDisk['/project/note.txt'] = 'external'; });
  await page.getByRole('button', {name:'Save & continue', exact:true}).click();
  await expect(page.locator('footer [role=status]').first()).toContainText('External conflict');
  await page.getByRole('button', {name:'Abort command', exact:true}).click();
  await expect(page.getByRole('button', {name:'Abort command', exact:true})).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).testCalls.filter((c:any) => c.command === 'editor_release').map((c:any) => c.args.code))).toEqual([1]);
});

test('a watcher read started before a save cannot revert the saved buffer', async ({page}) => {
  await ready(page); await edit(page, 'new text');
  await page.evaluate(() => {
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    let once = true;
    w.__TAURI_INTERNALS__.invoke = (command:string, args:any) => {
      if (command === 'read_file' && args.path === '/project/note.txt' && once) {
        once = false;
        const old = w.testDisk[args.path];
        return new Promise(resolve => { w.releaseRead = () => resolve(old); });
      }
      return invoke(command, args);
    };
    w.testEmit('workspace:changed', {paths:['/project/note.txt']});
  });
  await page.getByRole('button', {name:'Save', exact:true}).click();
  await expect(page.getByRole('button', {name:path + ', saved', exact:true})).toBeVisible();
  await page.evaluate(async () => {
    (window as any).releaseRead();
    // Let the read continuation and React commit finish before asserting.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator('.view-lines')).toContainText('new text');
  await expect(page.getByRole('button', {name:path + ', saved', exact:true})).toBeVisible();
  expect(await page.evaluate(() => (window as any).testDisk['/project/note.txt'])).toBe('new text');
});

async function delayedFormatter(page: Page) {
  await page.addInitScript(() => {
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command:string, args:any) => {
      if (command === 'project_config') return Promise.resolve([{path:'/project/.afteredit.json', value:{editor:{formatOnSave:true}}}]);
      if (command === 'format_source') return new Promise(resolve => {
        w.releaseFormat = () => resolve({text:args.text.toUpperCase(), changed:true, formatter:'fixture'});
      });
      return invoke(command, args);
    };
  });
}

test('format-on-save preserves newer typing and lets the user retry', async ({page}) => {
  await delayedFormatter(page); await ready(page); await edit(page, 'old text');
  await page.getByRole('button', {name:'Save', exact:true}).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseFormat)).toBe('function');
  await edit(page, 'new unsaved typing');
  await page.evaluate(() => { (window as any).releaseFormat(); (window as any).releaseFormat = null; });
  await expect(page.locator('footer [role=status]').first()).toContainText('changed while formatting');
  await expect(page.locator('.view-lines')).toContainText('new unsaved typing');
  await expect(page.getByRole('button', {name:path + ', unsaved changes', exact:true})).toBeVisible();
  expect(await page.evaluate(() => (window as any).testDisk['/project/note.txt'])).toBe('original text');
  await page.getByRole('button', {name:'Save', exact:true}).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseFormat)).toBe('function');
  await page.evaluate(() => (window as any).releaseFormat());
  await expect(page.getByRole('button', {name:path + ', saved', exact:true})).toBeVisible();
  await expect(page.locator('.view-lines')).toContainText('NEW UNSAVED TYPING');
  expect(await page.evaluate(() => (window as any).testDisk['/project/note.txt'])).toBe('NEW UNSAVED TYPING');
});

test('failed formatted save preserves the unformatted buffer', async ({page}) => {
  await delayedFormatter(page); await ready(page); await edit(page, 'my edits');
  await page.getByRole('button', {name:'Save', exact:true}).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseFormat)).toBe('function');
  await page.evaluate(() => { (window as any).testDisk['/project/note.txt'] = 'external'; (window as any).releaseFormat(); });
  await expect(page.locator('footer [role=status]').first()).toContainText('External conflict');
  await expect(page.locator('.view-lines')).toContainText('my edits');
  expect(await page.evaluate(() => (window as any).testDisk['/project/note.txt'])).toBe('external');
});

test('typing during a bridge disk write remains dirty and does not release the command', async ({page}) => {
  await ready(page); await bridge(page); await edit(page, 'snapshot');
  await page.evaluate(() => {
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command:string, args:any) => command === 'save_file'
      ? new Promise((resolve, reject) => { w.releaseSave = () => invoke(command,args).then(resolve,reject); })
      : invoke(command,args);
  });
  await page.getByRole('button', {name:'Save & continue', exact:true}).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseSave)).toBe('function');
  await edit(page, 'newer typing');
  await page.evaluate(() => (window as any).releaseSave());
  await expect(page.locator('footer [role=status]').first()).toContainText('newer edits remain');
  await expect(page.locator('.view-lines')).toContainText('newer typing');
  await expect(page.getByRole('button', {name:path + ', unsaved changes', exact:true})).toBeVisible();
  await expect(page.getByRole('button', {name:'Save & continue', exact:true})).toBeVisible();
  expect(await page.evaluate(() => (window as any).testDisk['/project/note.txt'])).toBe('snapshot');
  expect(await page.evaluate(() => (window as any).testCalls.filter((c:any) => c.command === 'editor_release'))).toEqual([]);
});
