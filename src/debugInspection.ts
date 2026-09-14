export type TraceEntry = { id:number; elapsedMs:number; kind:'request'|'event'; name:string; state:'pending'|'ok'|'error'; durationMs?:number; detail?:string };
export function createDebugJournal() {
  let entries:TraceEntry[]=[], next=0, started=performance.now(), generation=0;
  const listeners=new Set<()=>void>();
  const emit=()=>listeners.forEach(fn=>fn());
  return {
    getSnapshot:()=>entries,
    subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
    reset(){generation++;entries=[];started=performance.now();emit();},
    event(name:string,detail=''){entries=[...entries,{id:++next,elapsedMs:performance.now()-started,kind:'event' as const,name,state:'ok' as const,detail:detail.slice(0,1000)}].slice(-500);emit();},
    async request<T>(name:string,send:()=>Promise<T>):Promise<T>{
      const id=++next, mark=generation, start=performance.now();
      entries=[...entries,{id,elapsedMs:start-started,kind:'request' as const,name,state:'pending' as const}].slice(-500);emit();
      try{const value=await send();if(mark===generation){entries=entries.map(e=>e.id===id?{...e,state:'ok',durationMs:performance.now()-start}:e);emit();}return value;}
      catch(error){if(mark===generation){entries=entries.map(e=>e.id===id?{...e,state:'error',durationMs:performance.now()-start,detail:String(error).slice(0,1000)}:e);emit();}throw error;}
    }
  };
}
export type WatchValue={expression:string;value?:string;type?:string;error?:string};
export type PauseSnapshot={id:number;time:number;context:string;revision:string;location:string;values:WatchValue[];variables:string;truncated:boolean};
export function compareSnapshots(before:PauseSnapshot,after:PauseSnapshot){
  if(before.context!==after.context||!before.revision||before.revision!==after.revision)return undefined;
  return [...new Set([...before.values,...after.values].map(v=>v.expression))].map(expression=>{
    const old=before.values.find(v=>v.expression===expression), current=after.values.find(v=>v.expression===expression);
    return {expression,before:old?.error??old?.value??'Not captured',after:current?.error??current?.value??'Not captured',changed:JSON.stringify(old)!==JSON.stringify(current)};
  });
}
export async function withDeadline<T>(promise:Promise<T>,ms=2500):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Inspection timed out')),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}
export function memoryArguments(reference:string,count:number){if(!reference.trim()||!Number.isInteger(count)||count<1||count>4096)throw new Error('Supply a memory reference and 1–4096 bytes');return {memoryReference:reference,count};}
