import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAction,relativePath,replaceUnique} from './agent.ts';
test('agent actions cannot select arbitrary commands or escape projects',()=>{
 for(const path of ['../outside','/etc/passwd','C:\\secret','src/../../outside','a\0b'])assert.throws(()=>relativePath(path));
 assert.throws(()=>parseAction('{"type":"run_task","task":"shell"}',['test']));
 assert.deepEqual(parseAction('{"type":"read_file","path":"src/main.go"}',[]),{type:'read_file',path:'src/main.go'});
});
test('reviewed edits reject stale and ambiguous source blocks',()=>{
 assert.equal(replaceUnique('abc def','def','ghi'),'abc ghi');
 assert.throws(()=>replaceUnique('abc','missing','x'));
 assert.throws(()=>replaceUnique('aaa','aa','x'));
 assert.throws(()=>replaceUnique('abc','','x'));
});
