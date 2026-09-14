import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRunMonitor, nodeTestSummary, runMonitor } from './runMonitor';
import { runTask, setTaskConfirmer } from './taskRunner';
import RunMonitorPanel from './RunMonitorPanel';
import { mountEnvironment, render, unmount } from './testing/dom';

const footer = '# tests 5\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 1\n# duration_ms 12.34\n';

test('test counts require a complete consistent Node footer', () => {
  assert.deepEqual(nodeTestSummary('TAP version 13\n' + footer), { total: 5, passed: 2, failed: 1, cancelled: 0, skipped: 1, todo: 1 });
  assert.equal(nodeTestSummary(footer.replace('# tests 5', '# tests 6')), undefined);
  assert.equal(nodeTestSummary(footer.replace('# duration_ms 12.34\n', '')), undefined);
  assert.equal(nodeTestSummary('2 passed, 1 failed'), undefined);
  assert.equal(nodeTestSummary(footer + 'another test is still running'), undefined);
  assert.deepEqual(nodeTestSummary(footer.replace(/\n/g, '\r\n')), nodeTestSummary(footer));
});

test('runs correlate concurrent completions and preserve active runs when clearing', () => {
  const monitor = createRunMonitor(2);
  const first = monitor.start('/a', '.', 'node', ['--test']);
  const second = monitor.start('/b', '.', 'cargo', ['test']);
  monitor.finish(second, 20, { error: 'Cannot start cargo' });
  monitor.clear('/a');
  assert.equal(monitor.getSnapshot().find(r => r.id === first)?.status, 'running');
  monitor.finish(first, 30, { code: 1, output: footer });
  assert.equal(monitor.getSnapshot().find(r => r.id === first)?.status, 'failed');
  assert.equal(monitor.getSnapshot().find(r => r.id === second)?.error, 'Cannot start cargo');
  monitor.finish(first, 40, { code: 0, output: '' });
  assert.equal(monitor.getSnapshot().find(r => r.id === first)?.code, 1);
  monitor.clear('/a');
  assert.deepEqual(monitor.getSnapshot().map(r => r.root), ['/b']);
});

test('retention bounds completed output without evicting active tasks', () => {
  const monitor = createRunMonitor(2);
  const active = monitor.start('/a', '.', 'slow', []);
  for (let i = 0; i < 4; i++) {
    const id = monitor.start('/a', '.', 'node', []);
    monitor.finish(id, 1, { code: 0, output: 'x'.repeat(210000) });
  }
  assert.equal(monitor.getSnapshot().length, 3);
  assert.ok(monitor.getSnapshot().some(r => r.id === active));
  assert.equal(monitor.getSnapshot()[0].output.length, 200000);
});

test('shared runner monitors actual results and preserves native failures', async () => {
  const root = '/runner-test';
  mountEnvironment({ task_challenge: null, run_task: { code: 3, output: footer } });
  try {
    const result = await runTask(root, 'src', { command: 'node', args: ['--test'] });
    assert.equal(result.code, 3);
    const record = runMonitor.getSnapshot().find(r => r.root === root)!;
    assert.equal(record.status, 'failed');
    assert.equal(record.tests?.failed, 1);
    assert.equal(record.cwd, 'src');
  } finally { runMonitor.clear(root); await unmount(); }
  mountEnvironment({ task_challenge: null, run_task: () => { throw new Error('Cannot start missing-tool'); } });
  try {
    await assert.rejects(runTask(root, '.', { command: 'missing-tool' }), /Cannot start/);
    assert.match(runMonitor.getSnapshot().find(r => r.root === root)!.error!, /Cannot start/);
  } finally { runMonitor.clear(root); await unmount(); }
});

test('declining a production challenge never records or starts a task', async () => {
  const calls = mountEnvironment({ task_challenge: { action: 'delete', expected: 'production', reason: 'test' } });
  setTaskConfirmer(async () => null);
  try {
    await assert.rejects(runTask('/declined', '.', { command: 'tool' }), /Cancelled/);
    assert.equal(calls.some(c => c.command === 'run_task'), false);
    assert.equal(runMonitor.getSnapshot().some(r => r.root === '/declined'), false);
  } finally { await unmount(); }
});

test('monitor updates mounted UI, filters failures and isolates project history', async () => {
  const root = '/monitor-ui';
  mountEnvironment();
  try {
    const view = await render(RunMonitorPanel, { root });
    assert.match(view.text(), /Run a configured task/);
    await act(async () => {
      const hidden = runMonitor.start('/other-ui', '.', 'private-other-command', []);
      runMonitor.finish(hidden, 1, { code: 0, output: '' });
      const good = runMonitor.start(root, '.', 'successful-command', []);
      runMonitor.finish(good, 500, { code: 0, output: 'ok' });
      const bad = runMonitor.start(root, '.', 'failed-command', ['--test']);
      runMonitor.finish(bad, 250, { code: 1, output: footer });
    });
    assert.doesNotMatch(view.text(), /private-other-command/);
    assert.match(view.text(), /2\/5 passed/);
    assert.match(view.text(), /exit 1/);
    await view.click(view.find('input[type=checkbox]')!);
    assert.doesNotMatch(view.text(), /successful-command/);
    assert.match(view.text(), /failed-command/);
    await view.click(view.all('button').find(b => b.textContent === 'Clear completed runs')!);
    assert.match(view.text(), /Run a configured task/);
    assert.ok(runMonitor.getSnapshot().some(r => r.root === '/other-ui'));
  } finally {
    await unmount();
    runMonitor.clear(root); runMonitor.clear('/other-ui');
  }
});

test('live run events are correlated, deduplicated and retain output on timeout',()=>{
 const monitor=createRunMonitor();const id=monitor.start('/a','.','node',[],{reporter:'node'});
 monitor.event(id,{runId:17,sequence:1,kind:'started',text:''});
 const line=JSON.stringify({afteredit:1,kind:'test',name:'test',status:'running'})+'\n';
 monitor.event(id,{runId:17,sequence:2,kind:'stdout',text:line});monitor.event(id,{runId:17,sequence:2,kind:'stdout',text:'duplicate'});
 assert.equal(monitor.getSnapshot()[0].nativeId,17);assert.equal(monitor.getSnapshot()[0].report?.cases.length,1);assert.doesNotMatch(monitor.getSnapshot()[0].output,/duplicate/);
 monitor.finish(id,1000,{code:-1,output:line,status:'timedOut',runId:17});assert.equal(monitor.getSnapshot()[0].status,'timedOut');assert.equal(monitor.getSnapshot()[0].report?.complete,false);
 monitor.event(id,{runId:17,sequence:3,kind:'stdout',text:'late'});assert.doesNotMatch(monitor.getSnapshot()[0].output,/late/);
});

test('fast task results reconstruct reports when live events arrive after completion',()=>{
 const monitor=createRunMonitor();const id=monitor.start('/a','.','node',[],{reporter:'node'});
 const output=JSON.stringify({afteredit:1,kind:'test',name:'fast',status:'passed'})+'\n'+JSON.stringify({afteredit:1,kind:'complete'})+'\n';
 monitor.finish(id,1,{code:0,output,sequence:4,outputTruncated:false});assert.equal(monitor.getSnapshot()[0].report?.complete,true);assert.equal(monitor.getSnapshot()[0].report?.cases[0].name,'fast');
 const truncated=monitor.start('/a','.','node',[],{reporter:'node'});monitor.event(truncated,{runId:10,sequence:3,kind:'stdout',text:output});monitor.finish(truncated,1,{code:0,output,sequence:4,outputTruncated:true});assert.equal(monitor.getSnapshot()[0].report?.complete,false);assert.match(monitor.getSnapshot()[0].report?.error??'',/missed/);
});

test('stderr warnings never contaminate the completed structured report',()=>{
 const monitor=createRunMonitor(),id=monitor.start('/a','.','node',[],{reporter:'node'});
 const stdout=JSON.stringify({afteredit:1,kind:'test',name:'ok',status:'passed'})+'\n'+JSON.stringify({afteredit:1,kind:'complete'})+'\n';
 monitor.finish(id,1,{code:0,output:'warning on stderr\n'+stdout,stdout,stdoutTruncated:false});assert.equal(monitor.getSnapshot()[0].report?.complete,true);
});

test('revoked rerun permission during confirmation prevents process launch',async()=>{
 let allowed=true;const calls=mountEnvironment({task_challenge:{action:'change',expected:'production',reason:'test'}});
 setTaskConfirmer(async()=>{allowed=false;return 'production';});
 try{await assert.rejects(runTask('/revoked','.',{command:'tool'},{canStart:()=>allowed}),/cancelled before launch/);assert.equal(calls.some(c=>c.command==='run_task'),false);}finally{await unmount();setTaskConfirmer(async()=>null);}
});
