import OutputLog from './OutputLog';
import PolicySection from './PolicySection';
import {listen} from '@tauri-apps/api/event';
import {useEffect,useRef,useState} from 'react';
import { runTask } from './taskRunner';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {infrastructureTasks,parseInfrastructureDiagnostics,type InfrastructureDiagnostic,type InfrastructureKind} from './infrastructure';
import {expandTask,taskOrder} from './workflows';
export default function InfrastructurePanel({root,file,dirty,detected,onDiagnostics,onOpen,onConfigure,onDebug}:{root:string;file:string;dirty:boolean;detected:string[];onDiagnostics:(rows:InfrastructureDiagnostic[])=>void;onOpen:(path:string,line:number)=>void;onConfigure:(preset:string)=>void;onDebug:()=>void}){
 const [kind,setKind]=useState<InfrastructureKind>('Terraform'),[action,setAction]=useState('validate'),[cwd,setCwd]=useState('.'),[trusted,setTrusted]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[output,setOutput]=useState(''),[problems,setProblems]=useState<InfrastructureDiagnostic[]>([]);
 const [tools,setTools]=useState<Array<{name:string;available:boolean;path:string|null;version:string}>>([]),[checking,setChecking]=useState(false);
 const generation=useRef(0),running=useRef(false),cancelled=useRef(false);
 useEffect(()=>{let disposed=false;let off=()=>{};void listen<{text:string}>('task:output',event=>{if(running.current)setOutput(value=>(value+event.payload.text).slice(-200000));}).then(listener=>{if(disposed)listener();else off=listener;}).catch(e=>setStatus(String(e)));return()=>{disposed=true;off();};},[]);
 useEffect(()=>{setTrusted(false);setCwd('.');setProblems([]);setBusy(false);setStatus('');setOutput('');return()=>{generation.current++;if(running.current){cancelled.current=true;void invoke('cancel_task').catch(()=>{});running.current=false;}};},[root]);
 useEffect(()=>{setTrusted(false);},[file,cwd,kind,action]);
 const tasks=infrastructureTasks[kind];let plan:any[]=[];let configError='';
 try{plan=taskOrder(tasks,[action]).map(id=>({id,task:expandTask({...tasks[id],cwd},{project:root,file})}));}catch(e){configError=String(e);}
 async function run(){const current=++generation.current;setBusy(true);running.current=true;cancelled.current=false;setOutput('');setStatus('Running…');setProblems([]);onDiagnostics([]);let log='';
  try{
   const names=[...new Set(plan.map(step=>step.task.command as string))];if(kind==='Ansible'&&action==='debug-listen')names.push('ansibug');
   const checked=await invoke<typeof tools>('inspect_tools',{names});if(current!==generation.current)return;setTools(checked);
   const missing=checked.filter(tool=>!tool.available);if(missing.length)throw new Error('Unavailable tools: '+missing.map(tool=>tool.name).join(', ')+'. See installed-tool checks below.');
   for(const step of plan){if(cancelled.current)throw new Error('Cancelled');const result=await runTask(root,cwd,step.task);log+=`\n> ${step.task.command} ${step.task.args.join(' ')}\n${result.output}\n[exit ${result.code}]\n`;if(current!==generation.current)return;setOutput(log.slice(-200000));
    if(['validate','lint'].includes(step.id)){try{const directory=await invoke<string>('task_directory',{root,cwd});const rows=parseInfrastructureDiagnostics(result.output,directory,kind+' '+step.id);setProblems(rows);onDiagnostics(rows);}catch(e){setStatus(String(e));if(result.code===0)throw e;}}
    if(result.code!==0)throw new Error(`${step.id} exited ${result.code}. See diagnostics and output.`);
   }
   if(current===generation.current)setStatus('Completed successfully');
  }catch(e){if(current===generation.current)setStatus(String(e));}finally{if(current===generation.current){running.current=false;setBusy(false);}}
 }
 return <section className="workbench-page"><h1>Infrastructure</h1><p>Built-in Terraform, OpenTofu and Ansible workflows. Detected: {detected.join(', ')||'select a project folder'}. CLI tools, providers, collections and language servers must be installed separately.</p>
 <div className="field-row"><label>Tool<select disabled={busy} value={kind} onChange={e=>{const next=e.target.value as InfrastructureKind;setKind(next);setAction(next==='Ansible'?'syntax':'validate');}}>{Object.keys(infrastructureTasks).map(k=><option key={k}>{k}</option>)}</select></label><label>Action<select disabled={busy} value={action} onChange={e=>setAction(e.target.value)}>{Object.keys(tasks).map(k=><option key={k}>{k}</option>)}</select></label><label>Working directory relative to project<input value={cwd} disabled={busy} onChange={e=>setCwd(e.target.value)}/></label></div>
 <p>Terraform and OpenTofu validation initializes dependencies with the backend disabled. Plan/trace actions use your configured backend and credentials. Ansible check mode follows module check-mode support. Review the exact commands below.</p><pre>{configError||JSON.stringify(plan,null,2)}</pre><label className="check"><input type="checkbox" checked={trusted} disabled={busy} onChange={e=>setTrusted(e.target.checked)}/> Trust and run these commands for this project</label>
 {dirty&&<p>Save modified files before checking; tools read the files on disk.</p>}<button disabled={!isTauri()||!root||!trusted||busy||!!configError||dirty} onClick={()=>void run()}>Run selected action</button>{busy&&<button onClick={()=>{cancelled.current=true;void invoke('cancel_task').catch(e=>setStatus(String(e)));}}>Stop action</button>}<button onClick={()=>onConfigure(kind)}>Create scoped workflow configuration</button>
 <h2>Installed tools</h2><p>Checks use the application's executable search path. Install missing tools separately, then check again. Ansibug must be installed in the Python environment used by python3; custom environments can be configured as project workflows.</p>
 <button disabled={!isTauri()||checking||busy} onClick={()=>{setChecking(true);void invoke<typeof tools>('inspect_tools',{names:['terraform','tofu','tflint','ansible-playbook','ansible-lint','ansibug']}).then(setTools).catch(e=>setStatus(String(e))).finally(()=>setChecking(false));}}>{checking?'Checking tools…':'Check installed tools'}</button>
 <ul>{tools.map(tool=><li key={tool.name}><strong>{tool.name}: {tool.available?'available':'unavailable'}</strong>{tool.path&&<p>{tool.path}</p>}<pre>{tool.version}</pre></li>)}</ul>
 <h2>Debugging</h2>{kind==='Ansible'?<><p>For task breakpoints and variable inspection, install Ansibug in the Python environment containing Ansible. Run debug-listen here, then choose the Ansible attach preset in Run and debug. This attaches to localhost:4712. Use a dedicated Python executable in a project workflow when needed.</p><button onClick={onDebug}>Open Run and debug</button></>:<p>Use trace-plan for engine/provider logs, or show-plan for an existing plan.out. Terraform/OpenTofu configuration is declarative and does not expose source stepping through DAP. To step through provider source, configure the Go debugger separately. Trace output and plan JSON can contain sensitive values.</p>}
 <PolicySection root={root} onDiagnostics={onDiagnostics} onOpen={onOpen}/>
 <p role="status">{status}</p><h2>Problems</h2>{problems.map((p,i)=><button className="search-hit" key={i} onClick={()=>onOpen(p.path,p.line)}>{p.severity} · {p.path}:{p.line}:{p.column}<code>{p.message}</code></button>)}<OutputLog label="Infrastructure command output">{output||'Command output appears here.'}</OutputLog>
 </section>;
}
