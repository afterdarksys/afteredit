import {listen} from '@tauri-apps/api/event';
import OutputLog from './OutputLog';
import type {Task} from './workflows';
import type {InfrastructureDiagnostic} from './infrastructure';
import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {appleBuild,appleDiagnostics,appleMetadata,appleDestinations,type AppleMetadata,type AppleSelection,type AppleDestination} from './appleDevelopment';
type Tool={name:string;available:boolean;detail:string};
export default function ApplePanel({root,dirty,onOpen,onProblems}:{root:string;dirty:boolean;onOpen:(path:string,line:number)=>void;onProblems:(problems:InfrastructureDiagnostic[])=>void}){
 const [tools,setTools]=useState<Tool[]>([]),[projects,setProjects]=useState<string[]>([]),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 const [selection,setSelection]=useState<AppleSelection>({project:'',scheme:'',target:'',configuration:'Debug',destination:''}),[metadata,setMetadata]=useState<AppleMetadata>({schemes:[],targets:[],configurations:[]}),[destinations,setDestinations]=useState<AppleDestination[]>([]),[trusted,setTrusted]=useState(false);
 const change=(patch:Partial<AppleSelection>)=>{setSelection(s=>({...s,...patch}));setTrusted(false);setPlan(null);};
 const [plan,setPlan]=useState<{tasks:Task[];result?:string}|null>(null),[output,setOutput]=useState(''),[problems,setProblems]=useState<InfrastructureDiagnostic[]>([]),[resultPath,setResultPath]=useState(''),[summary,setSummary]=useState('');
 const running=useRef(false),cancelled=useRef(false);
 useEffect(()=>()=>{cancelled.current=true;},[]);
 function prepare(action:'build'|'test'){try{setPlan(appleBuild(selection,action,Date.now().toString(36)));setStatus('Review the commands, then run.');}catch(e){setStatus(String(e));}}
 async function execute(){if(!plan||running.current)return;running.current=true;cancelled.current=false;setBusy(true);setOutput('');setSummary('');setResultPath('');setProblems([]);onProblems([]);let off=()=>{},combined='';try{
  off=await listen<{text:string}>('task:output',e=>{if(running.current)setOutput(v=>(v+e.payload.text).slice(-200000));});
  for(const task of plan.tasks){if(cancelled.current)break;const result=await invoke<{code:number;output:string}>('run_task',{root,cwd:task.cwd??'.',task});combined+=result.output;const found=appleDiagnostics(result.output,root,task.cwd??'.');setProblems(v=>[...v,...found]);onProblems(appleDiagnostics(combined,root,task.cwd??'.'));if(result.code!==0)throw new Error('Apple command exited '+result.code+'. See output.');}
  if(cancelled.current)setStatus('Apple action stopped.');else{setResultPath(plan.result??'');setStatus('Apple action completed.');}
 }catch(e){if(plan.result)setResultPath(plan.result);setStatus(String(e));}finally{off();running.current=false;setBusy(false);setOutput(previous=>combined||previous||'No command output captured.');}}
 async function readResult(){setBusy(true);try{setSummary(await invoke<string>('apple_query',{root,query:{kind:'results',path:resultPath}}));setStatus('Test results loaded.');}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 async function load(kind:'metadata'|'destinations'){setBusy(true);setStatus('Reading '+kind+'…');try{const text=await invoke<string>('apple_query',{root,query:{kind,...selection}});if(kind==='metadata'){const result=appleMetadata(text);setMetadata(result);setSelection(s=>({...s,scheme:result.schemes[0]??'',target:'',configuration:result.configurations.includes('Debug')?'Debug':result.configurations[0]??'Debug',destination:''}));setDestinations([]);}else setDestinations(appleDestinations(text));setStatus('Loaded '+kind);}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 async function inspect(){setBusy(true);setStatus('Checking Apple toolchain…');try{setTools(await invoke<Tool[]>('apple_toolchain'));if(root)setProjects(await invoke<string[]>('apple_projects',{root}));setStatus('Toolchain checked. Project discovery searches five directory levels.');}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 return <section className="workbench-page"><h1>Apple development</h1><p>Develop Swift packages and iOS/macOS projects using your selected Xcode installation.</p><button disabled={!isTauri()||busy} onClick={()=>void inspect()}>Check Xcode and discover projects</button><p role="status">{status}</p>{tools.map(tool=><details key={tool.name}><summary>{tool.name}: {tool.available?'available':'unavailable'}</summary><pre>{tool.detail}</pre></details>)}<h2>Project and destination</h2>
 <label>Apple project<select disabled={busy} value={selection.project} onChange={e=>{change({project:e.target.value,scheme:'',target:'',destination:''});setMetadata({schemes:[],targets:[],configurations:[]});setDestinations([]);}}><option value="">Choose a discovered project</option>{projects.map(path=><option key={path}>{path}</option>)}</select></label>
 <label className="check"><input type="checkbox" checked={trusted} disabled={busy} onChange={e=>setTrusted(e.target.checked)}/> Trust this project’s Apple tool commands</label><p>Metadata queries may resolve packages and load project build configuration. Commands run only when requested.</p>
 <button disabled={busy||!trusted||!selection.project} onClick={()=>void load('metadata')}>Load schemes and targets</button>
 <label>Scheme<select disabled={busy} value={selection.scheme} onChange={e=>change({scheme:e.target.value,target:'',destination:''})}><option value="">Use a target instead</option>{metadata.schemes.map(name=><option key={name}>{name}</option>)}</select></label>
 <label>Target<select disabled={busy||selection.project.endsWith('.xcworkspace')} value={selection.target} onChange={e=>change({target:e.target.value,scheme:'',destination:''})}><option value="">Use the selected scheme</option>{metadata.targets.map(name=><option key={name}>{name}</option>)}</select></label>
 <label>Build configuration<input disabled={busy} value={selection.configuration} list="apple-configurations" onChange={e=>change({configuration:e.target.value})}/><datalist id="apple-configurations">{metadata.configurations.map(name=><option key={name} value={name}/>)}</datalist></label>
 <button disabled={busy||!trusted||!selection.scheme||selection.project.endsWith('Package.swift')} onClick={()=>void load('destinations')}>Load destinations</button>
 <label>Destination<select disabled={busy} value={selection.destination} onChange={e=>change({destination:e.target.value})}><option value="">Toolchain default</option>{destinations.map(d=><option key={d.platform+d.id} disabled={!d.available} value={d.id.startsWith('dvtdevice-')?'generic/platform='+d.platform:'platform='+d.platform+',id='+d.id}>{d.name} · {d.platform}{!d.available?' (unavailable)':''}</option>)}</select></label>
 <h2>Build and test</h2><p>Builds and tests can execute project scripts and package plugins. Save modified files first.</p>
 <button disabled={busy||!trusted||!selection.project||dirty} onClick={()=>prepare('build')}>Prepare build</button><button disabled={busy||!trusted||!selection.project||dirty} onClick={()=>prepare('test')}>Prepare tests</button>
 {dirty&&<p>Save modified project files before running Apple commands.</p>}
 {plan&&<section aria-label="Apple command review"><h3>Command review</h3><pre tabIndex={0}>{JSON.stringify(plan.tasks,null,2)}</pre><button disabled={busy||!trusted||dirty||!isTauri()} onClick={()=>void execute()}>Run reviewed Apple commands</button></section>}
 {busy&&running.current&&<button onClick={()=>{cancelled.current=true;void invoke('cancel_task').catch(e=>setStatus(String(e)));}}>Stop Apple action</button>}
 <h2>Build problems</h2>{problems.map((problem,i)=><button key={i} onClick={()=>onOpen(problem.path,problem.line)}>{problem.severity}: {problem.path}:{problem.line} — {problem.message}</button>)}
 <OutputLog label="Apple command output">{output||'Build and test output appears here.'}</OutputLog>
 {resultPath&&<section><h2>Result bundle</h2><p>{resultPath}</p><button disabled={busy} onClick={()=>void readResult()}>Read test results</button>{summary&&<pre tabIndex={0} aria-label="Apple test results">{summary}</pre>}</section>}
 </section>;
}
