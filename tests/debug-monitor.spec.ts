import {test,expect} from '@playwright/test';
import {nativeHarness} from './nativeHarness';

test('structured failed tests flow through reviewed reruns and debug configuration',async({page})=>{
 await nativeHarness(page);
 await page.addInitScript(()=>{
  const w=window as any,original=w.__TAURI_INTERNALS__.invoke;let next=100;
  w.__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
   if(command==='project_config')return [{path:'/project/.afteredit.json',value:{tasks:{test:{command:'node',args:['--test','note.txt'],testReporter:'node',debugConfiguration:'node'}},debug:{node:{adapter:{port:4711},request:'launch',configuration:{type:'pwa-node',runtimeArgs:'${testArgs}',cwd:'${workspaceFolder}'}}}}}];
   if(command==='run_task'){
    w.testCalls.push({command,args});const runId=next++,requestId=args.requestId;
    w.testEmit('task:event',{runId,requestId,sequence:1,kind:'started',text:''});
    const output=JSON.stringify({afteredit:1,kind:'test',name:'broken',fullName:'broken',file:'/project/note.txt',line:1,status:'failed',expected:'1',actual:'2'})+'\n'+JSON.stringify({afteredit:1,kind:'complete'})+'\n';
    w.testEmit('task:event',{runId,requestId,sequence:2,kind:'stdout',text:output});
    return {code:1,status:'failed',output,runId,durationMs:123};
   }
   return original(command,args);
  };
 });
 await page.goto('/');await page.getByRole('button',{name:'Build workflows',exact:true}).click();
 await page.getByLabel('I trust the commands shown for this project scope.').check();await page.getByRole('button',{name:'Run',exact:true}).click();
 const monitor=page.getByRole('region',{name:'Run monitor',exact:true});await expect(monitor.locator('summary').filter({hasText:'node · failed'})).toHaveCount(1);
 await monitor.locator('summary').filter({hasText:'node · failed'}).click();await expect(monitor).toContainText('Report complete');
 await monitor.locator('summary').filter({hasText:'broken · failed'}).click();await expect(monitor.getByRole('heading',{name:'Expected',exact:true})).toBeVisible();
 await monitor.getByRole('button',{name:'Review test rerun',exact:true}).click();
 await expect(page.getByRole('region',{name:'Run review'})).toContainText('--test-name-pattern=^broken$');
 await page.getByRole('button',{name:'Run reviewed selection'}).click();
 await expect(monitor.locator('summary').filter({hasText:'node · failed'})).toHaveCount(2);
 const runs=await page.evaluate(()=>(window as any).testCalls.filter((c:any)=>c.command==='run_task'));expect(runs[1].args.task.args).toContain('/project/note.txt');
 await monitor.getByRole('button',{name:'Review test debug launch'}).first().click();await page.getByRole('button',{name:'Open reviewed debug configuration'}).click();
 await expect(page.getByLabel('Debug configuration JSON')).toContainText('--test-name-pattern=^broken$');
 await expect(page.getByRole('button',{name:'Start',exact:true})).toBeDisabled();
});

test('debugger timeline watches snapshots and optional inspection controls work together',async({page})=>{
 await nativeHarness(page);
 await page.addInitScript(()=>{
  const w=window as any,original=w.__TAURI_INTERNALS__.invoke;let value=1;
  const stop=()=>setTimeout(()=>w.testEmit('dap:event',{session:42,message:{event:'stopped',body:{reason:'breakpoint',threadId:7}}}),20);
  w.__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
   if(command==='dap_start')return 42;
   if(command==='dap_stop')return;
   if(command==='dap_request'){
    w.testCalls.push({command,args});
    switch(args.command){
     case 'initialize':return {supportsConfigurationDoneRequest:true,supportsDataBreakpoints:true,supportsExceptionInfoRequest:true,supportsReadMemoryRequest:true,supportsDisassembleRequest:true,supportsStepBack:true};
     case 'launch':w.testEmit('dap:event',{session:42,message:{event:'initialized',body:{}}});return {};
     case 'configurationDone':stop();return {};
     case 'threads':return {threads:[{id:7,name:'main'}]};
     case 'stackTrace':return {stackFrames:[{id:11,name:'checkout',source:{path:'/project/note.txt'},line:1}]};
     case 'scopes':return {scopes:[{name:'Locals',variablesReference:10}]};
     case 'variables':return {variables:[{name:'value',value:String(value),variablesReference:0}]};
     case 'evaluate':return {result:String(value),type:'number'};
     case 'next':case 'stepBack':case 'reverseContinue':value++;stop();return {};
     case 'exceptionInfo':return {exceptionId:'ExampleError',description:'fixture exception',breakMode:'always'};
     case 'dataBreakpointInfo':return {dataId:'value-id',description:'value',accessTypes:['write']};
     case 'setDataBreakpoints':return {breakpoints:args.arguments.breakpoints.map(()=>({verified:true}))};
     case 'readMemory':return {address:'0x100',data:'AQIDBA==',unreadableBytes:0};
     case 'disassemble':return {instructions:[{address:'0x100',instruction:'mov eax, 1'}]};
     default:return {};
    }
   }
   return original(command,args);
  };
 });
 await page.goto('/');await page.getByRole('button',{name:'Run and debug',exact:true}).click();
 await page.getByLabel('Trust and run this adapter and target').check();await page.getByRole('button',{name:'Start',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Run and debug · paused'})).toBeVisible();
 await page.getByLabel('Watch expression', {exact:true}).fill('value');await page.getByRole('button',{name:'Add watch',exact:true}).click();
 await page.getByRole('button',{name:'Refresh watches and capture snapshot'}).click();await expect(page.getByLabel('After snapshot').locator('option')).toHaveCount(2);
 await page.getByRole('button',{name:'Step over',exact:true}).click();await expect(page.getByRole('heading',{name:'Run and debug · paused'})).toBeVisible();
 await page.getByRole('button',{name:'Refresh watches and capture snapshot'}).click();await expect(page.getByLabel('After snapshot').locator('option')).toHaveCount(3);
 await page.getByLabel('Before snapshot').selectOption('1');await page.getByLabel('After snapshot').selectOption('2');await expect(page.getByText('1 → 2',{exact:false})).toBeVisible();
 await page.locator('summary').filter({hasText:/^Locals$/}).click();await page.getByRole('button',{name:'Load / refresh values',exact:true}).click();await page.getByRole('button',{name:'Break on write value'}).click();
 await page.locator('summary').filter({hasText:/^Data breakpoints$/}).click();await expect(page.getByText('value · Verified')).toBeVisible();
 await page.locator('summary').filter({hasText:/^Exception investigation$/}).click();await page.getByRole('button',{name:'Load exception details'}).click();await expect(page.getByText(/fixture exception/)).toBeVisible();
 await page.locator('summary').filter({hasText:/^Memory and disassembly$/}).click();await page.getByLabel('Memory / instruction reference').fill('0x100');await page.getByRole('button',{name:'Read memory',exact:true}).click();await expect(page.getByText(/AQIDBA/)).toBeVisible();await page.getByRole('button',{name:'Disassemble 100 instructions'}).click();await expect(page.getByText(/mov eax, 1/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Step back',exact:true})).toBeEnabled();
 await page.locator('summary').filter({hasText:/^Debugger timeline/}).click();await expect(page.getByText(/request readMemory · ok/)).toBeVisible();
 await page.locator('summary').filter({hasText:/^Diagnostic export$/}).click();await page.getByLabel('timeline',{exact:true}).check();await page.getByRole('button',{name:'Prepare export preview'}).click();await expect(page.getByLabel('Diagnostic export preview')).toContainText('readMemory');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download reviewed JSON'}).click();expect((await download).suggestedFilename()).toBe('afteredit-diagnostics.json');
});
