import {useState} from 'react';
import {usePersistedState} from './usePersistedState';
export default function StartupRecovery({error}:{error?:string}){
 const [scratch,setScratch]=usePersistedState('scratch.v2','');
 const [status,setStatus]=useState('');
 return <main className="startup-recovery"><h1>AfterEdit recovery</h1>
  <p role="alert">{error||'Recovery mode: the editor engine, extensions and project session are not loaded.'}</p>
  <p>Your saved preferences and project session are preserved. This plain-text editor edits the local scratch buffer.</p>
  <label>Recovery scratch buffer<textarea value={scratch} onChange={e=>setScratch(e.target.value)} spellCheck={false}/></label>
  <button onClick={()=>{location.search='';}}>Retry normal startup</button>
  <button onClick={()=>{void navigator.clipboard.writeText(scratch).then(()=>setStatus('Scratch copied')).catch(()=>setStatus('Copy unavailable. Select the text and copy it with the keyboard.'));}}>Copy scratch</button>
  <p role="status">{status}</p>
  {error&&<details><summary>Startup error details</summary><pre>{error}</pre></details>}
 </main>;
}
