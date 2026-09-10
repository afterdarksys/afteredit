import {useEffect,useState} from 'react';
import {normalizeExtensionSettings} from './extensionSettings';
export default function ExtensionSettings({value,onChange}:{value:string;onChange:(value:string)=>void}){
 const [draft,setDraft]=useState(value),[status,setStatus]=useState('');
 useEffect(()=>setDraft(value),[value]);
 return <section><h2>Extension settings</h2><p>These personal VS Code settings persist across editor restarts. Extensions can update them through the VS Code configuration API. Store API keys in the assistant's key field, not here.</p>
 <label>Extension settings JSON<textarea rows={8} value={draft} onChange={e=>setDraft(e.target.value)}/></label>
 <button onClick={()=>{try{onChange(normalizeExtensionSettings(draft));setStatus('Extension settings saved');}catch(e){setStatus(String(e));}}}>Save extension settings</button><p role="status">{status}</p>
 </section>;
}
