import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/suggest/browser/suggestController';
import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/hover/browser/hoverContribution';
import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/format/browser/formatActions';
import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/find/browser/findController';
import getEditors from '@codingame/monaco-vscode-editor-service-override';
import getLanguages from '@codingame/monaco-vscode-languages-service-override';
import getConfiguration from '@codingame/monaco-vscode-configuration-service-override';
import getKeybindings from '@codingame/monaco-vscode-keybindings-service-override';
import getNotifications from '@codingame/monaco-vscode-notifications-service-override';
import { initialize, getService, ICommandService } from '@codingame/monaco-vscode-api';
import { registerExtension, ExtensionHostKind, type IExtensionManifest } from '@codingame/monaco-vscode-api/extensions';
import getExtensions from '@codingame/monaco-vscode-extensions-service-override';
import getModels from '@codingame/monaco-vscode-model-service-override';
import * as monaco from '@codingame/monaco-vscode-editor-api';
import { WebWorkerService } from '@codingame/monaco-vscode-api/vscode/vs/platform/webWorker/browser/webWorkerServiceImpl';
import { IWebWorkerService } from '@codingame/monaco-vscode-api/vscode/vs/platform/webWorker/browser/webWorkerService.service';
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors';
import editorWorker from '@codingame/monaco-vscode-api/workers/editor.worker?worker&url';
import extensionWorker from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url';
import iframeUrl from '../../node_modules/@codingame/monaco-vscode-extensions-service-override/vscode/src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html?url';
import type { Extension } from '../extensions';
class Workers extends WebWorkerService {
 override getWorkerUrl(descriptor:any){return new URL(descriptor.label==='extensionHostWorkerMain'?extensionWorker:descriptor.label==='webWorkerExtensionHostIframe'?iframeUrl:editorWorker,location.href).href;}
 override getWorkerOptions(){return {type:'module' as const};}
}
const status=document.getElementById('status')!;
const send=(data:object)=>parent.postMessage({source:'afteredit-compat',...data},location.origin);
let editor:monaco.editor.IStandaloneCodeEditor|undefined;
let path='',applying=false;
let revision=0;
const report=(e:unknown)=>{status.textContent=String(e);send({type:'error',message:String(e)});};
window.addEventListener('error',e=>report(e.message));
window.addEventListener('unhandledrejection',e=>report(e.reason));
async function start(data:any){
 await initialize({...getExtensions({enableWorkerExtensionHost:true}),...getModels(),...getEditors(async()=>undefined),...getLanguages(),...getConfiguration(),...getKeybindings(),...getNotifications(),[IWebWorkerService.toString()]:new SyncDescriptor(Workers)});
 for(const extension of (data.extensions as Extension[]).filter(e=>e.enabled&&e.web)){
  const registered=registerExtension(extension.web!.manifest as IExtensionManifest,ExtensionHostKind.LocalWebWorker);
  for(const [file,base64] of Object.entries(extension.web!.files)){
   const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
   const url=URL.createObjectURL(new Blob([bytes],{type:file.endsWith('.js')?'text/javascript':'application/octet-stream'}));
   registered.registerFileUrl(file,url);
  }
  await registered.whenReady();
 }
 editor=monaco.editor.create(document.getElementById('editor')!,{automaticLayout:true,theme:'vs-dark'});
 setDocument(data);
 editor.onDidChangeModelContent(()=>{if(!applying)send({type:'change',path,value:editor!.getValue(),revision});});
 editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>send({type:'save',path}));
 status.textContent='Experimental · web extensions · current buffer only';
 send({type:'ready'});
}
function setDocument(data:any){
 if(!editor)return;
 applying=true;
 try{
  path=data.path;revision=data.revision;
  const uri=monaco.Uri.parse(path.includes('://')?path:monaco.Uri.file(path).toString());
  let model=monaco.editor.getModel(uri);
  if(!model)model=monaco.editor.createModel(data.value,data.language,uri);
  else if(model.getValue()!==data.value)model.setValue(data.value);
  const previous=editor.getModel();
  editor.setModel(model);
  if(previous&&previous!==model)previous.dispose();
  if(data.options)editor.updateOptions(data.options);
 }finally{applying=false;}
}
let started=false;
window.addEventListener('message',event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.source!=='afteredit-shell')return;
 const data=event.data;
 if(data.type==='init'&&!started){started=true;void start(data).catch(report);}
 if(data.type==='document')setDocument(data);
 if(data.type==='command'){editor?.focus();void getService(ICommandService).then(service=>service.executeCommand(data.command)).then(result=>send({type:'command-result',message:typeof result==='string'?result:'Command completed'})).catch(report);}
});
send({type:'boot'});
