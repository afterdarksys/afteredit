import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
type GitFile={path:string;originalPath:string|null;index:string;worktree:string};
type GitStatus={branch:string;files:GitFile[]};
const statusName=(code:string)=>({M:'modified',A:'added',D:'deleted',R:'renamed',C:'copied',U:'conflict','?':'untracked',' ':'unchanged'}[code]??code);
export default function GitPanel({root,onOpen,dirty}:{root:string;onOpen:(path:string)=>void;dirty:boolean}){
 const [snapshot,setSnapshot]=useState<GitStatus|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[diff,setDiff]=useState(''),[selection,setSelection]=useState('');
 const generation=useRef(0);
 async function refresh(){
  const id=++generation.current;setBusy(true);setStatus('Reading repository…');
  try{const result=await invoke<GitStatus>('git_status',{root});if(id===generation.current){setSnapshot(result);setDiff('');setSelection('');setStatus(result.files.length+' changed files');}}
  catch(e){if(id===generation.current){setStatus(String(e));setSnapshot(null);}}
  finally{if(id===generation.current)setBusy(false);}
 }
 useEffect(()=>{if(root&&isTauri())void refresh();return()=>{generation.current++;};},[root]);
 async function review(file:GitFile,staged:boolean){
  const id=++generation.current;setBusy(true);
  try{const text=await invoke<string>('git_diff',{root,path:file.path,staged});if(id===generation.current){setDiff(text||'No changes in this view.');setSelection((staged?'Staged: ':'Working tree: ')+file.path);setStatus('Diff loaded');}}
  catch(e){if(id===generation.current)setStatus(String(e));}finally{if(id===generation.current)setBusy(false);}
 }
 return <section className="workbench-page"><h1>Source control</h1><p>{root||'Open a repository folder to begin.'}</p>
  {dirty&&<p>Git reads files on disk. Save unsaved buffers before staging changes.</p>}
  <button disabled={!isTauri()||!root||busy} onClick={()=>void refresh()}>Refresh Git</button>
  <p role="status">{status}</p>{snapshot&&<><h2>{snapshot.branch}</h2>
  <ul className="git-files">{snapshot.files.map(file=><li key={file.path}><strong>{file.path}</strong>{file.originalPath&&<span> (from {file.originalPath})</span>}
   <p>Index: {statusName(file.index)} · Working tree: {statusName(file.worktree)}</p>
   <button disabled={busy} onClick={()=>void review(file,false)}>Working diff</button>
   <button disabled={busy||file.index==='?'||file.index===' '} onClick={()=>void review(file,true)}>Staged diff</button>
   <button disabled={file.worktree==='D'||file.index==='D'} onClick={()=>onOpen(root+'/'+file.path)}>Open file</button>
  </li>)}</ul></>}
  {selection&&<section aria-label="Git diff"><h2>{selection}</h2><pre tabIndex={0} className="git-diff">{diff}</pre></section>}
 </section>;
}
