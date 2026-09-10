import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { serverPresets, type ServerConfig, type ConnectedServer } from './languageServices';
export default function LanguagePanel({root,configured,connected,onChange}:{root:string;configured:Record<string,ServerConfig>;connected:ConnectedServer[];onChange:(servers:ConnectedServer[])=>void}){
 const [language,setLanguage]=useState('rust'),[draft,setDraft]=useState(JSON.stringify(configured.rust??serverPresets.rust,null,2)),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 async function connect(){setBusy(true);let id:number|undefined;try{
  const options:ServerConfig=JSON.parse(draft);if(typeof options.command!=='string'||!Array.isArray(options.args)||!options.args.every(a=>typeof a==='string'))throw new Error('Supply a command and argument array');
  const started=await invoke<{id:number;root_uri:string}>('lsp_start',{root,command:options.command,args:options.args,env:options.env??{}});id=started.id;
  const result=await invoke<{capabilities:ConnectedServer['capabilities']}>('lsp_request',{session:id,method:'initialize',params:{processId:null,rootUri:started.root_uri,workspaceFolders:[{uri:started.root_uri,name:root.split(/[\\/]/).pop()}],capabilities:{general:{positionEncodings:['utf-16']},textDocument:{synchronization:{didSave:true},completion:{completionItem:{snippetSupport:true}},hover:{contentFormat:['markdown','plaintext']},publishDiagnostics:{versionSupport:true}}},initializationOptions:options.initializationOptions??null,clientInfo:{name:'AfterEdit',version:'0.1.0'}}});
  if(result.capabilities.positionEncoding && result.capabilities.positionEncoding!=='utf-16')throw new Error('Server must use UTF-16 positions');
  await invoke('lsp_notify',{session:id,method:'initialized',params:{}});
  onChange([...connected,{...started,root,language,documentLanguage:options.documentLanguage,capabilities:result.capabilities}]);setStatus(`Connected ${language}`);
 }catch(e){if(id!==undefined)await invoke('lsp_stop',{session:id}).catch(()=>{});setStatus(String(e));}finally{setBusy(false);}}
 return <section className="workbench-page"><h1>Language services</h1><p>Connect installed language servers for diagnostics, completions, hover, go-to-definition and formatting. Servers can read the project and execute their own toolchain helpers. Connect only executables you trust. Server presets are starting points; set an absolute command path when needed.</p>
 <label>Language<select value={language} onChange={e=>{setLanguage(e.target.value);setDraft(JSON.stringify(configured[e.target.value]??serverPresets[e.target.value],null,2));}}>{Object.keys({...serverPresets,...configured}).map(l=><option key={l}>{l}</option>)}</select></label>
 <button onClick={()=>{setLanguage('hcl');setDraft(JSON.stringify({command:'tofu-ls',args:['serve'],documentLanguage:'opentofu'},null,2));}}>OpenTofu language server</button>
 <label>Server command, arguments, environment and initializationOptions<textarea rows={9} value={draft} onChange={e=>setDraft(e.target.value)}/></label><button disabled={!root||busy||connected.some(s=>s.root===root&&s.language===language)} onClick={()=>void connect()}>Connect server</button><p role="status">{status}</p>
 {connected.map(s=><div className="task-row" key={s.id}><div><strong>{s.language}</strong><p>{s.root}</p><small>{['completionProvider','hoverProvider','definitionProvider','documentFormattingProvider'].filter(k=>s.capabilities[k]).join(' · ')}</small></div><button onClick={()=>{void invoke('lsp_stop',{session:s.id}).then(()=>onChange(connected.filter(c=>c.id!==s.id))).catch(e=>setStatus(String(e)));}}>Disconnect</button></div>)}
 <p>Store server definitions under languageServers in .afteredit.json for project/directory overrides. Up to eight servers may be connected. Dynamic capability registration, code actions, semantic tokens are not yet supported. Native debugging is available in Run and debug.</p></section>;
}
