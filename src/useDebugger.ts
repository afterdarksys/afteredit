import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {breakpointArguments,configureDebug,debugConfig,expandDebug,restoreBreakpoints,type Breakpoint} from './debugging';
export function useDebugger(root:string,file:string,onNavigate:(path:string,line:number)=>void){
 const [stopReason,setStopReason]=useState('');
 const [phase,setPhase]=useState('idle'),[error,setError]=useState(''),[output,setOutput]=useState(''),[caps,setCaps]=useState<Record<string,any>>({});
 const [points,setPoints]=useState<Breakpoint[]>(()=>{try{return restoreBreakpoints(localStorage.getItem('debug.breakpoints.v1')??'[]');}catch{return [];}});
 const [threads,setThreads]=useState<any[]>([]),[thread,setThread]=useState<number>(),[frames,setFrames]=useState<any[]>([]),[frame,setFrame]=useState<any>(),[scopes,setScopes]=useState<any[]>([]);
 const [variables,setVariables]=useState<Record<number,any[]>>({}),[evaluation,setEvaluation]=useState(''),[busy,setBusy]=useState(false);
 const session=useRef<number|null>(null),generation=useRef(0),epoch=useRef(0),initialized=useRef<()=>void>(()=>{}),abortStartup=useRef<(error:Error)=>void>(()=>{}),capsRef=useRef<Record<string,any>>({}),mode=useRef('launch'),unlisten=useRef<()=>void>(()=>{}),phaseRef=useRef(phase),pointsRef=useRef(points),navigation=useRef(onNavigate);
 phaseRef.current=phase;pointsRef.current=points;navigation.current=onNavigate;
 const report=(e:unknown)=>setError(String(e));
 const clearInspection=()=>{epoch.current++;setStopReason('');setFrames([]);setFrame(undefined);setScopes([]);setVariables({});setEvaluation('');};
 const request=async(command:string,args:Record<string,any>={})=>{if(session.current===null)throw new Error('No active debugger');return invoke<any>('dap_request',{session:session.current,command,arguments:args});};
 const updateVerified=(path:string,results:any[])=>setPoints(current=>{let i=0;return current.map(p=>p.path!==path||p.enabled===false?p:{...p,verified:results[i]?.verified===true,message:results[i]?.message,adapterId:results[i++]?.id});});
 async function loadVariables(reference:number){const mark=epoch.current;const result=await request('variables',{variablesReference:reference,start:0,count:200});if(mark===epoch.current)setVariables(v=>({...v,[reference]:result.variables??[]}));}
 async function selectFrame(selected:any){const mark=++epoch.current;setFrame(selected);setScopes([]);setVariables({});setEvaluation('');if(selected.source?.path)navigation.current(selected.source.path,selected.line);const result=await request('scopes',{frameId:selected.id});if(mark!==epoch.current)return;setScopes(result.scopes??[]);}
 async function selectThread(id:number){const mark=++epoch.current;setThread(id);setFrame(undefined);setScopes([]);setVariables({});const result=await request('stackTrace',{threadId:id,startFrame:0,levels:100});if(mark!==epoch.current)return;setFrames(result.stackFrames??[]);if(result.stackFrames?.[0])await selectFrame(result.stackFrames[0]);}
 async function stopped(body:any){clearInspection();setStopReason(String(body.description??body.text??body.reason??'Paused'));setPhase('paused');phaseRef.current='paused';const mark=epoch.current;const result=await request('threads');if(mark!==epoch.current)return;setThreads(result.threads??[]);const id=body.threadId??result.threads?.[0]?.id;if(id!==undefined)await selectThread(id);}
 async function stop(){generation.current++;abortStartup.current(new Error('Debug start cancelled'));abortStartup.current=()=>{};const id=session.current;session.current=null;unlisten.current();unlisten.current=()=>{};clearInspection();setThreads([]);setThread(undefined);setPoints(v=>v.map(({verified:_v,message:_m,adapterId:_id,...p})=>p));setPhase('idle');setBusy(false);phaseRef.current='idle';if(id!==null){try{await Promise.race([invoke('dap_request',{session:id,command:'disconnect',arguments:{terminateDebuggee:mode.current==='launch'}}),new Promise(resolve=>setTimeout(resolve,1500))]);}catch{}await invoke('dap_stop',{session:id}).catch(report);}}
 useEffect(()=>{return()=>{void stop();};},[root]);
 async function start(text:string,filters:string[]){
  if(session.current!==null&&phaseRef.current==='ended')await stop();if(session.current!==null||busy)return;const run=++generation.current;setBusy(true);setError('');setOutput('');setCaps({});capsRef.current={};clearInspection();setPhase('starting');phaseRef.current='starting';
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const config=debugConfig(expandDebug(JSON.parse(text),root,file));mode.current=config.request;
   const ready=new Promise<void>((resolve,reject)=>{initialized.current=resolve;abortStartup.current=reject;timer=setTimeout(()=>reject(new Error('Adapter did not send initialized within 30 seconds')),30000);});
   // Attach a handler immediately so cancellation cannot leave an unhandled timeout.
   void ready.catch(()=>{});
   const off=await listen<{session:number;message:any}>('dap:event',({payload})=>{
    if(run!==generation.current||payload.session!==session.current)return;const m=payload.message,b=m.body??{};
    if(m.event==='initialized')initialized.current();
    if(m.event==='capabilities'){capsRef.current={...capsRef.current,...b.capabilities};setCaps(capsRef.current);}
    if(m.event==='output')setOutput(v=>(v+String(b.output??'')).slice(-200000));
    if(m.event==='stopped')void stopped(b).catch(report);
    if(m.event==='continued'){clearInspection();setPhase('running');phaseRef.current='running';}
    if(m.event==='breakpoint'&&b.breakpoint?.id!==undefined)setPoints(v=>v.map(p=>p.adapterId===b.breakpoint?.id?{...p,verified:b.breakpoint?.verified===true,message:b.breakpoint?.message}:p));
    if(m.event==='terminated'||m.event==='aftereditClosed'){abortStartup.current(new Error(String(b.reason??'Adapter ended during startup')));clearInspection();setPhase('ended');phaseRef.current='ended';setBusy(false);if(m.event==='aftereditClosed')setError(String(b.reason??'Adapter closed'));}
   });
   if(run!==generation.current){off();return;}unlisten.current=off;
   const id=await invoke<number>('dap_start',{root,adapter:config.adapter});
   if(run!==generation.current){await invoke('dap_stop',{session:id});return;}session.current=id;
   const req=async(c:string,a:Record<string,any>)=>{if(run!==generation.current)throw new Error('Debug start cancelled');return invoke<any>('dap_request',{session:id,command:c,arguments:a});};
   await configureDebug(req,ready,config,pointsRef.current.filter(p=>p.path.startsWith(root+'/')),filters,c=>{capsRef.current=c;setCaps(c);},updateVerified);
   if(run!==generation.current)return;if(phaseRef.current==='starting'){setPhase('running');phaseRef.current='running';const result=await req('threads',{});setThreads(result.threads??[]);setThread(result.threads?.[0]?.id);}
  }catch(e){if(run===generation.current){await stop();report(e);}}finally{if(timer)clearTimeout(timer);if(run===generation.current){abortStartup.current=()=>{};setBusy(false);}}
 }
 async function changePoints(next:Breakpoint[]){
  try{localStorage.setItem('debug.breakpoints.v1',JSON.stringify(next.map(({verified:_v,message:_m,adapterId:_id,...p})=>p)));}catch(e){report(e);return;}
  const connection=session.current,run=generation.current;
  const previous=pointsRef.current;pointsRef.current=next;setPoints(next);
  if(session.current!==null&&['running','paused'].includes(phaseRef.current)){
   try{for(const path of new Set([...previous,...next].filter(p=>p.path.startsWith(root+'/')).map(p=>p.path))){if(run!==generation.current||session.current!==connection)return;const reply=await invoke<any>('dap_request',{session:connection,command:'setBreakpoints',arguments:breakpointArguments(path,next,capsRef.current)});if(run!==generation.current)return;updateVerified(path,reply.breakpoints??[]);}}catch(e){report(e);}
  }
 }
 const toggle=(path:string,line:number)=>{if(phaseRef.current==='starting'){report('Wait for debugger startup before changing breakpoints');return;}void changePoints(pointsRef.current.some(p=>p.path===path&&p.line===line)?pointsRef.current.filter(p=>p.path!==path||p.line!==line):[...pointsRef.current,{path,line}]);};
 async function control(command:string){if(thread===undefined)return;setBusy(true);setError('');try{if(command!=='pause'){clearInspection();setPhase('running');phaseRef.current='running';}await request(command,{threadId:thread});}catch(e){report(e);if(command!=='pause'){setPhase('paused');phaseRef.current='paused';await selectThread(thread).catch(report);}}finally{setBusy(false);}}
 async function evaluate(expression:string,context='watch'){const mark=epoch.current;const reply=await request('evaluate',{expression,frameId:frame?.id,context});if(mark===epoch.current)setEvaluation(String(reply.result??''));}
 async function setVariable(reference:number,name:string,value:string){const mark=epoch.current;await request('setVariable',{variablesReference:reference,name,value,format:{hex:false}});if(mark===epoch.current)await loadVariables(reference);}
 return {stopReason,phase,error,output,caps,points,threads,thread,frames,frame,scopes,variables,evaluation,busy,start,stop,changePoints,toggle,selectThread,selectFrame,loadVariables,control,evaluate,setVariable,report,root};
}
