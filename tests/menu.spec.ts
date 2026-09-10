import {test,expect,type Page} from '@playwright/test';
import {nativeHarness} from './nativeHarness';
async function edit(page:Page,text:string){await page.locator('.view-lines').click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.insertText(text);}
async function command(page:Page,id:string){await page.evaluate(id=>(window as any).testEmit('menu:command',id),id);}
async function ready(page:Page){await page.goto('/');await expect(page.getByRole('button',{name:'Report cursor and indentation'})).toBeEnabled();await expect.poll(()=>page.evaluate(()=>(window as any).testCalls.filter((c:any)=>c.command==='update_menu').at(-1)?.args.enabled.includes('file.new'))).toBe(true);}
test.beforeEach(async({page})=>{await nativeHarness(page);});
test('File menu creates independent buffers, saves, and cancels dirty close',async({page})=>{
 await page.addInitScript(()=>{const w=window as any,invoke=w.__TAURI_INTERNALS__.invoke;w.testDiscard=false;w.__TAURI_INTERNALS__.invoke=async(c:string,a:any)=>{
  if(c==='confirm_discard')return w.testDiscard;
  if(c==='save_as'){w.testDisk['/project/new.txt']=a.content;return '/project/new.txt';}
  return invoke(c,a);
 };});
 await ready(page);
 await command(page,'file.new');
 const editor=page.getByRole('textbox',{name:/Code editor: inmemory:\/\/untitled/});
 await expect(editor).toHaveCount(1);await edit(page,'new draft');
 await command(page,'file.close');await expect(editor).toHaveCount(1);
 await command(page,'file.save');await expect(page.getByRole('textbox',{name:/Code editor: \/project\/new.txt/})).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).testDisk['/project/new.txt'])).toBe('new draft');
 await command(page,'file.close');await expect(page.getByRole('textbox',{name:/Code editor: inmemory:\/\/scratch/})).toHaveCount(1);
 await command(page,'go.next');await expect(page.getByRole('textbox',{name:/Code editor: \/project\/note.txt/})).toHaveCount(1);
});
test('Selection and Go commands reach the real Monaco editor',async({page})=>{
 await ready(page);
 const editor=page.getByRole('textbox',{name:/Code editor:/});await edit(page,'one\ntwo\nthree');
 await command(page,'editor.action.gotoLine');
 const go=page.getByRole('textbox',{name:/Type a line number/});await expect(go).toBeVisible();await go.fill(':2');await go.press('Enter');
 await expect(go).toBeHidden();await command(page,'expandLineSelection');await expect(page.locator('.selected-text').first()).toBeVisible();await page.keyboard.press('Backspace');
 await command(page,'file.save');
 await expect.poll(()=>page.evaluate(()=>(window as any).testDisk['/project/note.txt'])).toBe('one\nthree');
});
test('View and Terminal commands toggle layout without restarting the shell',async({page})=>{
 await ready(page);
 await command(page,'view.sidebar');await expect(page.getByRole('complementary',{name:'File explorer'})).toBeHidden();
 await command(page,'view.sidebar');await expect(page.getByRole('complementary',{name:'File explorer'})).toBeVisible();
 await command(page,'view.terminal');await expect(page.getByRole('region',{name:'Terminal',exact:true})).toBeHidden();
 await command(page,'terminal.focus');await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
 await command(page,'terminal.review');await expect(page.getByLabel('Terminal output snapshot')).toBeFocused();
 await command(page,'terminal.interrupt');
 await expect.poll(()=>page.evaluate(()=>(window as any).testCalls.some((c:any)=>c.command==='pty_write'&&c.args.data==='\u0003'))).toBe(true);
 expect(await page.evaluate(()=>(window as any).testCalls.filter((c:any)=>c.command==='spawn_pty').length)).toBe(1);
 await command(page,'view.settings');await expect(page.getByRole('heading',{name:'Workspace settings'})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).testCalls.filter((c:any)=>c.command==='update_menu').at(-1)?.args.enabled.includes('expandLineSelection'))).toBe(false);
 await command(page,'view.open-editors');await expect(page.getByRole('dialog',{name:'Commands'})).toBeVisible();
 await page.getByRole('button',{name:'/project/note.txt',exact:true}).click();await expect(page.getByRole('textbox',{name:/Code editor:/})).toHaveCount(1);
});
test('Save All preserves external conflict and close-folder cancellation',async({page})=>{
 await page.addInitScript(()=>{const w=window as any,invoke=w.__TAURI_INTERNALS__.invoke;w.__TAURI_INTERNALS__.invoke=async(c:string,a:any)=>c==='confirm_discard'?false:invoke(c,a);});
 await ready(page);await edit(page,'local edit');
 await page.evaluate(()=>(window as any).testDisk['/project/note.txt']='external edit');
 await command(page,'file.save-all');await expect(page.locator('footer [role=status]')).toContainText('External conflict');
 await command(page,'file.close-folder');await expect(page.getByRole('textbox',{name:/Code editor: \/project\/note.txt/})).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).testDisk['/project/note.txt'])).toBe('external edit');
});
