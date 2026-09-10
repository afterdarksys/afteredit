import {useEffect,useRef,useState} from 'react';
import {agentInstructions,parseAction,type AgentAction} from './agent';
import {taskOrder,type Task} from './workflows';
export type RunBudget={id:string;maxRequests:number;maxUnits:number};
type Run={budget:RunBudget;steps:number;goal:string;context:string;transcript:string;stopped:boolean;autoRead:boolean;ask:Props['ask'];read:Props['onRead'];edit:Props['onEdit'];task:Props['onTask'];tasks:Record<string,Task>};
type Props={root:string;context:string;tasks:Record<string,Task>;ask:(prompt:string,context:string,budget:RunBudget)=>Promise<string>;onRead:(path:string)=>Promise<string>;onEdit:(path:string,oldText:string,newText:string)=>Promise<string>;onTask:(name:string)=>Promise<string>;onStopTask:()=>void;onSaveEdits:()=>Promise<void>};
export default function AgentPanel(props:Props){
 const [goal,setGoal]=useState(''),[maxSteps,setMaxSteps]=useState(8),[maxUnits,setMaxUnits]=useState(50000),[autoRead,setAutoRead]=useState(false);
 const [busy,setBusy]=useState(false),[active,setActive]=useState(false),[status,setStatus]=useState(''),[log,setLog]=useState('');
 const [pending,setPending]=useState<{run:Run;action:AgentAction}|null>(null);const current=useRef<Run|null>(null),taskRunning=useRef(false);const stopTask=useRef(props.onStopTask);stopTask.current=props.onStopTask;
 const stop=()=>{if(current.current)current.current.stopped=true;setPending(null);setActive(false);setStatus('Stopped; an in-flight provider request may still finish and remains charged.');if(taskRunning.current)stopTask.current();};
 useEffect(()=>()=>{if(current.current)current.current.stopped=true;if(taskRunning.current)stopTask.current();},[props.root]);
 const live=(run:Run)=>current.current===run&&!run.stopped;
 const note=(run:Run,text:string)=>{run.transcript=(run.transcript+'\n'+text).slice(-100000);if(live(run))setLog(run.transcript);};
 async function next(run:Run){
  if(!live(run))return;
  if(run.steps>=run.budget.maxRequests){setStatus('Run step limit reached.');setActive(false);return;}
  run.steps++;setBusy(true);setStatus(`Model step ${run.steps}/${run.budget.maxRequests}`);
  try{
   const text=await run.ask(`${agentInstructions}\nConfigured tasks: ${JSON.stringify(Object.keys(run.tasks))}\nGoal: ${run.goal}\nObservations:\n${run.transcript}`,run.context,run.budget);
   if(!live(run))return;
   const action=parseAction(text,Object.keys(run.tasks));
   if(action.type==='finish'){note(run,action.message);setStatus('Agent finished');setActive(false);return;}
   setBusy(false);
   if(action.type==='read_file'&&run.autoRead){await perform(run,action);return;}
   setPending({run,action});setStatus('Review the proposed action below.');
  }catch(e){if(live(run)){setStatus(String(e));setActive(false);run.stopped=true;}}finally{if(current.current===run)setBusy(false);}
 }
 async function perform(run:Run,action:AgentAction){
  if(!live(run))return;setPending(null);setBusy(true);
  try{
   let observation='';
   if(action.type==='read_file')observation=`File ${action.path}:\n${(await run.read(action.path)).slice(0,60000)}\n[File context limited to 60,000 characters]`;
   if(action.type==='edit_file')observation=await run.edit(action.path,action.oldText,action.newText);
   if(action.type==='run_task'){taskRunning.current=true;try{observation=await run.task(action.task);}finally{taskRunning.current=false;}}
   note(run,`${JSON.stringify(action)}\nTool observation: ${observation}`);
  }catch(e){note(run,`Tool failed: ${String(e)}`);}finally{if(current.current===run)setBusy(false);}
  if(live(run))await next(run);
 }
 function start(){const run:Run={budget:{id:crypto.randomUUID(),maxRequests:maxSteps,maxUnits},steps:0,goal,context:props.context.slice(0,60000),transcript:'',stopped:false,autoRead,ask:props.ask,read:props.onRead,edit:props.onEdit,task:props.onTask,tasks:props.tasks};current.current=run;setLog('');setPending(null);setActive(true);void next(run);}
 return <section><h2>Agent run</h2><p>The agent can read project files, propose exact edits to unsaved buffers, and run configured tasks. Edits and commands require review. Save approved buffers before approving builds that depend on them.</p>
 <label>Goal<textarea rows={3} value={goal} disabled={active} onChange={e=>setGoal(e.target.value)}/></label><div className="field-row"><label>Maximum model steps<input type="number" min="1" max="100" value={maxSteps} disabled={active} onChange={e=>setMaxSteps(Number(e.target.value))}/></label><label>Maximum run reservation units<input type="number" min="1" value={maxUnits} disabled={active} onChange={e=>setMaxUnits(Number(e.target.value))}/></label></div>
 <label className="check"><input type="checkbox" checked={autoRead} disabled={active} onChange={e=>setAutoRead(e.target.checked)}/> Allow project file reads without asking on every step</label>
 <button disabled={!props.root||!goal.trim()||active||busy||!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>100||!Number.isSafeInteger(maxUnits)||maxUnits<1} onClick={start}>Start agent run</button>{active&&<button onClick={stop}>Stop run</button>}
 <p role="status">{status}</p>
 {pending&&<div className="agent-review"><h3>Review {pending.action.type}</h3>{pending.action.type==='edit_file'?<><p>{pending.action.path}</p><div className="field-row"><pre>{'Original:\n'+pending.action.oldText}</pre><pre>{'Replacement:\n'+pending.action.newText}</pre></div></>:pending.action.type==='run_task'?<pre>{JSON.stringify(taskOrder(pending.run.tasks,[pending.action.task]).map(id=>({id,...pending.run.tasks[id]})),null,2)}</pre>:<pre>{JSON.stringify(pending.action,null,2)}</pre>}<button disabled={busy} onClick={()=>{setBusy(true);void props.onSaveEdits().then(()=>setStatus("Saved modified project buffers; review and approve the action when ready.")).catch(e=>setStatus(String(e))).finally(()=>setBusy(false));}}>Save all modified project files</button><button disabled={busy} onClick={()=>void perform(pending.run,pending.action)}>Approve action and continue</button><button onClick={stop}>Reject and stop</button></div>}
 <pre className="ai-answer">{log}</pre></section>;
}
