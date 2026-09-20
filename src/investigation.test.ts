import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRunMonitor} from './runMonitor';
import {createTestParser} from './testReports';
import {formatInspectDebug,formatInspectRun,prepareFailedTestLaunch} from './investigation';

const record={afteredit:1,kind:'test',name:'broken',fullName:'broken',file:'/repo/test.mjs',line:1,status:'failed',expected:'1',actual:'2',message:'boom'};
const parser=()=>{const p=createTestParser('node');p.push(JSON.stringify(record)+'\n');p.push('{"afteredit":1,"kind":"complete"}\n');return p.finish();};

test('inspect_run lists this project only and omits command output',()=>{
 const monitor=createRunMonitor();
 const other=monitor.start('/other','.','node',['--test']);
 monitor.finish(other,10,{code:1,output:'SECRET_FROM_OTHER_PROJECT'});
 const id=monitor.start('/repo','.','node',['--test'],{taskName:'test',reporter:'node'});
 monitor.event(id,{runId:9,sequence:1,kind:'stdout',text:JSON.stringify(record)+'\n'});
 monitor.finish(id,25,{code:1,output:'AKIA4NPQ2XZJ7KLMWVR3 should never appear',stdout:JSON.stringify(record)+'\n{"afteredit":1,"kind":"complete"}\n'});
 const listing=formatInspectRun(monitor.getSnapshot(),'/repo');
 assert.match(listing,/run \d+ · failed/);
 assert.doesNotMatch(listing,/other|AKIA|SECRET_FROM/);
 const detail=formatInspectRun(monitor.getSnapshot(),'/repo',id);
 assert.match(detail,/"outputOmitted": true/);
 assert.match(detail,/"id": "/); // failed case id present
 assert.doesNotMatch(detail,/AKIA|should never appear/);
 assert.throws(()=>formatInspectRun(monitor.getSnapshot(),'/repo',other),/this project/);
 assert.equal(formatInspectRun(monitor.getSnapshot(),'/empty'),'No monitored runs for this project in this app session.');
});

test('propose_debug_launch reuses failed-test handoff and does not start an adapter',()=>{
 const monitor=createRunMonitor();
 const id=monitor.start('/repo','.','node',['--test'],{taskName:'test',reporter:'node'});
 const report=parser();
 monitor.finish(id,25,{code:1,output:'fail',stdout:JSON.stringify(record)+'\n{"afteredit":1,"kind":"complete"}\n'});
 const run=monitor.getSnapshot().find(item=>item.id===id)!;
 const testCase=report.cases[0];
 const tasks={test:{command:'node',args:['--test','tests/*.mjs'],testReporter:'node' as const,debugConfiguration:'node'}};
 const configs={node:{adapter:{port:4711},request:'launch' as const,configuration:{runtimeArgs:'${testArgs}',type:'pwa-node'}}};
 const prepared=prepareFailedTestLaunch([{...run,report}],'/repo',tasks,configs,id,testCase.id);
 assert.equal(prepared.origin,`Run ${id}: test / broken`);
 assert.equal(prepared.preview.includes('"adapterNotStarted": true'),true);
 assert.equal(prepared.preview.includes('"trustCleared": true'),true);
 assert.deepEqual(prepared.config.configuration.runtimeArgs,['--test','--test-name-pattern=^broken$','/repo/test.mjs']);
 assert.throws(()=>prepareFailedTestLaunch([{...run,report,root:'/other'}],'/repo',tasks,configs,id,testCase.id),/this project/);
 assert.throws(()=>prepareFailedTestLaunch([{...run,report,status:'running'}],'/repo',tasks,configs,id,testCase.id),/finish/);
});

test('inspect_debug reports captured watches and omits live variable dumps',()=>{
 const text=formatInspectDebug({
  phase:'paused',
  stopReason:'breakpoint',
  frame:{name:'main',source:{path:'/repo/main.c'},line:12},
  thread:1,
  watches:['count'],
  values:[{expression:'count',value:'3',type:'int'}],
  snapshots:[{id:1,time:1,context:'x',revision:'abc',location:'/repo/main.c:12',values:[{expression:'count',value:'3'}],variables:'password=supersecret',truncated:true}],
  exception:'panic',
 });
 assert.match(text,/"phase": "paused"/);
 assert.match(text,/"location": "\/repo\/main.c:12"/);
 assert.match(text,/"adapterNotControlled": true/);
 assert.match(text,/"variablesOmitted": true/);
 assert.doesNotMatch(text,/supersecret|password=/);
});
