import test from 'node:test';
import assert from 'node:assert/strict';
import {createDebugJournal,compareSnapshots,memoryArguments,withDeadline,type PauseSnapshot} from './debugInspection';
test('timeline records errors and ignores old request completions after reset',async()=>{
 const journal=createDebugJournal();let resolve!:(v:number)=>void;const request=journal.request('evaluate',()=>new Promise<number>(r=>resolve=r));assert.equal(journal.getSnapshot()[0].state,'pending');journal.reset();journal.event('stopped');resolve(42);await request;assert.equal(journal.getSnapshot().length,1);assert.equal(journal.getSnapshot()[0].kind,'event');await assert.rejects(journal.request('readMemory',async()=>{throw Error('unsupported');}));assert.equal(journal.getSnapshot()[1].state,'error');for(let i=0;i<600;i++)journal.event('output');assert.equal(journal.getSnapshot().length,500);
});
test('snapshot comparisons reject mismatched contexts and distinguish missing and error values',()=>{
 const a:PauseSnapshot={id:1,time:0,context:'frame',revision:'sha',location:'a:1',variables:'{}',truncated:false,values:[{expression:'x',value:'1'}]};
 const b={...a,id:2,values:[{expression:'x',value:'2'},{expression:'y',error:'out of scope'}]};assert.equal(compareSnapshots(a,b)![0].changed,true);assert.equal(compareSnapshots(a,b)![1].before,'Not captured');assert.equal(compareSnapshots(a,{...b,revision:'different'}),undefined);assert.equal(compareSnapshots(a,{...b,context:'another thread'}),undefined);
});
test('inspection limits bound memory reads and hung requests',async()=>{assert.throws(()=>memoryArguments('0x1',4097));assert.throws(()=>memoryArguments('',1));assert.equal(memoryArguments('0x1',64).count,64);await assert.rejects(withDeadline(new Promise(()=>{}),5),/timed out/);});
