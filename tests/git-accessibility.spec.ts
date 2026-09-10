import {test,expect} from '@playwright/test';
import {nativeHarness} from './nativeHarness';
test('Git actions identify their file and move focus into the requested diff',async({page})=>{
 await nativeHarness(page);await page.goto('/');
 await page.getByRole('button',{name:'Source control',exact:true}).click();
 await expect(page.getByRole('button',{name:'Stage file: note.txt',exact:true})).toBeVisible();
 const review=page.getByRole('button',{name:'Working diff: note.txt',exact:true});
 await review.focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'Working tree: note.txt',exact:true})).toBeFocused();
 await page.keyboard.press('Tab');
 await expect(page.getByLabel('Working tree: note.txt diff',{exact:true})).toBeFocused();
 await expect(page.getByLabel('Working tree: note.txt diff',{exact:true})).toContainText('+ changed text');
});
