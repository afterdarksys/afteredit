import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
export function describePosition(line: string, lineNumber: number, column: number) {
  const indent = line.match(/^[\t ]*/)?.[0] ?? '';
  const spaces = [...indent].filter(c=>c===' ').length;
  const tabs = indent.length-spaces;
  return `Line ${lineNumber}, column ${column}. Indentation: ${spaces} spaces, ${tabs} tabs.`;
}
export default function EditorNavigation({instance,path,onToggleBreakpoint}: {
  instance: monaco.editor.IStandaloneCodeEditor | null; path:string; onToggleBreakpoint:()=>void;
}) {
  const [message,setMessage]=useState('');
  const [problems,setProblems]=useState<monaco.editor.IMarker[]>([]);
  useEffect(()=>{
    const refresh=()=>{const model=instance?.getModel();setProblems(model?monaco.editor.getModelMarkers({resource:model.uri}):[]);};
    refresh();
    const listener=monaco.editor.onDidChangeMarkers(refresh);
    const modelListener=instance?.onDidChangeModel(refresh);
    return ()=>{listener.dispose();modelListener?.dispose();};
  },[instance,path]);
  function reportPosition() {
    const position=instance?.getPosition(),model=instance?.getModel();
    if(position&&model) {
      setMessage('');
      requestAnimationFrame(()=>setMessage(describePosition(model.getLineContent(position.lineNumber),position.lineNumber,position.column)));
    }
  }
  return <div className="editor-navigation">
    <button disabled={!instance} onClick={()=>{instance?.focus();void instance?.getAction('editor.action.quickOutline')?.run();}}>Go to symbol</button>
    <button disabled={!instance} onClick={reportPosition}>Report cursor and indentation</button>
    <button disabled={!instance || path.includes('://')} onClick={onToggleBreakpoint}>Toggle breakpoint at cursor</button>
    <details><summary>Problems in this file ({problems.length})</summary>
      {problems.length===0&&<p>No diagnostics reported for this file.</p>}
      <ul>{problems.map((p,i)=><li key={i}><button onClick={()=>{instance?.setPosition({lineNumber:p.startLineNumber,column:p.startColumn});instance?.revealLineInCenter(p.startLineNumber);instance?.focus();}}>
        {p.severity===monaco.MarkerSeverity.Error?'Error':p.severity===monaco.MarkerSeverity.Warning?'Warning':'Information'}: line {p.startLineNumber}, column {p.startColumn}: {p.message}
      </button></li>)}</ul>
    </details>
    <span role="status" aria-atomic="true">{message}</span>
  </div>;
}
