import { useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { importVSIX, type Extension } from './extensions';
export default function ExtensionsPanel({extensions,onChange,onTheme}:{extensions:Extension[];onChange:(next:Extension[])=>void;onTheme:(id:string)=>void}) {
 const [query,setQuery]=useState(''); const [results,setResults]=useState<Array<{namespace:string;name:string;displayName?:string;description?:string}>>([]);
 const [status,setStatus]=useState(''); const [busy,setBusy]=useState(false);
 const install=(bytes:Uint8Array)=>{const entry=importVSIX(bytes);onChange([...extensions.filter(e=>e.id!==entry.id),entry]);setStatus(`Installed ${entry.id} ${entry.version}`);};
 async function search(){setBusy(true);try{const r=await invoke<{extensions:typeof results}>('registry_search',{query});setResults(r.extensions??[]);}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 async function download(namespace:string,name:string){setBusy(true);try{const data=await invoke<string>('registry_download',{namespace,name});install(Uint8Array.from(atob(data),c=>c.charCodeAt(0)));}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 return <section className="workbench-page"><h1>Extensions</h1><p>Import VSIX themes and snippets or find them on Open VSX. Executable extensions, language grammars and debuggers require additional compatibility work and are rejected. TextMate token colors are mapped on a best-effort basis.</p>
 <label>Import .vsix<input type="file" accept=".vsix" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;try{if(file.size>20*1024*1024)throw new Error('VSIX exceeds 20 MiB');install(new Uint8Array(await file.arrayBuffer()));}catch(err){setStatus(String(err));}}}/></label>
 <div className="field-row"><input aria-label="Search Open VSX" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search Open VSX for themes or snippets"/><button disabled={busy||!isTauri()} onClick={()=>void search()}>Search Open VSX</button></div><p role="status">{status}</p>
 {extensions.map(entry=><div className="task-row" key={entry.id}><div><strong>{entry.id} · {entry.version}</strong><p>{entry.themes.length} themes · {entry.snippets.length} snippets</p>{entry.enabled&&entry.themes.map(theme=><button key={theme.id} onClick={()=>onTheme(theme.id)}>Use {theme.label}</button>)}</div><div><button onClick={()=>onChange(extensions.map(e=>e.id===entry.id?{...e,enabled:!e.enabled}:e))}>{entry.enabled?'Disable':'Enable'}</button><button onClick={()=>onChange(extensions.filter(e=>e.id!==entry.id))}>Remove</button></div></div>)}
 {results.map(entry=><div className="task-row" key={entry.namespace+'.'+entry.name}><div><strong>{entry.displayName??entry.name}</strong><p>{entry.namespace}.{entry.name} · {entry.description}</p></div><button disabled={busy} onClick={()=>void download(entry.namespace,entry.name)}>Import supported contributions</button></div>)}
 </section>;
}
