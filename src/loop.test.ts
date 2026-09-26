import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyPlanEvidence,formatPlan,localPage,parseFindings,parsePlanSteps,planFromLines,unfinished,worktreeName} from './loop.ts';
test('a plan is edited as lines and evidence closes only that step',()=>{
 const steps=parsePlanSteps([{id:'read',text:'Read the diff'},{id:'check',text:'Run the test'}]);
 assert.equal(formatPlan(steps),'read: Read the diff\ncheck: Run the test');
 const edited=planFromLines('read: Read the diff\ncheck: Run the named test');
 assert.equal(edited[1].text,'Run the named test');
 const done=applyPlanEvidence(edited,'read','diff showed the failure');
 assert.equal(done[0].done,true);
 assert.deepEqual(unfinished(done),['check']);
 assert.throws(()=>planFromLines('No colon'));
 assert.throws(()=>parsePlanSteps([]));
 assert.throws(()=>applyPlanEvidence(edited,'missing','note'));
});
test('findings stay inside the project and pages stay on loopback',()=>{
 assert.equal(parseFindings([{path:'src/a.ts',line:4,summary:'null check is missing'}])[0].path,'src/a.ts');
 assert.throws(()=>parseFindings([{path:'../x',line:1,summary:'no'}]));
 assert.equal(localPage('http://127.0.0.1:3000/app'),'http://127.0.0.1:3000/app');
 assert.throws(()=>localPage('https://example.com/'));
 assert.throws(()=>localPage('http://user:pass@127.0.0.1/'));
 assert.equal(worktreeName('probe'),'probe');
 assert.throws(()=>worktreeName('../x'));
});
