import {test,expect} from '@playwright/test';
test('failed workbench import exposes an editable recovery scratch',async({page})=>{
 await page.route('**/src/App.tsx',route=>route.abort());
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'AfterEdit recovery'})).toBeVisible();
 await page.getByLabel('Recovery scratch buffer').fill('Keep this recovery note');
 await page.reload();
 await expect(page.getByLabel('Recovery scratch buffer')).toHaveValue('Keep this recovery note');
});
test('safe startup bypasses workbench modules without clearing preferences',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('editor.preferences.v1',JSON.stringify('{"fontSize":22}')));
 let appLoaded=false;page.on('request',request=>{if(request.url().includes('/src/App.tsx'))appLoaded=true;});
 await page.goto('/?safe=1');
 await expect(page.getByRole('heading',{name:'AfterEdit recovery'})).toBeVisible();
 expect(appLoaded).toBe(false);
 expect(await page.evaluate(()=>localStorage.getItem('editor.preferences.v1'))).toContain('fontSize');
});
test('failed editor import retains editable buffer and surrounding workbench',async({page})=>{
 await page.route('**/src/CodeEditor.tsx',route=>route.abort());
 await page.goto('/');
 await expect(page.getByRole('navigation',{name:'Workbench'})).toBeVisible();
 await page.getByLabel('Recovery text editor').fill('Still editable');
 await expect(page.getByLabel('Recovery text editor')).toHaveValue('Still editable');
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Workspace settings'})).toBeVisible();
});
