import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
type GitFile={path:string;originalPath:string|null;index:string;worktree:string};
type GitStatus={branch:string;files:GitFile[]};
const statusName=(code:string)=>({M:'modified',A:'added',D:'deleted',R:'renamed',C:'copied',U:'conflict','?':'untracked',' ':'unchanged'}[code]??code);
export default function GitPanel({root,onOpen,dirty}:{root:string;onOpen:(path:string)=>void;dirty:boolean}){
 const [snapshot,setSnapshot]=useState<GitStatus|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[diff,setDiff]=useState(''),[selection,setSelection]=useState('');
 const [message,setMessage]=useState(''),[reviewed,setReviewed]=useState<{tree:string;diff:string}|null>(null);
 const generation=useRef(0),diffHeading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{if(selection)diffHeading.current?.focus();},[selection,diff]);
 async function refresh(){
  const id=++generation.current;setBusy(true);setReviewed(null);setStatus('Reading repository…');
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
 async function stage(file:GitFile,stage:boolean){
  setBusy(true);setReviewed(null);
  try{await invoke('git_stage',{root,path:file.path,stage});await refresh();}catch(e){setStatus(String(e));}finally{setBusy(false);}
 }
 async function reviewStaged(){
  setBusy(true);
  try{const result=await invoke<{tree:string;diff:string}>('git_review_staged',{root});setReviewed(result);setSelection('All staged changes');setDiff(result.diff);setStatus('Review the staged diff, then commit.');}
  catch(e){setReviewed(null);setStatus(String(e));}finally{setBusy(false);}
 }
 async function commit(){
  if(!reviewed)return;
  setBusy(true);
  try{const result=await invoke<string>('git_commit',{root,message,tree:reviewed.tree});setMessage('');await refresh();setStatus(result);}
  catch(e){setReviewed(null);setStatus(String(e));}finally{setBusy(false);}
 }
 return <section className="workbench-page"><h1>Source control</h1><p>{root||'Open a repository folder to begin.'}</p>
  {dirty&&<p>Git reads files on disk. Save unsaved buffers before staging changes.</p>}
  <button disabled={!isTauri()||!root||busy} onClick={()=>void refresh()}>Refresh Git</button>
  <p role="status">{status}</p>{snapshot&&<><h2>{snapshot.branch}</h2>
  <ul className="git-files">{snapshot.files.map(file=><li key={file.path}><strong>{file.path}</strong>{file.originalPath&&<span> (from {file.originalPath})</span>}
   <p>Index: {statusName(file.index)} · Working tree: {statusName(file.worktree)}</p>
   <button disabled={busy||dirty||file.worktree===' '} onClick={()=>void stage(file,true)} aria-label={'Stage file: '+file.path}>Stage file</button>
   <button disabled={busy||file.index==='?'||file.index===' '} onClick={()=>void stage(file,false)} aria-label={'Unstage file: '+file.path}>Unstage file</button>
   <button disabled={busy} onClick={()=>void review(file,false)} aria-label={'Working diff: '+file.path}>Working diff</button>
   <button disabled={busy||file.index==='?'||file.index===' '} onClick={()=>void review(file,true)} aria-label={'Staged diff: '+file.path}>Staged diff</button>
   <button disabled={file.worktree==='D'||file.index==='D'} onClick={()=>onOpen(root+'/'+file.path)} aria-label={'Open file: '+file.path}>Open file</button>
  </li>)}</ul></>}
  {snapshot&&<section aria-label="Commit staged changes"><h2>Commit</h2><label>Commit message<textarea value={message} onChange={e=>setMessage(e.target.value)} disabled={busy}/></label>
   <p>Commits contain the staged files you review here. Configured Git hooks run during commit.</p>
   <button disabled={busy} onClick={()=>void reviewStaged()}>Review all staged changes</button>
   <button disabled={busy||!reviewed||!message.trim()} onClick={()=>void commit()}>Commit reviewed changes</button>
  </section>}
  {selection&&<section aria-label="Git diff"><h2 ref={diffHeading} tabIndex={-1}>{selection}</h2><pre aria-label={selection+' diff'} tabIndex={0} className="git-diff">{diff}</pre></section>}
 </section>;
}
