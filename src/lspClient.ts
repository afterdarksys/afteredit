import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { decodeSemanticTokens, type ConnectedServer } from './languageServices';
import { applyTextEdits, confirmFileOperations, fileUriToPath, workspaceEditPlan, type FileEdits, type FileOperation } from './workspaceEdit';
const range=(r:any)=>new monaco.Range(r.start.line+1,r.start.character+1,r.end.line+1,r.end.character+1);
const lspRange=(r:monaco.IRange)=>({start:{line:r.startLineNumber-1,character:r.startColumn-1},end:{line:r.endLineNumber-1,character:r.endColumn-1}});
/** LSP SymbolKind is 1-based over the same list Monaco numbers from 0. */
const symbolKind=(kind:number)=>Math.max(0,(kind??1)-1) as monaco.languages.SymbolKind;
/** CompletionItemKind is not a shared ordering, so it needs a real table.
 *  Indexed by the LSP kind; anything unknown falls back to Text. */
const COMPLETION_KINDS:monaco.languages.CompletionItemKind[]=[
 monaco.languages.CompletionItemKind.Text,monaco.languages.CompletionItemKind.Method,monaco.languages.CompletionItemKind.Function,
 monaco.languages.CompletionItemKind.Constructor,monaco.languages.CompletionItemKind.Field,monaco.languages.CompletionItemKind.Variable,
 monaco.languages.CompletionItemKind.Class,monaco.languages.CompletionItemKind.Interface,monaco.languages.CompletionItemKind.Module,
 monaco.languages.CompletionItemKind.Property,monaco.languages.CompletionItemKind.Unit,monaco.languages.CompletionItemKind.Value,
 monaco.languages.CompletionItemKind.Enum,monaco.languages.CompletionItemKind.Keyword,monaco.languages.CompletionItemKind.Snippet,
 monaco.languages.CompletionItemKind.Color,monaco.languages.CompletionItemKind.File,monaco.languages.CompletionItemKind.Reference,
 monaco.languages.CompletionItemKind.Folder,monaco.languages.CompletionItemKind.EnumMember,monaco.languages.CompletionItemKind.Constant,
 monaco.languages.CompletionItemKind.Struct,monaco.languages.CompletionItemKind.Event,monaco.languages.CompletionItemKind.Operator,
 monaco.languages.CompletionItemKind.TypeParameter,
];
const completionKind=(kind:number)=>COMPLETION_KINDS[(kind??1)-1]??monaco.languages.CompletionItemKind.Text;
const markdown=(value:any):string|undefined=>typeof value==='string'?value:value?.value;
/** Command ids are global to Monaco, so each connection gets its own. */
let connectionCount=0;
export function connectModel(editor:monaco.editor.IStandaloneCodeEditor,path:string,server:ConnectedServer,onNavigate:(path:string,line:number)=>void,onError:(text:string)=>void,onWorkspaceEdit?:(files:FileEdits[])=>Promise<void>,onFileOperations?:(operations:FileOperation[])=>Promise<void>){
 const model=editor.getModel();if(!model)return ()=>{};
 const uri=monaco.Uri.file(path).toString();const disposables:monaco.IDisposable[]=[];let disposed=false;let version=1;
 const notify=(method:string,params:unknown)=>invoke('lsp_notify',{session:server.id,method,params});
 let sync=notify('textDocument/didOpen',{textDocument:{uri,languageId:server.documentLanguage??model.getLanguageId(),version,text:model.getValue()}}).catch(e=>onError(String(e)));
 const request=async(method:string,params:unknown)=>{await sync;if(disposed)return null;return invoke<any>('lsp_request',{session:server.id,method,params});};
 const parameters=(position:monaco.Position)=>({textDocument:{uri},position:{line:position.lineNumber-1,character:position.column-1}});
 // Servers legitimately report the same site twice (clangd answers from both
 // the AST and its index), and a references list with every entry doubled is
 // unreadable. Dedupe on file+range, keeping the first.
 const locations=(data:any)=>{
  const seen=new Set<string>();
  return (Array.isArray(data)?data:data?[data]:[]).flatMap((loc:any)=>{
   const target=loc.range??loc.targetSelectionRange;if(!target)return [];
   const key=`${loc.uri??loc.targetUri}:${target.start.line}:${target.start.character}:${target.end.line}:${target.end.character}`;
   if(seen.has(key))return [];
   seen.add(key);
   return [{uri:monaco.Uri.parse(loc.uri??loc.targetUri),range:range(target)}];
  });
 };
 const onSave=(event:Event)=>{const detail=(event as CustomEvent<{path:string;text:string}>).detail;if(detail.path===path)sync=sync.then(()=>notify('textDocument/didSave',{textDocument:{uri},text:detail.text})).catch(e=>onError(String(e)));};
 window.addEventListener('afteredit:saved',onSave);disposables.push({dispose:()=>window.removeEventListener('afteredit:saved',onSave)});
 const syncKind=typeof server.capabilities.textDocumentSync==='number'?server.capabilities.textDocumentSync:server.capabilities.textDocumentSync?.change;
 disposables.push(model.onDidChangeContent(event=>{const current=++version;const changes=syncKind===2?event.changes.map(c=>({range:lspRange(c.range),text:c.text})):[{text:model.getValue()}];sync=sync.then(()=>notify('textDocument/didChange',{textDocument:{uri,version:current},contentChanges:changes})).catch(e=>onError(String(e)));}));
 // The server's own diagnostics, kept as it sent them: quick fixes are
 // matched by the server against these, and a Monaco marker has lost the
 // fields (code, data) it needs to do that.
 let published:any[]=[];
 void listen<any>('lsp:notification',e=>{
  if(disposed||e.payload.session!==server.id)return;
  const message=e.payload.message;
  if(message.method==='afteredit/stopped'){onError(`${server.language} server stopped`);monaco.editor.setModelMarkers(model,`lsp-${server.id}`,[]);return;}
  if(message.method!=='textDocument/publishDiagnostics'||message.params?.uri!==uri)return;
  if(message.params.version!==undefined&&message.params.version<version)return;
  published=message.params.diagnostics??[];
  monaco.editor.setModelMarkers(model,`lsp-${server.id}`,published.map((d:any)=>({...range(d.range),message:d.message,severity:[monaco.MarkerSeverity.Error,monaco.MarkerSeverity.Warning,monaco.MarkerSeverity.Info,monaco.MarkerSeverity.Hint][(d.severity??1)-1]??monaco.MarkerSeverity.Info,source:d.source})));
 }).then(off=>{if(disposed)off();else disposables.push({dispose:off});}).catch(e=>onError(String(e)));

 /** Every workspace edit goes through here, in the server's order. The open
  *  file is edited in place so Undo still works, and its buffer is updated
  *  first so a following rename does not keep the old text. Other files land
  *  as unsaved buffers. File create, rename, and delete ask once, then run
  *  one step at a time. A bad edit throws before that confirm. */
 const applyEdit=async(edit:unknown)=>{
  const plan=workspaceEditPlan(edit);
  if(!plan.length)return;
  const operations=plan.filter((step):step is FileOperation=>step.kind!=='text');
  // Text-only refactors retain all-or-nothing validation across files.
  if(!operations.length){
   const files=plan.filter((step):step is Extract<typeof step,{kind:'text'}>=>step.kind==='text');
   const here=files.filter(file=>file.path===path),elsewhere=files.filter(file=>file.path!==path);
   if(elsewhere.length&&!onWorkspaceEdit)throw new Error('This build cannot apply edits to other files.');
   let preview=model.getValue();
   for(const file of here)preview=applyTextEdits(preview,file.edits);
   if(elsewhere.length)await onWorkspaceEdit!(elsewhere);
   for(const file of here){
    editor.pushUndoStop();
    editor.executeEdits('lsp',file.edits.map(e=>({range:range(e.range),text:e.newText})));
    editor.pushUndoStop();
   }
   return;
  }
  let simulatedPath:string|null=path;
  let simulated=model.getValue();
  for(const step of plan){
   if(step.kind==='text'){
    if(step.path===simulatedPath)simulated=applyTextEdits(simulated,step.edits);
    else if(!onWorkspaceEdit)throw new Error('This build cannot apply edits to other files.');
   }else if(step.kind==='rename'&&simulatedPath===step.from)simulatedPath=null;
   else if(step.kind==='delete'&&simulatedPath&&(simulatedPath===step.path||simulatedPath.startsWith(step.path+'/')||simulatedPath.startsWith(step.path+'\\')))simulatedPath=null;
  }
  if(operations.length&&!onFileOperations)throw new Error('This editor cannot apply file operations. Nothing was changed.');
  confirmFileOperations(operations);
  let editorPath:string|null=path;
  for(const step of plan){
   if(step.kind==='text'){
    if(step.path===editorPath){
     if(onWorkspaceEdit)await onWorkspaceEdit([{path:step.path,edits:step.edits}]);
     editor.pushUndoStop();
     editor.executeEdits('lsp',step.edits.map(e=>({range:range(e.range),text:e.newText})));
     editor.pushUndoStop();
    }else{
     if(!onWorkspaceEdit)throw new Error('This build cannot apply edits to other files.');
     await onWorkspaceEdit([{path:step.path,edits:step.edits}]);
    }
   }else{
    await onFileOperations!([step]);
    if(step.kind==='rename'&&editorPath===step.from)editorPath=null;
    else if(step.kind==='delete'&&editorPath&&(editorPath===step.path||editorPath.startsWith(step.path+'/')||editorPath.startsWith(step.path+'\\')))editorPath=null;
   }
  }
 };

 if(server.capabilities.hoverProvider)disposables.push(monaco.languages.registerHoverProvider(server.language,{async provideHover(candidate,position){if(candidate!==model)return null;try{const data=await request('textDocument/hover',parameters(position));if(!data)return null;const contents=(Array.isArray(data.contents)?data.contents:[data.contents]).filter(Boolean).map((c:any)=>({value:typeof c==='string'?c:c.language?`\`\`\`${c.language}\n${c.value}\n\`\`\``:c.value,isTrusted:false}));return {contents,range:data.range?range(data.range):undefined};}catch(e){onError(String(e));return null;}}}));
 if(server.capabilities.completionProvider)disposables.push(monaco.languages.registerCompletionItemProvider(server.language,{triggerCharacters:server.capabilities.completionProvider.triggerCharacters,async provideCompletionItems(candidate,position){if(candidate!==model)return {suggestions:[]};try{const data=await request('textDocument/completion',parameters(position));const items=Array.isArray(data)?data:data?.items??[];const word=model.getWordUntilPosition(position);return {suggestions:items.map((item:any)=>({label:item.label,kind:completionKind(item.kind),detail:item.detail,documentation:markdown(item.documentation),sortText:item.sortText,filterText:item.filterText,preselect:item.preselect,insertText:item.textEdit?.newText??item.insertText??item.label,insertTextRules:item.insertTextFormat===2?monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet:undefined,range:item.textEdit?.range?range(item.textEdit.range):item.textEdit?.insert?range(item.textEdit.insert):new monaco.Range(position.lineNumber,word.startColumn,position.lineNumber,word.endColumn),additionalTextEdits:item.additionalTextEdits?.map((e:any)=>({range:range(e.range),text:e.newText}))}))};}catch(e){onError(String(e));return {suggestions:[]};}}}));
 if(server.capabilities.definitionProvider){disposables.push(monaco.languages.registerDefinitionProvider(server.language,{async provideDefinition(candidate,position){if(candidate!==model)return null;try{return locations(await request('textDocument/definition',parameters(position)));}catch(e){onError(String(e));return null;}}}));disposables.push(monaco.editor.registerEditorOpener({openCodeEditor(_source,resource,selection){if(resource.scheme!=='file')return false;const line=selection&&'startLineNumber'in selection?selection.startLineNumber:selection&&'lineNumber'in selection?selection.lineNumber:1;onNavigate(resource.fsPath,line);return true;}}));}
 // Go to type definition / implementation / declaration: the same shape as
 // definition, and the three a C++ or Java reader reaches for constantly.
 if(server.capabilities.typeDefinitionProvider)disposables.push(monaco.languages.registerTypeDefinitionProvider(server.language,{async provideTypeDefinition(candidate,position){if(candidate!==model)return null;try{return locations(await request('textDocument/typeDefinition',parameters(position)));}catch(e){onError(String(e));return null;}}}));
 if(server.capabilities.implementationProvider)disposables.push(monaco.languages.registerImplementationProvider(server.language,{async provideImplementation(candidate,position){if(candidate!==model)return null;try{return locations(await request('textDocument/implementation',parameters(position)));}catch(e){onError(String(e));return null;}}}));
 if(server.capabilities.declarationProvider)disposables.push(monaco.languages.registerDeclarationProvider(server.language,{async provideDeclaration(candidate,position){if(candidate!==model)return null;try{return locations(await request('textDocument/declaration',parameters(position)));}catch(e){onError(String(e));return null;}}}));
 if(server.capabilities.referencesProvider)disposables.push(monaco.languages.registerReferenceProvider(server.language,{async provideReferences(candidate,position,context){if(candidate!==model)return null;try{return locations(await request('textDocument/references',{...parameters(position),context:{includeDeclaration:context.includeDeclaration!==false}}));}catch(e){onError(String(e));return null;}}}));
 if(server.capabilities.documentSymbolProvider)disposables.push(monaco.languages.registerDocumentSymbolProvider(server.language,{async provideDocumentSymbols(candidate){if(candidate!==model)return [];try{
  const data=await request('textDocument/documentSymbol',{textDocument:{uri}});
  // Servers answer with either a flat SymbolInformation list or a tree.
  const convert=(nodes:any[]):monaco.languages.DocumentSymbol[]=>nodes.map((node:any)=>node.location
   ?{name:node.name,detail:node.containerName??'',kind:symbolKind(node.kind),tags:[],range:range(node.location.range),selectionRange:range(node.location.range)}
   :{name:node.name,detail:node.detail??'',kind:symbolKind(node.kind),tags:[],range:range(node.range),selectionRange:range(node.selectionRange??node.range),children:node.children?convert(node.children):undefined});
  return convert(data??[]);
 }catch(e){onError(String(e));return [];}}}));
 if(server.capabilities.signatureHelpProvider)disposables.push(monaco.languages.registerSignatureHelpProvider(server.language,{
  signatureHelpTriggerCharacters:server.capabilities.signatureHelpProvider.triggerCharacters??['(',','],
  signatureHelpRetriggerCharacters:server.capabilities.signatureHelpProvider.retriggerCharacters??[],
  async provideSignatureHelp(candidate,position){if(candidate!==model)return null;try{
   const data=await request('textDocument/signatureHelp',parameters(position));
   if(!data?.signatures?.length)return null;
   return {value:{signatures:data.signatures.map((s:any)=>({label:s.label,documentation:markdown(s.documentation),parameters:(s.parameters??[]).map((p:any)=>({label:p.label,documentation:markdown(p.documentation)}))})),activeSignature:data.activeSignature??0,activeParameter:data.activeParameter??0},dispose(){}};
  }catch(e){onError(String(e));return null;}}}));
 if(server.capabilities.codeActionProvider){
  const commandId=`afteredit.lspAction.${server.id}.${++connectionCount}`;
  const perform=async(action:any)=>{
   try{
    // A server may send a title-only action and fill in the edit on resolve.
    const full=!action.edit&&action.data!==undefined&&server.capabilities.codeActionProvider?.resolveProvider
     ?(await request('codeAction/resolve',action))??action:action;
    if(full.edit)await applyEdit(full.edit);
    if(full.command)await request('workspace/executeCommand',{command:full.command.command??full.command,arguments:full.command.arguments});
   }catch(e){onError(String(e));}
  };
  disposables.push(monaco.editor.registerCommand(commandId,(_accessor,action:any)=>{void perform(action);}));
  disposables.push(monaco.languages.registerCodeActionProvider(server.language,{async provideCodeActions(candidate,selection,context){
   if(candidate!==model)return {actions:[],dispose(){}};
   try{
    // Hand back the server's own diagnostics for the selected lines: without
    // them clangd and jdtls offer nothing, because a quick fix is attached to
    // the diagnostic rather than to the position.
    const covering=published.filter((d:any)=>d.range.end.line+1>=selection.startLineNumber&&d.range.start.line+1<=selection.endLineNumber);
    const data=await request('textDocument/codeAction',{textDocument:{uri},range:lspRange(selection),context:{diagnostics:covering,only:context.only?[context.only]:undefined}});
    // Actions run through our own command so every edit -- including the
    // multi-file ones -- takes the reviewed path above.
    return {actions:(data??[]).filter((action:any)=>action&&(action.title||action.command)).map((action:any)=>({
     title:action.title??'Code action',kind:action.kind,isPreferred:action.isPreferred,diagnostics:[],
     command:{id:commandId,title:action.title??'Code action',arguments:[action]},
    })),dispose(){}};
   }catch(e){onError(String(e));return {actions:[],dispose(){}};}
  }}));
 }
 if(server.capabilities.renameProvider)disposables.push(monaco.languages.registerRenameProvider(server.language,{
  // Ask the server whether the symbol under the cursor can be renamed at all,
  // so an illegal rename is refused before the user types a new name.
  ...(server.capabilities.renameProvider?.prepareProvider?{async resolveRenameLocation(candidate:any,position:any){
   if(candidate!==model)return {range:new monaco.Range(1,1,1,1),text:'',rejectReason:'Not this file.'};
   try{
    const data=await request('textDocument/prepareRename',parameters(position));
    if(!data)return {range:new monaco.Range(1,1,1,1),text:'',rejectReason:'This cannot be renamed here.'};
    // Three legal replies: a bare Range, {range,placeholder}, or
    // {defaultBehavior:true} meaning "use the word under the cursor".
    const found=data.start?data:data.range;
    if(!found){
     const word=model.getWordAtPosition(position);
     if(!word)return {range:new monaco.Range(1,1,1,1),text:'',rejectReason:'There is nothing to rename here.'};
     const span=new monaco.Range(position.lineNumber,word.startColumn,position.lineNumber,word.endColumn);
     return {range:span,text:model.getValueInRange(span)};
    }
    return {range:range(found),text:data.placeholder??model.getValueInRange(range(found))};
   }catch(e){return {range:new monaco.Range(1,1,1,1),text:'',rejectReason:String(e)};}
  }}:{}),
  async provideRenameEdits(candidate,position,newName){
   if(candidate!==model)return {edits:[]};
   try{
    const data=await request('textDocument/rename',{...parameters(position),newName});
    // We apply the edits ourselves -- Monaco's bulk edit silently drops any
    // file it has no model for, which for a rename is a corrupted refactor.
    await applyEdit(data);
    return {edits:[]};
   }catch(e){return {edits:[],rejectReason:String(e)};}
  },
 }));
 if(server.capabilities.documentFormattingProvider)disposables.push(monaco.languages.registerDocumentFormattingEditProvider(server.language,{async provideDocumentFormattingEdits(candidate,options){if(candidate!==model)return [];try{const edits=await request('textDocument/formatting',{textDocument:{uri},options});return (edits??[]).map((e:any)=>({range:range(e.range),text:e.newText}));}catch(e){onError(String(e));return [];}}}));
 const tokenLegend=server.capabilities.semanticTokensProvider?.legend;
 const tokenTypes=tokenLegend?.tokenTypes;
 const tokenModifiers=tokenLegend?.tokenModifiers;
 const modifiersOk=!tokenModifiers||(Array.isArray(tokenModifiers)&&tokenModifiers.every((name:unknown)=>typeof name==='string'));
 if(server.capabilities.semanticTokensProvider?.full&&Array.isArray(tokenTypes)&&tokenTypes.length>0&&tokenTypes.every((name:unknown)=>typeof name==='string')&&modifiersOk){
  const legend={tokenTypes:tokenTypes as string[],tokenModifiers:(tokenModifiers??[]) as string[]};
  disposables.push(monaco.languages.registerDocumentSemanticTokensProvider(server.language,{
   getLegend:()=>legend,
   async provideDocumentSemanticTokens(candidate,_lastResultId,token){
    if(candidate!==model||token.isCancellationRequested)return {data:new Uint32Array()};
    try{
     const data=await request('textDocument/semanticTokens/full',{textDocument:{uri}});
     if(token.isCancellationRequested)return {data:new Uint32Array()};
     const decoded=decodeSemanticTokens(data);
     if(!decoded){onError('The language server sent semantic tokens AfterEdit will not paint.');return {data:new Uint32Array()};}
     return {data:decoded};
    }catch(e){onError(String(e));return {data:new Uint32Array()};}
   },
   releaseDocumentSemanticTokens(){},
  }));
 }
 if(server.capabilities.inlayHintProvider)disposables.push(monaco.languages.registerInlayHintsProvider(server.language,{
  async provideInlayHints(candidate,hintRange,token){
   const empty={hints:[],dispose(){}};
   if(candidate!==model||token.isCancellationRequested)return empty;
   try{
    const data=await request('textDocument/inlayHint',{textDocument:{uri},range:lspRange(hintRange)});
    if(token.isCancellationRequested)return empty;
    const list=Array.isArray(data)?data:[];
    if(list.length>2000){onError('The language server sent too many inlay hints to show.');return empty;}
    const hints=list.flatMap((hint:any)=>{
     const line=hint?.position?.line,character=hint?.position?.character;
     if(typeof line!=='number'||typeof character!=='number')return [];
     const label=typeof hint.label==='string'?hint.label:Array.isArray(hint.label)?hint.label.map((part:any)=>typeof part?.value==='string'?part.value:'').join(''):'';
     if(!label)return [];
     const item:monaco.languages.InlayHint={label,position:{lineNumber:line+1,column:character+1},paddingLeft:!!hint.paddingLeft,paddingRight:!!hint.paddingRight};
     if(hint.kind===1)item.kind=monaco.languages.InlayHintKind.Type;
     else if(hint.kind===2)item.kind=monaco.languages.InlayHintKind.Parameter;
     const tooltip=typeof hint.tooltip==='string'?hint.tooltip:hint.tooltip?.value;
     if(typeof tooltip==='string')item.tooltip=tooltip;
     return [item];
    });
    return {hints,dispose(){}};
   }catch(e){onError(String(e));return empty;}
  },
 }));
 const hierarchyItem=(item:any)=>{
  try{
   const file=fileUriToPath(String(item?.uri??''));
   if(!item?.name)return null;
   const start=item.selectionRange?.start??item.range?.start;
   return {name:String(item.name),path:file,line:(start?.line??0)+1};
  }catch{return null;}
 };
 const take=(nodes:any[]|null|undefined,pick:(node:any)=>any)=>{
  const items:{name:string;path:string;line:number}[]=[];
  for(const node of nodes??[]){
   const item=hierarchyItem(pick(node));
   if(!item)continue;
   items.push(item);
   if(items.length>=40)break;
  }
  return items;
 };
 const publish=(title:string,groups:{heading:string;items:{name:string;path:string;line:number}[]}[])=>{
  window.dispatchEvent(new CustomEvent('afteredit:hierarchy',{detail:{path,title,groups}}));
 };
 if(server.capabilities.callHierarchyProvider){
  const action=editor.addAction({id:'afteredit.callHierarchy',label:'Call hierarchy',run:async()=>{
   try{
    const position=editor.getPosition();if(!position)return;
    const prepared=await request('textDocument/prepareCallHierarchy',parameters(position));
    const root=Array.isArray(prepared)?prepared[0]:prepared;
    if(!root){publish('Call hierarchy',[]);return;}
    const [incoming,outgoing]=await Promise.all([
     request('callHierarchy/incomingCalls',{item:root}),
     request('callHierarchy/outgoingCalls',{item:root}),
    ]);
    publish('Call hierarchy',[
     {heading:'Incoming',items:take(incoming,node=>node.from)},
     {heading:'Outgoing',items:take(outgoing,node=>node.to)},
    ]);
   }catch(e){onError(String(e));}
  }});
  disposables.push(action);
 }
 if(server.capabilities.typeHierarchyProvider){
  const action=editor.addAction({id:'afteredit.typeHierarchy',label:'Type hierarchy',run:async()=>{
   try{
    const position=editor.getPosition();if(!position)return;
    const prepared=await request('textDocument/prepareTypeHierarchy',parameters(position));
    const root=Array.isArray(prepared)?prepared[0]:prepared;
    if(!root){publish('Type hierarchy',[]);return;}
    const [supertypes,subtypes]=await Promise.all([
     request('typeHierarchy/supertypes',{item:root}),
     request('typeHierarchy/subtypes',{item:root}),
    ]);
    publish('Type hierarchy',[
     {heading:'Supertypes',items:take(supertypes,node=>node)},
     {heading:'Subtypes',items:take(subtypes,node=>node)},
    ]);
   }catch(e){onError(String(e));}
  }});
  disposables.push(action);
 }
 return ()=>{disposed=true;disposables.forEach(d=>d.dispose());monaco.editor.setModelMarkers(model,`lsp-${server.id}`,[]);void sync.then(()=>notify('textDocument/didClose',{textDocument:{uri}})).catch(()=>{});};
}
