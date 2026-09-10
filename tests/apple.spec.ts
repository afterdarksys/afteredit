import {test,expect,type Page} from '@playwright/test';
import {nativeHarness} from './nativeHarness';
const device='12345678-1234-1234-1234-123456789ABC';
async function appleHarness(page:Page){
 await nativeHarness(page);await page.addInitScript(()=>{
  const w=window as any,original=w.__TAURI_INTERNALS__.invoke;
  w.appleExit=0;w.appleExport='{"method":"debugging","destination":"export"}';
  w.__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
   if(command.startsWith('apple_')||command==='run_task'){
    w.testCalls.push({command,args});
    if(command==='apple_toolchain')return [{name:'Xcode',available:true,detail:'Xcode fixture'}];
    if(command==='apple_projects')return ['Smoke.xcodeproj','Library/Package.swift'];
    if(command==='apple_open')return;
    if(command==='apple_query'){
     if(args.query.kind==='metadata')return JSON.stringify({project:{schemes:['Smoke'],targets:['Smoke'],configurations:['Debug','Release']}});
     if(args.query.kind==='destinations')return 'Available destinations:\n{ platform:macOS, id:MAC, name:My Mac }';
     if(args.query.kind==='simulators')return JSON.stringify({devices:{iOS:[{udid:'12345678-1234-1234-1234-123456789ABC',name:'iPhone fixture',state:'Shutdown',isAvailable:true}]}});
     if(args.query.kind==='devices')return '{"result":{"devices":[]}}';
     if(args.query.kind==='export-options')return w.appleExport;
     if(args.query.kind==='results')return '{"passedTests":1,"failedTests":0}';
    }
    if(command==='run_task')return {code:args.task.command==='/bin/mkdir'?0:w.appleExit,output:args.task.command==='/bin/mkdir'?'':w.appleExit?'/project/note.txt:3:7: error: Swift fixture failure\n':'Apple fixture succeeded\n'};
   }
   return original(command,args);
  };
 });
 await page.goto('/');await page.getByRole('button',{name:'Apple development',exact:true}).click();
 await page.getByRole('button',{name:'Check Xcode and discover projects'}).click();
 await page.getByRole('combobox',{name:'Apple project',exact:true}).selectOption('Smoke.xcodeproj');
 await page.getByLabel('Trust this project’s Apple tool commands').check();
 await page.getByRole('button',{name:'Load schemes and targets'}).click();
}
test('Apple command review tracks selection and executes explicit test destination',async({page})=>{
 await appleHarness(page);await page.getByRole('button',{name:'Load destinations'}).click();
 await page.getByRole('combobox',{name:'Destination',exact:true}).selectOption('platform=macOS,id=MAC');
 await page.getByLabel('Trust this project’s Apple tool commands').check();
 await page.getByRole('button',{name:'Prepare tests',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Command review'})).toBeFocused();
 await page.getByRole('combobox',{name:'Build configuration',exact:true}).fill('Release');
 await expect(page.getByRole('region',{name:'Apple command review'})).toHaveCount(0);
 await page.getByLabel('Trust this project’s Apple tool commands').check();
 await page.getByRole('button',{name:'Prepare tests',exact:true}).click();
 await page.getByRole('button',{name:'Run reviewed Apple commands'}).click();
 await expect(page.getByText('Apple action completed.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Read test results'}).click();
 await expect(page.getByLabel('Apple test results')).toContainText('passedTests');
 const call=await page.evaluate(()=>(window as any).testCalls.find((c:any)=>c.command==='run_task'&&c.args.task.command==='/usr/bin/xcodebuild'));
 expect(call.args.task.args).toContain('platform=macOS,id=MAC');expect(call.args.task.args).toContain('Release');
});
test('failed Apple builds retain output and navigate source diagnostics',async({page})=>{
 await appleHarness(page);await page.evaluate(()=>{(window as any).appleExit=65;});
 await page.getByRole('button',{name:'Prepare build',exact:true}).click();await page.getByRole('button',{name:'Run reviewed Apple commands'}).click();
 await expect(page.getByText(/Apple command exited 65\. See output\./)).toBeVisible();
 await page.getByRole('button',{name:/error: \/project\/note.txt:3/}).click();
 await expect(page.locator('.view-lines')).toContainText('original text');
});
test('simulator commands name a device and missing physical devices are explicit',async({page})=>{
 await appleHarness(page);await page.getByRole('button',{name:'Refresh simulators'}).click();
 await page.getByRole('combobox',{name:'Simulator',exact:true}).selectOption(device);
 await page.getByRole('button',{name:'Prepare simulator boot'}).click();
 await expect(page.getByRole('region',{name:'Apple command review'})).toContainText(device);
 await page.getByRole('button',{name:'Refresh connected devices'}).click();
 await expect(page.getByText('No connected devices. Pair and enable Developer Mode using Xcode.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Prepare device install'})).toBeDisabled();
});
test('an export refuses options changed since review',async({page})=>{
 await appleHarness(page);await page.getByRole('button',{name:'Prepare export',exact:true}).click();
 await expect(page.getByLabel('Reviewed export options')).toContainText('debugging');
 await page.evaluate(()=>{(window as any).appleExport='{"method":"release-testing","destination":"export"}';});
 await page.getByRole('button',{name:'Run reviewed Apple commands'}).click();
 await expect(page.getByText(/Export options changed\. Prepare and review the export again\./)).toBeVisible();
 expect(await page.evaluate(()=>(window as any).testCalls.filter((c:any)=>c.command==='run_task').length)).toBe(0);
});
test('Xcode handoff and nested Swift package language context preserve paths',async({page})=>{
 await appleHarness(page);await page.getByRole('button',{name:'Open current file for previews or Interface Builder'}).click();
 const call=await page.evaluate(()=>(window as any).testCalls.find((c:any)=>c.command==='apple_open'));
 expect(call.args).toEqual({root:'/project',path:'note.txt',project:'Smoke.xcodeproj',line:1});
 await page.getByRole('combobox',{name:'Apple project',exact:true}).selectOption('Library/Package.swift');
 await page.getByRole('button',{name:'Configure SourceKit-LSP'}).click();
 await expect(page.getByRole('combobox',{name:'Language',exact:true})).toHaveValue('swift');
 await expect(page.getByLabel('Server command, arguments, environment and initializationOptions')).toContainText('sourcekit-lsp');
});
