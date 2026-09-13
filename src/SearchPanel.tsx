import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { workspaceSymbols, type WorkspaceSymbol } from './symbols';
import type { ConnectedServer } from './languageServices';
/** Monaco's SymbolKind order, 1-based as the protocol sends it. */
const SYMBOL_NAMES=['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','Enum member','Struct','Event','Operator','Type parameter'];
export default function SearchPanel({root,servers,onOpen}:{root:string;servers:ConnectedServer[];onOpen:(path:string,line:number)=>void}){
 const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const [mode,setMode]=useState<'text'|'symbol'>('text');
 const [hits,setHits]=useState<Array<{path:string;line:number;text:string}>>([]);
 const [symbols,setSymbols]=useState<WorkspaceSymbol[]>([]);
 // Only servers rooted in this project can answer for it.
 const symbolServers=servers.filter(server=>server.capabilities.workspaceSymbolProvider&&(root===server.root||root.startsWith(server.root+'/')||server.root.startsWith(root+'/')));
 async function search(){
  setBusy(true);setStatus('Searching…');
  try{
   if(mode==='symbol'){
    const found=await workspaceSymbols(symbolServers,query);
    setSymbols(found);setHits([]);
    setStatus(found.length?`${found.length} symbols from ${symbolServers.map(s=>s.language).join(', ')}`:'No symbols matched. The server may still be indexing.');
   }else{
    const r=await invoke<{hits:typeof hits;truncated:boolean}>('workspace_search',{root,query});
    setHits(r.hits);setSymbols([]);
    setStatus(`${r.hits.length} matches${r.truncated?' (search limit reached)':''}`);
   }
  }catch(e){setStatus(String(e));}finally{setBusy(false);}
 }
 return <section className="workbench-page"><h1>Search project</h1>
  <fieldset><legend>Search for</legend>
   <label><input type="radio" name="search-mode" checked={mode==='text'} onChange={()=>{setMode('text');setStatus('');}}/> Text</label>
   <label><input type="radio" name="search-mode" checked={mode==='symbol'} onChange={()=>{setMode('symbol');setStatus('');}} disabled={!symbolServers.length}/> Symbols{symbolServers.length?'':' (start a language server first)'}</label>
  </fieldset>
  <p>{mode==='text'
   ?'Literal, case-sensitive search. Generated/vendor directories, symlinks, binary files and files over 1 MiB are skipped.'
   :'Classes, methods and fields from the connected language servers. A server that is still indexing returns fewer results.'}</p>
  <form onSubmit={e=>{e.preventDefault();void search();}}><input aria-label={mode==='text'?'Project search':'Symbol search'} value={query} onChange={e=>setQuery(e.target.value)}/><button disabled={!root||!query||busy}>Search</button></form>
  <p role="status">{status}</p>
  {hits.map((hit,i)=><button className="search-hit" key={i} onClick={()=>onOpen(hit.path,hit.line)}><strong>{hit.path.slice(root.length+1)}:{hit.line}</strong><code>{hit.text}</code></button>)}
  {symbols.map((symbol,i)=><button className="search-hit" key={i} onClick={()=>onOpen(symbol.path,symbol.line)}><strong>{symbol.name}</strong><code>{SYMBOL_NAMES[symbol.kind-1]??'Symbol'}{symbol.container?` in ${symbol.container}`:''} · {symbol.path.startsWith(root+'/')?symbol.path.slice(root.length+1):symbol.path}:{symbol.line}</code></button>)}
 </section>;
}
