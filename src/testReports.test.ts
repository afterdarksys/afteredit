import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestParser,importJUnit,sourceInProject} from './testReports';
import {selectTest,failedTestDebug} from './testReproduction';
import {mountEnvironment,unmount} from './testing/dom';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const record={afteredit:1,kind:'test',name:'broken',fullName:'broken',file:'/repo/test.mjs',line:1,status:'failed',expected:'1',actual:'2'};
test('streamed reports handle split lines, deduplication, malformed records and crashes',()=>{
 const parser=createTestParser('node'),line=JSON.stringify(record)+'\n';
 parser.push(line.slice(0,20));assert.equal(parser.push(line.slice(20)).cases.length,1);
 parser.push(line);parser.push('{"afteredit":1,"kind":"complete"}\n');assert.equal(parser.finish().cases.length,1);assert.equal(parser.finish().complete,true);
 const incomplete=createTestParser('node');incomplete.push(line.slice(0,10));assert.equal(incomplete.finish().complete,false);
 const oversized=createTestParser('node');oversized.push('x'.repeat(66000)+'\n');assert.match(oversized.finish().error!,/64 KiB/);
});
test('Go package completion and JUnit import keep failures and skip states',async()=>{
 const parser=createTestParser('go');parser.push('{"Action":"run","Package":"example","Test":"TestThing"}\n');parser.push('{"Action":"fail","Package":"example","Test":"TestThing","Elapsed":0.2}\n');assert.equal(parser.finish().complete,false);parser.push('{"Action":"fail","Package":"example"}\n');assert.equal(parser.finish().complete,true);assert.equal(parser.finish().cases[0].durationMs,200);
 mountEnvironment();try{const r=importJUnit('<testsuite><testcase name="bad" file="x.ts" line="3"><failure message="oops">expected 1</failure></testcase><testcase name="skip"><skipped/></testcase></testsuite>');assert.equal(r.cases[0].status,'failed');assert.equal(r.cases[1].status,'skipped');assert.throws(()=>importJUnit('<!DOCTYPE x><testsuite/>'));assert.throws(()=>importJUnit('<invalid>'));}finally{await unmount();}
});
test('test selection preserves loaders and constrains file paths',()=>{
 const task={command:'node',args:['--import','./loader.mjs','--test','tests/*.mjs'],testReporter:'node' as const};
 const testCase={...record,id:'1',status:'failed' as const};
 assert.deepEqual(selectTest(task,testCase,'/repo').args,['--import','./loader.mjs','--test','--test-name-pattern=^broken$','/repo/test.mjs']);
 assert.equal(sourceInProject('/repo','.','../../outside'),undefined);
 assert.equal(sourceInProject('/repo','tests','a.mjs'),'/repo/tests/a.mjs');
 const configs={node:{adapter:{port:4711},request:'launch' as const,configuration:{runtimeArgs:'${testArgs}',type:'pwa-node'}}};
 assert.deepEqual(failedTestDebug({...task,debugConfiguration:'node'},testCase,configs,'/repo').configuration.runtimeArgs,selectTest(task,testCase,'/repo').args);
 assert.throws(()=>failedTestDebug(task,testCase,configs,'/repo'),/debugConfiguration/);
});
test('real Node reporter captures assertion diffs and reruns a selected nested test',()=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const root=realpathSync(mkdtempSync(join(tmpdir(),'afteredit-reporter-')));try{
 const file=join(root,'fixture.mjs');writeFileSync(file,"import {test,describe} from 'node:test';import assert from 'node:assert/strict';describe('group',()=>{test('broken',()=>assert.equal(2,1));test('good',()=>{});});");
 const reporter=resolve('scripts/node-test-reporter.mjs');const result=spawnSync(process.execPath,['--test',`--test-reporter=${reporter}`,file],{encoding:'utf8',timeout:15000,env});assert.equal(result.status,1,result.stderr);
 const parser=createTestParser('node');parser.push(result.stdout);const report=parser.finish();assert.equal(report.complete,true);const failed=report.cases.find(c=>c.name==='broken')!;assert.equal(failed.actual,'2');assert.equal(failed.expected,'1');
 const task={command:process.execPath,args:['--test',file],testReporter:'node' as const};const selected=selectTest(task,failed,root);
 const rerun=spawnSync(process.execPath,[`--test-reporter=${reporter}`,...selected.args],{encoding:'utf8',timeout:15000,env});assert.equal(rerun.status,1,rerun.stderr);const p=createTestParser('node');p.push(rerun.stdout);assert.ok(p.finish().cases.some(c=>c.name==='broken'&&c.status==='failed'));assert.ok(!p.finish().cases.some(c=>c.name==='good'&&c.status==='passed'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
