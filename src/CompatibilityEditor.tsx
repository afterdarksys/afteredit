import { useAccessibility } from './AccessibilityContext';
import { accessibleEditorOptions, accessibleEditorTheme } from './accessibility';
import { cycleRegion } from './focus';
import { useEffect, useRef, useState } from 'react';
import type { Extension } from './extensions';
import { languageForFilename } from './languages';
import { editorOptions, type EditorPreferences } from './preferences';
type Props={path:string;value:string;onChange:(value:string)=>void;onSave:()=>void;options:EditorPreferences;extensions:Extension[]};
export default function CompatibilityEditor(props:Props){
 const accessibility=useAccessibility();
 const accessRef=useRef(accessibility);accessRef.current=accessibility;
 const frame=useRef<HTMLIFrameElement>(null),latest=useRef(props);latest.current=props;
 const [status,setStatus]=useState('Starting extension host…'),[ready,setReady]=useState(false);
 const revision=useRef(0),lastPath=useRef(props.path);
 const send=(data:object)=>frame.current?.contentWindow?.postMessage({source:'afteredit-shell',...data},location.origin);
 const document=()=>{const p=latest.current;return {path:p.path,value:p.value,language:languageForFilename(p.path),options:{...editorOptions(p.options),...accessibleEditorOptions(accessRef.current,p.path)},theme:accessibleEditorTheme(accessRef.current,p.options.theme),revision:revision.current};};
 useEffect(()=>{
  const timer=setTimeout(()=>setStatus('If the host has not started, return to the standard editor using Extensions. Your buffer is retained.'),30000);
  const receive=(e:MessageEvent)=>{
   if(e.source!==frame.current?.contentWindow||e.origin!==location.origin||e.data?.source!=='afteredit-compat')return;
   const data=e.data;
   if(data.type==='cycle-region')cycleRegion(data.backward===true);
   if(data.type==='boot')send({type:'init',...document(),extensions:latest.current.extensions});
   if(data.type==='ready'){clearTimeout(timer);setReady(true);setStatus('Compatibility editor ready · run a command to test extension activation');send({type:'document',...document()});}
   if(data.type==='error'||data.type==='command-result')setStatus(String(data.message));
   if(data.type==='change'&&data.path===latest.current.path&&data.revision===revision.current&&typeof data.value==='string'&&data.value.length<=8*1024*1024){latest.current.onChange(data.value);}
   if(data.type==='save'&&data.path===latest.current.path)latest.current.onSave();
  };
  window.addEventListener('message',receive);return()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
 },[]);
 useEffect(()=>{
  if(lastPath.current!==props.path){lastPath.current=props.path;revision.current++;}
  if(ready){send({type:'document',...document()});}
 },[props.path,props.value,props.options,ready,accessibility]);
 const commands=props.extensions.filter(e=>e.enabled&&e.web).flatMap(e=>{const c=e.web!.manifest.contributes?.commands;return (Array.isArray(c)?c:[]).filter(c=>typeof c.command==='string').map(c=>({id:c.command,title:String(c.title??c.command)}));});
 return <div className="editor-host"><div className="keymap-status"><strong>Experimental VS Code editor</strong> · Standard bindings; native LSP and Vim/Emacs use the regular editor. <button onClick={props.onSave}>Save</button>{commands.length>0&&<select aria-label="Run extension command" disabled={!ready} value="" onChange={e=>send({type:'command',command:e.target.value})}><option value="">Run extension command…</option>{commands.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select>}</div><iframe ref={frame} title="VS Code extension editor" onLoad={()=>send({type:'init',...document(),extensions:latest.current.extensions})} src="/compat.html" style={{border:0,width:'100%',flex:1,minHeight:0}}/><div className="keymap-status" role="status">{status}</div></div>;
}
