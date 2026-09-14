import {useState} from 'react';
import {compareSnapshots} from './debugInspection';
import DiagnosticExport from './DiagnosticExport';
import type {useDebugger} from './useDebugger';
export default function DebugToolsPanel({debug}:{debug:ReturnType<typeof useDebugger>}){
 const t=debug.tools,[expression,setExpression]=useState(''),[before,setBefore]=useState(''),[after,setAfter]=useState(''),[reference,setReference]=useState(''),[count,setCount]=useState(128);
 const call=(fn:()=>Promise<unknown>)=>void fn().catch(debug.report),paused=debug.phase==='paused';
 const old=t.snapshots.find(s=>String(s.id)===before),current=t.snapshots.find(s=>String(s.id)===after),diff=old&&current?compareSnapshots(old,current):undefined;
 return <>
 <details open><summary>Watches and pause snapshots</summary>
 <form onSubmit={e=>{e.preventDefault();try{t.addWatch(expression);setExpression('');}catch(e){debug.report(e);}}}><label>Watch expression<input value={expression} onChange={e=>setExpression(e.target.value)}/></label><button disabled={!expression.trim()||t.watches.length>=20}>Add watch</button></form>
 <label className="check"><input type="checkbox" checked={t.automatic} onChange={e=>t.setAutomatic(e.target.checked)}/> Evaluate watches automatically on pause (expressions may execute target code)</label>
 <button disabled={!paused||t.refreshing} onClick={()=>call(t.refresh)}>Refresh watches and capture snapshot</button>
 {t.watches.map(expression=>{const value=t.values.find(v=>v.expression===expression);return <div key={expression}><code>{expression}</code>: {value?.error??value?.value??'Not evaluated'} {value?.type}<button onClick={()=>t.removeWatch(expression)}>Remove {expression}</button></div>;})}
 <p>Snapshots contain fetched values and the source file’s disk fingerprint. They are historical observations.</p>
 {(['Before snapshot','After snapshot'] as const).map((label,i)=><label key={label}>{label}<select value={i?after:before} onChange={e=>(i?setAfter:setBefore)(e.target.value)}><option value="">Select a snapshot</option>{t.snapshots.map(s=><option key={s.id} value={s.id}>#{s.id} {s.location}</option>)}</select></label>)}
 {old&&current&&(diff?<div>{diff.map(d=><p key={d.expression}><code>{d.expression}</code> · {d.changed?'Changed':'Unchanged'}<br/>{d.before} → {d.after}</p>)}<details><summary>Captured variables before / after</summary><pre>{old.variables}</pre><pre>{current.variables}</pre>{(old.truncated||current.truncated)&&<p>Variable capture truncated.</p>}</details></div>:<p>Snapshots have different frame/thread/source versions, or a source fingerprint is unavailable.</p>)}
 </details>
 <details><summary>Exception investigation</summary><button disabled={!paused||!debug.caps.supportsExceptionInfoRequest} onClick={()=>call(t.exceptionInfo)}>Load exception details</button>{!debug.caps.supportsExceptionInfoRequest&&<p>Adapter does not advertise exception details.</p>}<pre>{t.exception}</pre></details>
 <details><summary>Data breakpoints</summary><p>Use “Break on write” beside a variable to watch for changes.</p>{!debug.caps.supportsDataBreakpoints&&<p>Adapter does not advertise data breakpoints.</p>}{t.dataPoints.map(p=><p key={p.dataId}>{p.name} · {p.verified?'Verified':'Unverified'} {p.message}</p>)}<button disabled={!paused||!t.dataPoints.length} onClick={()=>call(t.clearDataPoints)}>Clear data breakpoints</button></details>
 <details><summary>Memory and disassembly</summary><label>Memory / instruction reference<input value={reference} onChange={e=>setReference(e.target.value)}/></label><label>Bytes (1–4096)<input type="number" min="1" max="4096" value={count} onChange={e=>setCount(Number(e.target.value))}/></label><button disabled={!paused||!debug.caps.supportsReadMemoryRequest} onClick={()=>call(()=>t.readMemory(reference,count))}>Read memory</button><button disabled={!paused||!debug.caps.supportsDisassembleRequest} onClick={()=>call(()=>t.disassemble(reference))}>Disassemble 100 instructions</button><p>Memory data includes hexadecimal bytes, base64, its address and unreadable-byte count. Unsupported operations are disabled.</p><pre>{t.memory}</pre>{t.instructions.map((ins,i)=><pre key={i}>{ins.address} {ins.instructionBytes} {ins.instruction} {ins.symbol}</pre>)}</details>
 <details><summary>Debugger timeline ({t.trace.length} events / requests)</summary><p>Last 500 entries. Request duration includes native transport and adapter time. Pending requests remain visible until completion.</p><ol>{t.trace.map(e=><li key={e.id}>{(e.elapsedMs/1000).toFixed(3)}s · {e.kind} {e.name} · {e.state}{e.durationMs!==undefined?` · ${e.durationMs.toFixed(0)}ms`:''} {e.detail}</li>)}</ol></details>
 <DiagnosticExport sections={{timeline:t.trace,snapshots:t.snapshots,output:debug.output,capabilities:debug.caps}}/>
 </>;
}
