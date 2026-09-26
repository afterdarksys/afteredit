import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { workspaceSymbols, type WorkspaceSymbol } from './symbols';
import type { ConnectedServer } from './languageServices';
/** Monaco's SymbolKind order, 1-based as the protocol sends it. */
const SYMBOL_NAMES=['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','Enum member','Struct','Event','Operator','Type parameter'];
type Hit = {path:string;line:number;text:string};
type Hunk = {line:number;before:string;after:string};
type PreviewFile = {path:string;fingerprint:string;matches:number;hunks:Hunk[];hunks_truncated:boolean};
export default function SearchPanel({root,servers,onOpen,dirty=[],onReplaced}:{root:string;servers:ConnectedServer[];onOpen:(path:string,line:number)=>void;dirty?:string[];onReplaced?:(paths:string[])=>void}){
 const [query,setQuery]=useState(''),[replacement,setReplacement]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const [caseSensitive,setCaseSensitive]=useState(true),[regex,setRegex]=useState(false),[wholeWord,setWholeWord]=useState(false);
 const [include,setInclude]=useState(''),[exclude,setExclude]=useState('');
 const [mode,setMode]=useState<'text'|'symbol'>('text');
 const [hits,setHits]=useState<Hit[]>([]);
 const [preview,setPreview]=useState<PreviewFile[]>([]);
 const [symbols,setSymbols]=useState<WorkspaceSymbol[]>([]);
 const options={caseSensitive,regex,wholeWord,include,exclude};
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
    const r=await invoke<{hits:Hit[];truncated:boolean}>('workspace_search',{root,query,options});
    setHits(r.hits);setSymbols([]);setPreview([]);
    setStatus(`${r.hits.length} matches${r.truncated?' (search limit reached)':''}`);
   }
  }catch(e){setStatus(String(e));}finally{setBusy(false);}
 }
 async function previewReplace(){
  setBusy(true);setStatus('Preparing replacement…');
  try{
   const plan=await invoke<{files:PreviewFile[];truncated:boolean}>('workspace_replace_preview',{root,query,replacement,options});
   setPreview(plan.files);setHits([]);
   const count=plan.files.reduce((sum,file)=>sum+file.matches,0);
   setStatus(`${count} replacements in ${plan.files.length} files${plan.truncated?' (preview limit reached)':''}. Review them, then apply.`);
  }catch(e){setStatus(String(e));}finally{setBusy(false);}
 }
 async function applyReplace(){
  const dirtySet=new Set(dirty);
  const files=preview.filter(file=>!dirtySet.has(file.path));
  const blocked=preview.filter(file=>dirtySet.has(file.path));
  if(!files.length){setStatus(blocked.length?'Save or skip the unsaved files before replacing them.':'Nothing to replace.');return;}
  if(!window.confirm(`Replace text in ${files.length} file${files.length===1?'':'s'}?`))return;
  setBusy(true);
  try{
   const report=await invoke<{changed:string[];skipped:string[]}>('workspace_replace',{root,query,replacement,options,files:files.map(file=>({path:file.path,fingerprint:file.fingerprint}))});
   setPreview([]);
   onReplaced?.(report.changed);
   setStatus(`Updated ${report.changed.length} file${report.changed.length===1?'':'s'}${report.skipped.length?`; left unchanged: ${report.skipped.length}`:''}${blocked.length?`; unsaved files were not touched: ${blocked.length}`:''}.`);
  }catch(e){setStatus(String(e));}finally{setBusy(false);}
 }
 return <section className="workbench-page"><h1>Search project</h1>
  <fieldset><legend>Search for</legend>
   <label><input type="radio" name="search-mode" checked={mode==='text'} onChange={()=>{setMode('text');setStatus('');}}/> Text</label>
   <label><input type="radio" name="search-mode" checked={mode==='symbol'} onChange={()=>{setMode('symbol');setStatus('');}} disabled={!symbolServers.length}/> Symbols{symbolServers.length?'':' (start a language server first)'}</label>
  </fieldset>
  <p>{mode==='text'
   ?'Generated/vendor directories, symlinks, binary files and files over 1 MiB are skipped. A regex may use $1 when Whole word is off. Replacement writes only the files you review, and skips any file that changed or still has unsaved edits.'
   :'Classes, methods and fields from the connected language servers. A server that is still indexing returns fewer results.'}</p>
  <form onSubmit={e=>{e.preventDefault();void search();}}>
   <input aria-label={mode==='text'?'Project search':'Symbol search'} value={query} onChange={e=>setQuery(e.target.value)}/>
   <button disabled={!root||!query||busy}>Search</button>
   {mode==='text'&&<label>Replace<input aria-label="Replacement" value={replacement} onChange={e=>setReplacement(e.target.value)}/></label>}
   {mode==='text'&&<button type="button" disabled={!root||!query||busy} onClick={()=>void previewReplace()}>Preview replace</button>}
  </form>
  {mode==='text'&&<fieldset><legend>Match</legend>
   <label className="check"><input type="checkbox" checked={caseSensitive} onChange={e=>setCaseSensitive(e.target.checked)}/> Case sensitive</label>
   <label className="check"><input type="checkbox" checked={wholeWord} onChange={e=>setWholeWord(e.target.checked)}/> Whole word</label>
   <label className="check"><input type="checkbox" checked={regex} onChange={e=>setRegex(e.target.checked)}/> Regular expression</label>
   <label>Include<input aria-label="Include files" placeholder="*.rs, src/**" value={include} onChange={e=>setInclude(e.target.value)}/></label>
   <label>Exclude<input aria-label="Exclude files" placeholder="**/*.min.js" value={exclude} onChange={e=>setExclude(e.target.value)}/></label>
  </fieldset>}
  <p role="status">{status}</p>
  {hits.map((hit,i)=><button className="search-hit" key={i} onClick={()=>onOpen(hit.path,hit.line)}><strong>{hit.path.slice(root.length+1)}:{hit.line}</strong><code>{hit.text}</code></button>)}
  {preview.length>0&&<button type="button" disabled={busy} onClick={()=>void applyReplace()}>Apply reviewed replacement</button>}
  {preview.map(file=><div key={file.path}><h2>{file.path.slice(root.length+1)} · {file.matches}{file.hunks_truncated?' (more lines not shown)':''}</h2>{file.hunks.map(hunk=><p key={hunk.line}><button className="search-hit" onClick={()=>onOpen(file.path,hunk.line)}>{hunk.line}</button> <code>{hunk.before}</code> → <code>{hunk.after}</code></p>)}</div>)}
  {symbols.map((symbol,i)=><button className="search-hit" key={i} onClick={()=>onOpen(symbol.path,symbol.line)}><strong>{symbol.name}</strong><code>{SYMBOL_NAMES[symbol.kind-1]??'Symbol'}{symbol.container?` in ${symbol.container}`:''} · {symbol.path.startsWith(root+'/')?symbol.path.slice(root.length+1):symbol.path}:{symbol.line}</code></button>)}
 </section>;
}
