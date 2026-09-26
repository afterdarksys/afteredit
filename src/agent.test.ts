import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAction,relativePath,replaceUnique,rollbackChanges} from './agent.ts';
test('agent actions cannot select arbitrary commands or escape projects',()=>{
 for(const path of ['../outside','/etc/passwd','C:\\secret','src/../../outside','a\0b'])assert.throws(()=>relativePath(path));
 assert.throws(()=>parseAction('{"type":"run_task","task":"shell"}',['test']));
 assert.deepEqual(parseAction('{"type":"read_file","path":"src/main.go"}',[]),{type:'read_file',path:'src/main.go'});
});
test('investigation probes parse as reviewed actions and reject debugger control',()=>{
 assert.deepEqual(parseAction('{"type":"inspect_run"}',[]),{type:'inspect_run'});
 assert.deepEqual(parseAction('{"type":"inspect_run","runId":3}',[]),{type:'inspect_run',runId:3});
 assert.deepEqual(parseAction('{"type":"inspect_debug"}',[]),{type:'inspect_debug'});
 assert.deepEqual(parseAction('{"type":"propose_debug_launch","runId":3,"testId":"case-1"}',[]),{type:'propose_debug_launch',runId:3,testId:'case-1'});
 assert.throws(()=>parseAction('{"type":"inspect_run","runId":0}',[]));
 assert.throws(()=>parseAction('{"type":"inspect_run","runId":1.5}',[]));
 assert.throws(()=>parseAction('{"type":"propose_debug_launch","runId":3,"testId":""}',[]));
 assert.throws(()=>parseAction('{"type":"continue"}',[]));
 assert.throws(()=>parseAction('{"type":"next"}',[]));
 assert.throws(()=>parseAction('{"type":"evaluate","expression":"x"}',[]));
 assert.deepEqual(parseAction('{"type":"list_directory","path":"."}',[]),{type:'list_directory',path:'.'});
 assert.deepEqual(parseAction('{"type":"search_text","query":"fn main"}',[]),{type:'search_text',query:'fn main'});
 assert.deepEqual(parseAction('{"type":"search_symbols","query":"PaymentService"}',[]),{type:'search_symbols',query:'PaymentService'});
 assert.throws(()=>parseAction('{"type":"search_text","query":""}',[]));
 assert.throws(()=>parseAction('{"type":"list_directory","path":"../secret"}',[]));
});
test('rollback restores a run only while later edits still match',()=>{
 const changes=[{path:'a.ts',before:'one',after:'two'},{path:'a.ts',before:'two',after:'three'}];
 assert.deepEqual(rollbackChanges(changes,{ 'a.ts':'three' }).values,{ 'a.ts':'one' });
 const edited=rollbackChanges(changes,{ 'a.ts':'mine' });
 assert.deepEqual(edited.values,{});
 assert.deepEqual(edited.skipped,['a.ts']);
});
test('reviewed edits reject stale and ambiguous source blocks',()=>{
 assert.equal(replaceUnique('abc def','def','ghi'),'abc ghi');
 assert.throws(()=>replaceUnique('abc','missing','x'));
 assert.throws(()=>replaceUnique('aaa','aa','x'));
 assert.throws(()=>replaceUnique('abc','','x'));
});
