import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run} from './infrastructure-process.mjs';
test('JSON output stays parseable when tools warn on stderr',async()=>{
 const result=await run(process.execPath,['-e','console.error("warning"); console.log(JSON.stringify({issues:[]})); process.exitCode=2'],process.cwd());
 assert.equal(result.code,2);assert.deepEqual(JSON.parse(result.stdout),{issues:[]});assert.match(result.stderr,/warning/);
});
test('missing executable is distinguishable from an installed failing tool',async()=>{
 await assert.rejects(run('/afteredit-missing-tool',[],process.cwd()),{code:'ENOENT'});
 const result=await run(process.execPath,['-e','process.exitCode=1'],process.cwd());assert.equal(result.code,1);
});
test('unbounded output and stalled processes terminate',async()=>{
 await assert.rejects(run(process.execPath,['-e','setInterval(()=>process.stdout.write("x".repeat(2000)),1)'],process.cwd(),{maxBytes:1000}),/output exceeds/);
 await assert.rejects(run(process.execPath,['-e','setInterval(()=>{},1000)'],process.cwd(),{timeout:200}),/timed out/);
});
