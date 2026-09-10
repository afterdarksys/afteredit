import {test,expect} from '@playwright/test';
import {nativeHarness} from './nativeHarness';
test('production workbench mounts editor and terminal without uncaught errors',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await nativeHarness(page);await page.goto('/');
 await expect(page.locator('.view-lines')).toContainText('original text');
 await expect(page.locator('.xterm-screen')).toBeVisible();
 await page.getByRole('button',{name:'Review recent output'}).click();
 await expect(page.getByRole('textbox',{name:'Terminal output snapshot'})).toBeFocused();
 await page.getByRole('button',{name:'Close snapshot and return to shell'}).click();
 await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
 expect(errors).toEqual([]);
});
test('production recovery bypasses a failed workbench chunk and preserves scratch',async({page})=>{
 await page.route('**/assets/App-*.js',route=>route.abort());
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'AfterEdit recovery'})).toBeVisible();
 await page.getByLabel('Recovery scratch buffer').fill('Recovered production note');
 await page.goto('/?safe=1');
 await expect(page.getByLabel('Recovery scratch buffer')).toHaveValue('Recovered production note');
 await page.unroute('**/assets/App-*.js');
 await page.getByRole('button',{name:'Retry normal startup'}).click();
 await expect(page.locator('.view-lines')).toContainText('Recovered production note');
});
