import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, resolveConfig, taskOrder, presets } from './workflows.ts';
test('nested configuration merges tasks and editor, replaces rules', () => {
  const c = resolveConfig([{editor:{fontSize:16}, tasks:{build:{command:'go',args:['build']}}, rules:[{event:'save',pattern:'**/*.go',tasks:['build']}]}, {editor:{tabSize:4},tasks:{test:{command:'go',args:['test'],dependsOn:['build']}},rules:[]}]);
  assert.equal(c.editor.fontSize,16); assert.equal(c.editor.tabSize,4); assert.deepEqual(c.rules,[]);
  assert.deepEqual(taskOrder(c.tasks,['test','build']),['build','test']);
});
test('invalid settings, missing tasks and dependency cycles fail closed', () => {
  for (const layer of [null, {editor:{fontSize:0}}, {editor:{tabSize:NaN}}, {tasks:{build:{command:'go',args:'build'}}}, {tasks:{build:{command:'go',args:[],dependsOn:['missing']}}}, {tasks:{build:{command:'go',args:[],dependsOn:['build']}}}, {rules:[{event:'save',pattern:'*',tasks:['unknown']}]}]) assert.throws(() => resolveConfig([layer]));
});
test('save globs match root and nested paths without regex injection', () => {
  assert.ok(matches('**/*.go','main.go')); assert.ok(matches('**/*.go','src/main.go'));
  assert.ok(!matches('*.go','src/main.go')); assert.ok(!matches('**/*.go','mainXgo'));
  assert.ok(matches('src/?.c','src/a.c')); assert.ok(matches('[test].js','[test].js'));
});
test('every build environment has a valid dependency graph', () => {
  for (const tasks of Object.values(presets)) assert.doesNotThrow(() => resolveConfig([{tasks}]));
});
import { expandTask, matchingRules } from './workflows.ts';
test('named workflows validate dependencies and exclusions suppress rules',()=>{
 const c=resolveConfig([{tasks:{test:{command:'go',args:['test']}},workflows:{ci:['test']},rules:[{event:'save',pattern:'**/*.go',exclude:['vendor/**'],tasks:['test']}]}]);
 assert.equal(matchingRules(c,'save','vendor/x.go').length,0);assert.equal(matchingRules(c,'save','main.go').length,1);
 assert.throws(()=>resolveConfig([{workflows:{ci:['missing']}}]));
});
test('task variables remain literal argv and timeout settings are validated',()=>{
 const task=expandTask({command:'echo',args:['${file}','${relativeFile}'],env:{SOURCE:'${fileDir}'}},{project:'/repo',file:'/repo/a $(whoami).go'});
 assert.deepEqual(task.args,['/repo/a $(whoami).go','a $(whoami).go']);
 assert.throws(()=>expandTask({command:'echo',args:['${unknown}']},{project:'/repo',file:''}));
 assert.throws(()=>resolveConfig([{tasks:{test:{command:'go',args:[],timeoutSeconds:0}}}]));
});
