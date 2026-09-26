import ChangeReview from './ChangeReview';
import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {agentInstructions,parseAction,type AgentAction} from './agent';
import {composeGuidance,takeSlashSkill,type Skill} from './guidance';
import {applyPlanEvidence,formatPlan,planFromLines,unfinished,type Finding,type PlanStep} from './loop';
import type {SecretFinding} from './policy';
import {secretRefusal} from './secrets';
import {workspaceSymbols} from './symbols';
import type {ConnectedServer} from './languageServices';
import {taskOrder,type Task} from './workflows';
export type RunBudget={id:string;maxRequests:number;maxUnits:number};
type Run={budget:RunBudget;steps:number;goal:string;skill:Skill|null;context:string;transcript:string;stopped:boolean;autoRead:boolean;ask:Props['ask'];read:Props['onRead'];edit:Props['onEdit'];task:Props['onTask'];tasks:Record<string,Task>;plan:PlanStep[]|null};
type Worktree={name:string;path:string;branch:string};
type Props={onCancelRequest?:()=>void;root:string;context:string;tasks:Record<string,Task>;ask:(prompt:string,context:string,budget:RunBudget)=>Promise<string>;onRead:(path:string)=>Promise<string>;onEdit:(path:string,oldText:string,newText:string)=>Promise<string>;onTask:(name:string)=>Promise<string>;onInspectRun:(runId?:number)=>Promise<string>;onProposeDebugLaunch:(runId:number,testId:string)=>Promise<string>;onInspectDebug:()=>Promise<string>;onStopTask:()=>void;onSaveEdits:()=>Promise<void>;changes?:number;onRollback?:()=>Promise<string>;onRunStart?:()=>void;servers?:ConnectedServer[];skills?:Skill[];skill?:Skill|null;mcpTools?:Array<{server:string;name:string;description:string}>;onOpenFile?:(path:string,line:number)=>void;onOpenRoot?:(path:string)=>void};
export default function AgentPanel(props:Props){
 const [goal,setGoal]=useState(''),[maxSteps,setMaxSteps]=useState(8),[maxUnits,setMaxUnits]=useState(50000),[autoRead,setAutoRead]=useState(false);
 const [busy,setBusy]=useState(false),[active,setActive]=useState(false),[status,setStatus]=useState(''),[log,setLog]=useState('');
 const [plan,setPlan]=useState<PlanStep[]|null>(null),[draft,setDraft]=useState(''),[findings,setFindings]=useState<Finding[]>([]),[shot,setShot]=useState(''),[worktrees,setWorktrees]=useState<Worktree[]>([]);
 const [pending,setPending]=useState<{run:Run;action:AgentAction}|null>(null);const current=useRef<Run|null>(null),taskRunning=useRef(false);const stopTask=useRef(props.onStopTask);stopTask.current=props.onStopTask;
 const refreshWorktrees=()=>{void invoke<Worktree[]>('git_worktrees',{root:props.root}).then(setWorktrees).catch(()=>setWorktrees([]));};
 useEffect(()=>{refreshWorktrees();},[props.root]);
 const stop=()=>{props.onCancelRequest?.();if(current.current)current.current.stopped=true;setPending(null);setActive(false);setStatus('Stopped; an in-flight provider request may still finish and remains charged.');if(taskRunning.current)stopTask.current();};
 useEffect(()=>()=>{if(current.current)current.current.stopped=true;if(taskRunning.current)stopTask.current();},[props.root]);
 const reviewHeading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{if(pending)reviewHeading.current?.focus();},[pending]);
 const live=(run:Run)=>current.current===run&&!run.stopped;
 const note=(run:Run,text:string)=>{run.transcript=(run.transcript+'\n'+text).slice(-100000);if(live(run))setLog(run.transcript);};
 async function next(run:Run){
  if(!live(run))return;
  if(run.steps>=run.budget.maxRequests){setStatus('Run step limit reached.');setActive(false);return;}
  run.steps++;setBusy(true);setStatus(`Model step ${run.steps}/${run.budget.maxRequests}`);
  try{
   const text=await run.ask(`${agentInstructions}\n${composeGuidance({skill:run.skill})}\nConfigured MCP tools: ${JSON.stringify(props.mcpTools??[])}\nConfigured tasks: ${JSON.stringify(Object.keys(run.tasks))}\nGoal: ${run.goal}\nObservations:\n${run.transcript}`,run.context,run.budget);
   if(!live(run))return;
   const action=parseAction(text,Object.keys(run.tasks));
   if(action.type==='finish'){const left=run.plan?unfinished(run.plan):[];note(run,left.length?`${action.message}\nUnfinished plan steps: ${left.join(', ')}`:action.message);setStatus(left.length?'Agent finished with unfinished plan steps.':'Agent finished');setActive(false);return;}
   setBusy(false);
   if((action.type==='read_file'||action.type==='list_directory'||action.type==='search_text'||action.type==='search_symbols'||action.type==='inspect_run'||action.type==='inspect_debug'||action.type==='review_diff')&&run.autoRead){await perform(run,action);return;}
   if(action.type==='propose_plan')setDraft(formatPlan(action.steps));
   setPending({run,action});setStatus('Review the proposed action below.');
  }catch(e){if(live(run)){setStatus(String(e));setActive(false);run.stopped=true;}}finally{if(current.current===run)setBusy(false);}
 }
 async function perform(run:Run,action:AgentAction){
  if(!live(run))return;setPending(null);setBusy(true);
  try{
   let observation='';
   if(action.type==='read_file')observation=`File ${action.path}:\n${(await run.read(action.path)).slice(0,60000)}\n[File context limited to 60,000 characters]`;
   if(action.type==='list_directory'){
    const path=action.path==='.'?props.root:`${props.root}/${action.path}`;
    const entries=await invoke<Array<{name:string;directory:boolean}>>('list_directory',{path});
    observation=entries.slice(0,200).map(entry=>`${entry.directory?'dir':'file'} ${entry.name}`).join('\n')||'(empty directory)';
   }
   if(action.type==='search_text'){
    const result=await invoke<{hits:Array<{path:string;line:number;text:string}>;truncated:boolean}>('workspace_search',{root:props.root,query:action.query});
    observation=result.hits.slice(0,50).map(hit=>`${hit.path.startsWith(props.root+'/')?hit.path.slice(props.root.length+1):hit.path}:${hit.line}: ${hit.text}`).join('\n')||'No matches';
    if(result.truncated)observation+='\n[Search limit reached]';
   }
   if(action.type==='search_symbols'){
    const servers=(props.servers??[]).filter(server=>server.capabilities.workspaceSymbolProvider);
    const found=await workspaceSymbols(servers,action.query);
    observation=found.slice(0,50).map(symbol=>`${symbol.name} ${symbol.path.startsWith(props.root+'/')?symbol.path.slice(props.root.length+1):symbol.path}:${symbol.line}`).join('\n')||'No symbols. Connect a language server that supports workspace symbols.';
   }
   if(action.type==='edit_file'){
    const findings=await invoke<SecretFinding[]>('scan_buffer_secrets',{path:action.path,text:action.newText});
    if(findings.length)throw new Error(secretRefusal(findings,'the proposed edit'));
    observation=await run.edit(action.path,action.oldText,action.newText);
    void invoke('journal_agent_edit',{root:props.root,path:action.path}).catch(()=>{});
   }
   if(action.type==='run_task'){taskRunning.current=true;try{observation=await run.task(action.task);}finally{taskRunning.current=false;}}
   if(action.type==='call_mcp')observation=await invoke<string>('mcp_call',{root:props.root,name:action.server,tool:action.tool,arguments:action.arguments});
   if(action.type==='inspect_run')observation=await props.onInspectRun(action.runId);
   if(action.type==='inspect_debug')observation=await props.onInspectDebug();
   if(action.type==='propose_debug_launch')observation=await props.onProposeDebugLaunch(action.runId,action.testId);
   if(action.type==='review_diff')observation=await invoke<string>('git_review_diff',{root:props.root});
   if(action.type==='propose_plan'){run.plan=action.steps.map(item=>({...item,done:false}));setPlan(run.plan);observation=`Plan accepted:\n${formatPlan(run.plan)}`;}
   if(action.type==='update_plan'){if(!run.plan)throw new Error('Propose a plan before recording evidence');run.plan=applyPlanEvidence(run.plan,action.id,action.evidence);setPlan(run.plan);observation=`Step ${action.id} recorded.`;}
   if(action.type==='report_findings'){setFindings(action.findings);observation=action.findings.map(item=>`${item.path}:${item.line}: ${item.summary}`).join('\n');}
   if(action.type==='capture_page'){const page=await invoke<{console:string;image:string}>('capture_page',{url:action.url});setShot(page.image);observation=`Local page ${action.url}\n${page.console||'(no browser log)'}`;}
   if(action.type==='propose_worktree'){const created=await invoke<Worktree>('git_worktree_add',{root:props.root,name:action.name});refreshWorktrees();observation=`Isolated worktree ${created.name} at ${created.path}. Open it to start a separate run. One task still runs at a time.`;}
   if(observation){
    const findings=await invoke<SecretFinding[]>('scan_buffer_secrets',{path:'agent-observation.txt',text:observation});
    if(findings.length)throw new Error(secretRefusal(findings,'the tool observation'));
    observation=observation.slice(0,60000);
   }
   note(run,`${JSON.stringify(action)}\nTool observation: ${observation}`);
  }catch(e){note(run,`Tool failed: ${String(e)}`);}finally{if(current.current===run)setBusy(false);}
  if(live(run))await next(run);
 }
 function start(){const chosen=takeSlashSkill(goal,props.skills??[]);props.onRunStart?.();const run:Run={budget:{id:crypto.randomUUID(),maxRequests:maxSteps,maxUnits},steps:0,goal:chosen.goal,skill:chosen.skill??props.skill??null,context:props.context.slice(0,60000),transcript:'',stopped:false,autoRead,ask:props.ask,read:props.onRead,edit:props.onEdit,task:props.onTask,tasks:props.tasks,plan:null};current.current=run;setLog('');setPlan(null);setFindings([]);setShot('');setPending(null);setActive(true);void next(run);}
 function approve(){if(!pending)return;if(pending.action.type==='propose_plan'){try{const steps=planFromLines(draft);void perform(pending.run,{type:'propose_plan',steps});}catch(error){setStatus(String(error));}return;}void perform(pending.run,pending.action);}
 return <section><h2>Agent run</h2><p>The agent can list directories, search project text, read project files, inspect recent runs and captured debug snapshots, propose a failed-test debug configuration without starting the adapter, propose exact edits, run configured tasks, and call a connected MCP tool. It can also propose an editable plan, read the current diff, report findings, capture a localhost page, and create an isolated worktree. Edits, tasks, debug handoff, MCP calls, plans, findings, captures, and worktrees require review. A configured task runs in the macOS sandbox and cannot read credential files. It is not a shell. Save approved buffers before approving builds that depend on them.</p>
 {worktrees.length>0&&<div><p>Isolated worktrees. Opening one selects that checkout. One task runs at a time.</p>{worktrees.map(item=><p key={item.name}><code>{item.name}</code> {item.branch} <button type="button" onClick={()=>props.onOpenRoot?.(item.path)}>Open</button> <button type="button" onClick={()=>void invoke('git_worktree_remove',{root:props.root,name:item.name}).then(refreshWorktrees).catch(error=>setStatus(String(error)))}>Remove</button></p>)}</div>}
 {plan&&<ol aria-label="Run plan">{plan.map(item=><li key={item.id}>{item.done?'Done':'Open'} {item.id}: {item.text}{item.evidence?` — ${item.evidence}`:''}</li>)}</ol>}
 {findings.length>0&&<ul aria-label="Review findings">{findings.map(item=><li key={`${item.path}:${item.line}`}><button type="button" onClick={()=>props.onOpenFile?.(item.path,item.line)}>{item.path}:{item.line}</button> {item.summary}</li>)}</ul>}
 {shot&&<img alt="Captured local page" src={`data:image/png;base64,${shot}`} />}
 <label>Goal<textarea rows={3} value={goal} disabled={active} onChange={e=>setGoal(e.target.value)}/></label><div className="field-row"><label>Maximum model steps<input type="number" min="1" max="100" value={maxSteps} disabled={active} onChange={e=>setMaxSteps(Number(e.target.value))}/></label><label>Maximum run reservation units<input type="number" min="1" value={maxUnits} disabled={active} onChange={e=>setMaxUnits(Number(e.target.value))}/></label></div>
 <label className="check"><input type="checkbox" checked={autoRead} disabled={active} onChange={e=>setAutoRead(e.target.checked)}/> Allow project file reads and investigation probes without asking on every step</label>
 <button disabled={!props.root||!goal.trim()||active||busy||!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>100||!Number.isSafeInteger(maxUnits)||maxUnits<1} onClick={start}>Start agent run</button>{active&&<button onClick={stop}>Stop run</button>}
 {props.onRollback&&<button disabled={busy||!props.changes} onClick={()=>void props.onRollback!().then(setStatus).catch(e=>setStatus(String(e)))}>Roll back this run's edits ({props.changes??0})</button>}
 <p role="status">{status}</p>
 {pending&&<div className="agent-review"><h3 ref={reviewHeading} tabIndex={-1}>Review {pending.action.type}</h3>{pending.action.type==='edit_file'?<ChangeReview path={pending.action.path} oldText={pending.action.oldText} newText={pending.action.newText}/>:pending.action.type==='run_task'?<pre>{JSON.stringify(taskOrder(pending.run.tasks,[pending.action.task]).map(id=>({id,...pending.run.tasks[id]})),null,2)}</pre>:pending.action.type==='propose_debug_launch'?<><p>Prepares the existing failed-test debug configuration and clears adapter trust. The adapter is not started.</p><pre>{JSON.stringify(pending.action,null,2)}</pre></>:pending.action.type==='propose_plan'?<label>Edit the plan before accepting<textarea aria-label="Plan" rows={Math.min(12,Math.max(3,draft.split('\n').length))} value={draft} onChange={event=>setDraft(event.target.value)}/></label>:pending.action.type==='capture_page'?<p>Opens this localhost page in a fresh browser profile, then stops it. No clicks are sent.</p>:<pre>{JSON.stringify(pending.action,null,2)}</pre>}<button disabled={busy} onClick={()=>{setBusy(true);void props.onSaveEdits().then(()=>setStatus("Saved modified project buffers; review and approve the action when ready.")).catch(e=>setStatus(String(e))).finally(()=>setBusy(false));}}>Save all modified project files</button><button disabled={busy} onClick={approve}>Approve action and continue</button><button onClick={stop}>Reject and stop</button></div>}
 <pre className="ai-answer" tabIndex={0} aria-label="Agent transcript">{log}</pre></section>;
}
