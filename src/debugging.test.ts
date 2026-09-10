import {test} from 'node:test';
import assert from 'node:assert/strict';
import {debugConfig,expandDebug,restoreBreakpoints,breakpointArguments,configureDebug} from './debugging.ts';
import {resolveConfig} from './workflows.ts';
test('debug configuration validates transport and expands arguments without shell parsing',()=>{
 assert.throws(()=>debugConfig({adapter:{port:0},request:'launch',configuration:{}}));
 assert.throws(()=>debugConfig({adapter:{port:9000,command:'x'},request:'attach',configuration:{}}));
 assert.deepEqual(expandDebug(['${workspaceFolder}/a b','${file}'],'/repo','/repo/main.c'),['/repo/a b','/repo/main.c']);
 assert.throws(()=>expandDebug('${file}','/repo',''));
 const c={adapter:{command:'lldb-dap'},request:'launch',configuration:{program:'a'}};
 assert.deepEqual(resolveConfig([{debug:{app:c}},{debug:{test:c}}]).debug,{app:c,test:c});
});
test('restored breakpoints discard stale adapter identities and unsupported conditions fail explicitly',()=>{
 assert.deepEqual(restoreBreakpoints('[{"path":"/repo/a.c","line":4,"verified":true,"adapterId":3}]'),[{path:'/repo/a.c',line:4,condition:undefined,hitCondition:undefined,logMessage:undefined,enabled:undefined}]);
 assert.throws(()=>breakpointArguments('/repo/a.c',[{path:'/repo/a.c',line:4,condition:'x>1'}],{}),/conditional/);
 assert.equal(breakpointArguments('/repo/a.c',[{path:'/repo/a.c',line:4,enabled:false}],{}).breakpoints.length,0);
});
test('DAP launch does not deadlock while waiting for configurationDone',async()=>{
 const commands:string[]=[];let initialized!:()=>void;const ready=new Promise<void>(resolve=>{initialized=resolve;});let finish!:()=>void;
 const request=async(command:string)=>{commands.push(command);if(command==='initialize')return {supportsConfigurationDoneRequest:true};if(command==='launch'){initialized();await new Promise<void>(resolve=>{finish=resolve;});return {};}if(command==='setBreakpoints')return {breakpoints:[{verified:true}]};if(command==='configurationDone')finish();return {};};
 await configureDebug(request,ready,{adapter:{command:'test'},request:'launch',configuration:{}},[{path:'/repo/a.c',line:4}],[],()=>{},()=>{});
 assert.deepEqual(commands,['initialize','launch','setBreakpoints','configurationDone']);
});
test('a rejected launch is reported even if initialized never arrives',async()=>{
 await assert.rejects(configureDebug(async c=>{if(c==='launch')throw new Error('No program');return {};},new Promise(()=>{}),{adapter:{command:'test'},request:'launch',configuration:{}},[],[],()=>{},()=>{}),/No program/);
});
