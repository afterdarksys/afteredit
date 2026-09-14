import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {invoke} from '@tauri-apps/api/core';
import {runMonitor,type MonitoredRun} from './runMonitor';
import {runTask} from './taskRunner';
import {taskOrder,type Task} from './workflows';
import {failedTestDebug,selectTest} from './testReproduction';
import type {DebugConfig} from './debugging';
import type {TestCase} from './testReports';
import TestResultsPanel from './TestResultsPanel';
import OutputLog from './OutputLog';
export default function RunMonitorPanel({root,tasks={},configured={},allowed=false,onDebug}:{root:string;tasks?:Record<string,Task>;configured?:Record<string,DebugConfig>;allowed?:boolean;onDebug?:(config:DebugConfig,origin:string)=>void}){
 const snapshot=useSyncExternalStore(runMonitor.subscribe,runMonitor.getSnapshot);
 const [now,setNow]=useState(Date.now),[failuresOnly,setFailuresOnly]=useState(false),[attempts,setAttempts]=useState(1),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [review,setReview]=useState<{run:MonitoredRun;steps:{name:string;task:Task}[];config?:DebugConfig;fingerprint:string}>();
 const generation=useRef(0), gate=useRef(allowed), fingerprint=JSON.stringify([root,tasks,configured]);gate.current=allowed;
 const latest=useRef(fingerprint);latest.current=fingerprint;
 const runs=snapshot.filter(run=>run.root===root),active=runs.some(run=>run.status==='running');
 useEffect(()=>{if(!active)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active]);
 useEffect(()=>{setReview(undefined);generation.current++;setBusy(false);return()=>{generation.current++;};},[root]);
 const failures=(run:MonitoredRun)=>!['running','succeeded'].includes(run.status);
 const visible=runs.filter(run=>!failuresOnly||failures(run));
 function prepare(run:MonitoredRun,test?:TestCase,debug=false){try{
  if(!run.taskName||!tasks[run.taskName])throw new Error('This run has no current named workflow task. Rerun it from its originating panel.');
  const task=tasks[run.taskName];
  const selected=test?selectTest(task,test,root):task;
  const steps=taskOrder(tasks,[run.taskName]).map(name=>({name,task:name===run.taskName?selected:tasks[name]}));
  const config=debug&&test?failedTestDebug(task,test,configured,root):undefined;
  setReview({run,steps,config,fingerprint});setError('');
 }catch(e){setError(String(e));}}
 async function execute(){if(!review||!gate.current||review.fingerprint!==latest.current)return;const plan=review,mark=++generation.current;setBusy(true);setError('');
  try{for(let attempt=0;attempt<attempts;attempt++){
   for(const step of plan.steps){if(mark!==generation.current||!gate.current||plan.fingerprint!==latest.current)throw new Error('Run stopped: scope, configuration or trust changed');
    const result=await runTask(root,step.task.cwd??'.',step.task,{taskName:step.name,parentId:plan.run.id,canStart:()=>mark===generation.current&&gate.current&&plan.fingerprint===latest.current});
    if(['cancelled','timedOut','spawnError','error'].includes(result.status??''))throw new Error(result.error??result.status);
    if(result.code!==0&&step.name!==plan.run.taskName)throw new Error('Prerequisite failed; selected test was not run');
   }
  }}catch(e){setError(String(e));}finally{if(mark===generation.current){setBusy(false);setReview(undefined);}}}
 const stop=()=>{generation.current++;setBusy(false);const run=runMonitor.getSnapshot().find(r=>r.root===root&&r.status==='running'&&r.parentId===review?.run.id);if(run?.nativeId!==undefined)void invoke('cancel_task',{runId:run.nativeId}).catch(e=>setError(String(e)));};
 return <section aria-label="Run monitor" className="run-monitor"><h2>Run monitor</h2><p>Live task output and the last 20 completed commands for this app session, filtered by project.</p>
 <p role="status">{runs.filter(r=>r.status==='running').length} active · {runs.filter(r=>r.status==='succeeded').length} succeeded · {runs.filter(failures).length} failed / errors</p>
 <label className="check"><input type="checkbox" checked={failuresOnly} onChange={e=>setFailuresOnly(e.target.checked)}/>Show failures only</label><button disabled={!runs.some(r=>r.status!=='running')} onClick={()=>runMonitor.clear(root)}>Clear completed runs</button>
 <p role="alert">{error}</p>
 {review&&<section aria-label="Run review"><h3>{review.config?'Review failed-test debug launch':'Review rerun'}</h3><p>Current commands are shown below. Previously recorded arguments: {JSON.stringify(review.run.args)}. Dependencies run before each attempt.</p><pre>{JSON.stringify(review.config??review.steps,null,2)}</pre>
 {review.config?<button disabled={!allowed||busy||review.fingerprint!==fingerprint} onClick={()=>{onDebug?.(review.config!,`Run ${review.run.id}: ${review.run.taskName}`);setReview(undefined);}}>Open reviewed debug configuration</button>:<><label>Attempts (1–10)<input type="number" min="1" max="10" value={attempts} onChange={e=>setAttempts(Number(e.target.value))}/></label><button disabled={!allowed||busy||active||review.fingerprint!==fingerprint||!Number.isInteger(attempts)||attempts<1||attempts>10} onClick={()=>void execute()}>Run reviewed selection</button></>}
 {busy?<button onClick={stop}>Stop repeated run</button>:<button onClick={()=>setReview(undefined)}>Dismiss review</button>}{!allowed&&<p>Save project changes and trust the current workflow commands before running.</p>}</section>}
 {!visible.length&&<p>{runs.length?'No runs match this filter.':'Run a configured task to start monitoring.'}</p>}
 {visible.map(run=>{const related=runs.filter(r=>r.parentId===run.id&&r.taskName===run.taskName);return <details key={run.id}><summary>{run.command} · {run.status} · {(Math.max(0,run.durationMs??now-run.startedAt)/1000).toFixed(1)}s{run.code!==undefined?` · exit ${run.code}`:''}</summary><p>Started {new Date(run.startedAt).toLocaleString()} · cwd: {run.cwd} · run {run.nativeId??run.id}</p><pre aria-label="Command arguments">{JSON.stringify([run.command,...run.args],null,2)}</pre>
 {run.parentId!==undefined&&<p>Attempt linked to run {run.parentId}</p>}{related.length>0&&<p>Repeated attempts: {related.map(r=>`${r.status} (${((r.durationMs??0)/1000).toFixed(2)}s)`).join(' · ')}. {new Set(related.map(r=>r.status)).size>1?'Outcomes differ; inspect each attempt.':''}</p>}
 {run.tests&&<p>Node test report: {run.tests.passed}/{run.tests.total} passed · {run.tests.failed} failed · {run.tests.cancelled} cancelled · {run.tests.skipped} skipped · {run.tests.todo} todo</p>}
 {run.error&&<p>{run.error}</p>}{run.status==='running'?<button disabled={run.nativeId===undefined} onClick={()=>void invoke('cancel_task',{runId:run.nativeId}).catch(e=>setError(String(e)))}>Cancel this run</button>:<button disabled={!run.taskName||busy} onClick={()=>prepare(run)}>Review rerun / repeat</button>}
 <TestResultsPanel run={run} onSelect={prepare}/><OutputLog label={`Run ${run.id} output`}>{run.output||'No captured output yet.'}</OutputLog></details>;})}</section>;
}
