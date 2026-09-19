import {useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import type {SecretFinding} from './policy';
import {redactSecretLines} from './secrets';
export default function DiagnosticExport({sections}:{sections:Record<string,unknown>}){
 const [selected,setSelected]=useState<string[]>([]),[preview,setPreview]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function prepare(){const text=JSON.stringify({format:'afteredit-diagnostics-v1',createdAt:new Date().toISOString(),...Object.fromEntries(selected.map(key=>[key,sections[key]]))},null,2);if(text.length>2*1024*1024){setError('Selection exceeds 2 MiB. Select fewer sections.');return;}
  if(!isTauri()){setPreview(text);setError('');return;}
  setBusy(true);setError('');
  try{const findings=await invoke<SecretFinding[]>('scan_buffer_secrets',{path:'diagnostics.json',text});setPreview(redactSecretLines(text,findings));}catch{setPreview('');setError('Secret scan did not complete; export is blocked.');}finally{setBusy(false);}
 }
 function download(){try{JSON.parse(preview);const url=URL.createObjectURL(new Blob([preview],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='afteredit-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{setError('Preview must contain valid JSON.');}}
 return <details><summary>Diagnostic export</summary><p>Select sections, review their contents, and remove any fields before downloading. Exports stay local. Lines that look like credentials are redacted.</p>{Object.keys(sections).map(key=><label className="check" key={key}><input type="checkbox" checked={selected.includes(key)} onChange={e=>{setSelected(v=>e.target.checked?[...v,key]:v.filter(k=>k!==key));setPreview('');}}/>{key}</label>)}<button disabled={!selected.length||busy} onClick={()=>void prepare()}>{busy?'Scanning…':'Prepare export preview'}</button>{preview&&<><textarea aria-label="Diagnostic export preview" rows={12} value={preview} onChange={e=>setPreview(e.target.value.slice(0,2*1024*1024))}/><button onClick={download}>Download reviewed JSON</button></>}<p role="alert">{error}</p></details>;
}
