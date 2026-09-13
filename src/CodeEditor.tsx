import type { EditorMenuRequest } from './menuCommands';
import EditorNavigation from './EditorNavigation';
import { useAccessibility } from './AccessibilityContext';
import { accessibleEditorOptions, accessibleEditorTheme } from './accessibility';
import type { InfrastructureDiagnostic } from './infrastructure';
import { shellClosingBlock } from './smartEditing';
import type { Breakpoint } from './debugging';
import * as monaco from 'monaco-editor';
import './monaco-setup';
import { connectModel } from './lspClient';
import type { FileEdits } from './workspaceEdit';
import { syncExternalFormatters, formatText } from './externalFormatting';
import type { SecretFinding } from './policy';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ConnectedServer } from './languageServices';
import { activateExtensions } from './extensionRuntime';
import type { Extension } from './extensions';
import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { languageForFilename } from './languages';
import { editorOptions, type EditorPreferences } from './preferences';
export default function CodeEditor({ menuRequest, onReady, infrastructureDiagnostics, breakpoints, onToggleBreakpoint, debugLocation, path, value, onChange, options, onSave, extensions, revealLine, servers, onNavigate, onError, onWorkspaceEdit }: { menuRequest?:EditorMenuRequest; onReady:(ready:boolean)=>void; infrastructureDiagnostics:InfrastructureDiagnostic[]; breakpoints:Breakpoint[]; onToggleBreakpoint:(path:string,line:number)=>void; debugLocation?:{path:string;line:number}; path: string; value: string; onChange: (value: string) => void; options: EditorPreferences; onSave: () => void; extensions: Extension[]; revealLine: number; servers: ConnectedServer[]; onNavigate:(path:string,line:number)=>void; onError:(text:string)=>void; onWorkspaceEdit?:(files:FileEdits[])=>Promise<void> }) {
  const accessibility = useAccessibility();
  const resolvedTheme = accessibleEditorTheme(accessibility, ['vs','vs-dark','hc-black','hc-light'].includes(options.theme) || extensions.some(e=>e.enabled&&e.themes.some(t=>t.id===options.theme)) ? options.theme : 'vs-dark');
  const [instance, setInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
  useEffect(()=>{if(!instance)return;const focus=()=>instance.focus();window.addEventListener('afteredit:focus-editor',focus);return()=>window.removeEventListener('afteredit:focus-editor',focus);},[instance]);
  useEffect(()=>{const model=instance?.getModel();if(!model)return;monaco.editor.setModelMarkers(model,'infrastructure',infrastructureDiagnostics.filter(d=>d.path===path).map(d=>({message:d.message,source:d.source,startLineNumber:d.line,startColumn:d.column,endLineNumber:d.line,endColumn:d.column+1,severity:d.severity==='error'?monaco.MarkerSeverity.Error:d.severity==='warning'?monaco.MarkerSeverity.Warning:monaco.MarkerSeverity.Info})));const changed=model.onDidChangeContent(()=>monaco.editor.setModelMarkers(model,'infrastructure',[]));return()=>{changed.dispose();monaco.editor.setModelMarkers(model,'infrastructure',[]);};},[instance,path,infrastructureDiagnostics]);
  useEffect(()=>{onReady(!!instance);return()=>onReady(false);},[instance,onReady]);
  const handledMenu=useRef(menuRequest?.sequence);
  useEffect(()=>{
    if(!instance||!menuRequest||handledMenu.current===menuRequest.sequence)return;
    handledMenu.current=menuRequest.sequence;instance.focus();
    const action=instance.getAction(menuRequest.id);
    if(!action?.isSupported()){onError('This editor command is unavailable for the current language or selection.');return;}
    void action.run().catch(onError);
  },[instance,menuRequest,onError]);
  const toggleBreakpoint=useRef(onToggleBreakpoint);toggleBreakpoint.current=onToggleBreakpoint;
  useEffect(()=>{if(!instance)return;const listener=instance.onMouseDown(e=>{if(e.target.type===monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN&&e.target.position&&!path.includes('://'))toggleBreakpoint.current(path,e.target.position.lineNumber);});return()=>listener.dispose();},[instance,path]);
  useEffect(()=>{if(!instance)return;const rows:monaco.editor.IModelDeltaDecoration[]=breakpoints.filter(b=>b.path===path&&b.enabled!==false).map(b=>({range:new monaco.Range(b.line,1,b.line,1),options:{glyphMarginClassName:b.verified?'debug-breakpoint':'debug-breakpoint-pending',glyphMarginHoverMessage:{value:b.message??'Breakpoint'}}}));if(debugLocation?.path===path)rows.push({range:new monaco.Range(debugLocation.line,1,debugLocation.line,1),options:{isWholeLine:true,className:'debug-current-line'}});const decorations=instance.createDecorationsCollection(rows);return()=>decorations.clear();},[instance,path,breakpoints,debugLocation]);
  useEffect(()=>activateExtensions(extensions,resolvedTheme),[extensions,resolvedTheme]);
  useEffect(()=>{if(instance&&revealLine>0){instance.setPosition({lineNumber:revealLine,column:1});instance.revealLineInCenter(revealLine);instance.focus();}},[instance,path,revealLine]);
  const callbacks=useRef({onNavigate,onError,onWorkspaceEdit});callbacks.current={onNavigate,onError,onWorkspaceEdit};
  useEffect(()=>{if(!instance)return;const server=servers.find(s=>s.language===languageForFilename(path)&&(path.startsWith(s.root+'/')||path.startsWith(s.root+'\\')));if(server)return connectModel(instance,path,server,(p,l)=>callbacks.current.onNavigate(p,l),e=>callbacks.current.onError(e),files=>callbacks.current.onWorkspaceEdit?.(files)??Promise.reject(new Error('This build cannot apply edits to other files.')));},[instance,path,servers]);
  useEffect(()=>{if(!instance||!options.shellBlockCompletion||options.keymap==='vim'||languageForFilename(path)!=='shell')return;const listener=instance.onKeyDown(e=>{if(e.keyCode!==monaco.KeyCode.Enter||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey)return;const model=instance.getModel(),selection=instance.getSelection();if(!model||!selection||!selection.isEmpty()||selection.endColumn!==model.getLineMaxColumn(selection.endLineNumber))return;const row=selection.endLineNumber;const following=row<model.getLineCount()?model.getValueInRange(new monaco.Range(row+1,1,model.getLineCount(),model.getLineMaxColumn(model.getLineCount()))):'';const block=shellClosingBlock(model.getLineContent(row),following);if(!block)return;e.preventDefault();e.stopPropagation();const unit=options.insertSpaces?' '.repeat(options.tabSize):'\t',eol=model.getEOL();instance.pushUndoStop();instance.executeEdits('shell-block',[{range:selection,text:eol+block.indent+unit+eol+block.indent+block.close}]);instance.setPosition({lineNumber:row+1,column:block.indent.length+unit.length+1});instance.pushUndoStop();});return()=>listener.dispose();},[instance,path,options.shellBlockCompletion,options.tabSize,options.insertSpaces,options.keymap]);
  // Flag credentials in the open buffer, before they are ever staged. Own
  // marker key so it never fights the LSP or infrastructure diagnostics.
  useEffect(()=>{
    const model=instance?.getModel();
    if(!model||!isTauri())return;
    let stale=false;
    const timer=setTimeout(()=>{
      void invoke<SecretFinding[]>('scan_buffer_secrets',{path,text:model.getValue()})
        .then(found=>{
          if(stale||model.isDisposed())return;
          monaco.editor.setModelMarkers(model,'secrets',found.map(finding=>({
            message:`Possible ${finding.description} committed in plaintext. Remove it, or add \`gitleaks:allow\` on the line.`,
            severity:monaco.MarkerSeverity.Warning,
            source:'secrets',
            startLineNumber:finding.start_line,startColumn:1,
            endLineNumber:finding.start_line,endColumn:Number.MAX_SAFE_INTEGER,
          })));
        })
        .catch(()=>{/* scanning is advisory here; the commit gate is the guard */});
    },400);
    return()=>{stale=true;clearTimeout(timer);};
  },[instance,path,value]);

  // External formatters are a fallback: registered only for languages no
  // connected server is formatting, and dropped as soon as one takes over.
  useEffect(()=>{void syncExternalFormatters(servers,message=>callbacks.current.onError(message));},[servers]);
  useEffect(()=>{
    if(!instance)return;
    const action=instance.addAction({
      id:'afteredit.formatExternal',
      label:'Format Document (external tool)',
      contextMenuGroupId:'1_modification',
      run:async editor=>{
        const model=editor.getModel();if(!model)return;
        try{
          const outcome=await formatText(model.getLanguageId(),model.getValue());
          if(outcome.changed)editor.executeEdits('afteredit.formatExternal',[{range:model.getFullModelRange(),text:outcome.text}]);
        }catch(error){callbacks.current.onError(String(error));}
      },
    });
    return ()=>action.dispose();
  },[instance]);
  const status = useRef<HTMLDivElement>(null);
  const save = useRef(onSave); save.current = onSave;
  useEffect(() => {
    if (!instance) return;
    const action = instance.addAction({ id:'afteredit.save', label:'Save file', run:()=>save.current() });
    return () => action.dispose();
  }, [instance]);
  useEffect(() => {
    if (!instance || !status.current) return;
    const node = status.current;
    node.textContent = options.keymap === 'standard' ? 'Standard keybindings' : `Loading ${options.keymap} keybindings…`;
    let disposed = false;
    let adapter: { dispose: () => void } | undefined;
    const attach = async () => {
      if (options.keymap === 'vim') {
        const {initVimMode, VimMode} = await import('monaco-vim');
        if (disposed) return;
        (VimMode as unknown as { Vim: { defineEx: (name: string, short: string, callback: (cm: {editor: editor.IStandaloneCodeEditor}) => void) => void } }).Vim.defineEx('write','w', cm=>{ void cm.editor.getAction('afteredit.save')?.run(); });
        adapter = initVimMode(instance, node);
      } else if (options.keymap === 'emacs') {
        const {EmacsExtension, registerGlobalCommand} = await import('monaco-emacs');
        if (disposed) return;
        registerGlobalCommand('C-x C-s', {description:'Save file',run:editor=>{void editor.getAction('afteredit.save')?.run();}});
        const mode = new EmacsExtension(instance);
        mode.onDidMarkChange(mark=>{node.textContent = mark ? 'Emacs · Mark set' : 'Emacs';});
        mode.onDidChangeKey(key=>{node.textContent = `Emacs · ${key}`;});
        mode.start(); adapter = mode; node.textContent = 'Emacs · C-x C-s save · C-g cancel';
      }
    };
    void attach().catch(e=>{if(!disposed) node.textContent = `Keymap could not load: ${String(e)}. Standard bindings remain available.`;});
    return ()=>{disposed=true;adapter?.dispose();node.textContent='';};
  },[instance,options.keymap]);
  return <div className="editor-host"><EditorNavigation instance={instance} path={path} onToggleBreakpoint={()=>{const position=instance?.getPosition();if(position)onToggleBreakpoint(path,position.lineNumber);}}/><div className="editor-surface"><Editor height="100%" theme={resolvedTheme} path={path} language={languageForFilename(path)} value={value} onChange={v=>onChange(v??'')} onMount={setInstance} options={{...editorOptions(options),...accessibleEditorOptions(accessibility,path),glyphMargin:true}} loading={<p>Loading local editor…</p>} /></div><div ref={status} className="keymap-status" aria-live="polite" /></div>;
}
