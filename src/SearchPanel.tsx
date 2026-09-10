import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
export default function SearchPanel({root,onOpen}:{root:string;onOpen:(path:string,line:number)=>void}){
 const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const [hits,setHits]=useState<Array<{path:string;line:number;text:string}>>([]);
 async function search(){setBusy(true);setStatus('Searching…');try{const r=await invoke<{hits:typeof hits;truncated:boolean}>('workspace_search',{root,query});setHits(r.hits);setStatus(`${r.hits.length} matches${r.truncated?' (search limit reached)':''}`);}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 return <section className="workbench-page"><h1>Search project</h1><p>Literal, case-sensitive search. Generated/vendor directories, symlinks, binary files and files over 1 MiB are skipped.</p><form onSubmit={e=>{e.preventDefault();void search();}}><input aria-label="Project search" value={query} onChange={e=>setQuery(e.target.value)}/><button disabled={!root||!query||busy}>Search</button></form><p role="status">{status}</p>{hits.map((hit,i)=><button className="search-hit" key={i} onClick={()=>onOpen(hit.path,hit.line)}><strong>{hit.path.slice(root.length+1)}:{hit.line}</strong><code>{hit.text}</code></button>)}</section>;
}
