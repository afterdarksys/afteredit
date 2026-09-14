import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {createDebugJournal,withDeadline,memoryArguments,type WatchValue,type PauseSnapshot} from './debugInspection';
export function useDebugTools(context:{root:string;phase:string;frame:any;thread?:number;frames:any[];variables:Record<number,any[]>;caps:Record<string,any>},request:(command:string,args:Record<string,any>)=>Promise<any>){
 const journal=useRef(createDebugJournal()).current;
 const trace=useSyncExternalStore(journal.subscribe,journal.getSnapshot);
 const [watches,setWatches]=useState<string[]>([]),[values,setValues]=useState<WatchValue[]>([]),[automatic,setAutomatic]=useState(false),[refreshing,setRefreshing]=useState(false);
 const [snapshots,setSnapshots]=useState<PauseSnapshot[]>([]),[exception,setException]=useState(''),[memory,setMemory]=useState(''),[instructions,setInstructions]=useState<any[]>([]),[dataPoints,setDataPoints]=useState<any[]>([]);
 const epoch=useRef(0), counter=useRef(0), current=useRef(context);current.current=context;
 const invalid=()=>{epoch.current++;setValues([]);setException('');setMemory('');setInstructions([]);setRefreshing(false);};
 useEffect(()=>{invalid();},[context.phase,context.frame,context.thread]);
 useEffect(()=>{epoch.current++;setWatches([]);setSnapshots([]);setDataPoints([]);setAutomatic(false);journal.reset();},[context.root]);
 function requirePause(capability?:string){if(current.current.phase!=='paused'||!current.current.frame)throw new Error('Pause and select a frame first');if(capability&&!current.current.caps[capability])throw new Error(`Adapter does not support ${capability}`);}
 async function refresh(){
  requirePause();const mark=++epoch.current,c=current.current;setRefreshing(true);const result:WatchValue[]=[];const start=performance.now();
  try{
   for(const expression of watches){
    if(mark!==epoch.current)return;
    if(performance.now()-start>8000){result.push({expression,error:'Inspection budget exceeded'});continue;}
    try{const reply=await withDeadline(request('evaluate',{expression,frameId:c.frame.id,context:'watch'}));result.push({expression,value:String(reply.result??'').slice(0,8000),type:reply.type});}
    catch(error){result.push({expression,error:String(error)});}
    if(mark!==epoch.current)return;setValues([...result]);
   }
   let revision='';
   if(c.frame.source?.path){try{const text=await withDeadline(invoke<string>('read_file',{path:c.frame.source.path}));const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));revision=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}catch{}}
   if(mark!==epoch.current)return;
   const variables=JSON.stringify(c.variables,null,2);
   const snapshot:PauseSnapshot={id:++counter.current,time:Date.now(),context:JSON.stringify([c.root,c.thread,c.frame.source?.path,c.frame.name,c.frames.findIndex(f=>f.id===c.frame.id)]),revision,location:`${c.frame.source?.path??'Unknown source'}:${c.frame.line}`,values:result,variables:variables.slice(0,16000),truncated:variables.length>16000};
   setSnapshots(v=>{const next=[...v,snapshot].slice(-40);while(next.length>1&&JSON.stringify(next).length>2*1024*1024)next.shift();return next;});
  }finally{if(mark===epoch.current)setRefreshing(false);}
 }
 useEffect(()=>{if(automatic&&context.phase==='paused'&&context.frame)void refresh().catch(()=>{});},[automatic,context.frame,context.phase]);
 const addWatch=(expression:string)=>{expression=expression.trim();if(!expression||expression.length>2000)throw new Error('Watch must be 1–2,000 characters');setWatches(v=>v.includes(expression)?v:[...v,expression].slice(0,20));};
 async function exceptionInfo(){requirePause('supportsExceptionInfoRequest');const mark=epoch.current;const result=await request('exceptionInfo',{threadId:current.current.thread});if(mark===epoch.current)setException(JSON.stringify(result,null,2).slice(0,32000));}
 async function readMemory(reference:string,count:number){requirePause('supportsReadMemoryRequest');const args=memoryArguments(reference,count),mark=epoch.current;const reply=await request('readMemory',args);if(mark===epoch.current)setMemory(JSON.stringify({...reply,hex:typeof reply.data==='string'?Array.from(atob(reply.data).slice(0,4096),c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join(' '):undefined},null,2).slice(0,24000));}
 async function disassemble(reference:string){requirePause('supportsDisassembleRequest');if(!reference.trim())throw new Error('Supply an instruction reference');const mark=epoch.current;const reply=await request('disassemble',{memoryReference:reference,instructionCount:100,resolveSymbols:true});if(mark===epoch.current)setInstructions((reply.instructions??[]).slice(0,100));}
 async function dataBreakpoint(reference:number,name:string){
  requirePause('supportsDataBreakpoints');const mark=epoch.current;
  const info=await request('dataBreakpointInfo',{variablesReference:reference,name,frameId:current.current.frame.id});
  if(mark!==epoch.current)return;if(!info.dataId)throw new Error(info.description||'This variable cannot be watched for writes');
  if(info.accessTypes&&!info.accessTypes.includes('write'))throw new Error('Adapter does not support write access for this variable');
  const next=[...dataPoints.filter(p=>p.dataId!==info.dataId),{dataId:info.dataId,accessType:'write',name}].slice(-20);
  const reply=await request('setDataBreakpoints',{breakpoints:next.map(({dataId,accessType})=>({dataId,accessType}))});
  if(mark===epoch.current)setDataPoints(next.map((p,i)=>({...p,verified:reply.breakpoints?.[i]?.verified===true,message:reply.breakpoints?.[i]?.message})));
 }
 async function clearDataPoints(){requirePause('supportsDataBreakpoints');const mark=epoch.current;await request('setDataBreakpoints',{breakpoints:[]});if(mark===epoch.current)setDataPoints([]);}
 function reset(){invalid();journal.reset();setSnapshots([]);setDataPoints([]);}
 return {journal,trace,watches,values,automatic,setAutomatic,refreshing,refresh,addWatch,removeWatch:(expression:string)=>{epoch.current++;setRefreshing(false);setWatches(v=>v.filter(x=>x!==expression));setValues(v=>v.filter(x=>x.expression!==expression));},snapshots,exception,exceptionInfo,memory,readMemory,instructions,disassemble,dataPoints,dataBreakpoint,clearDataPoints,reset,invalid};
}
