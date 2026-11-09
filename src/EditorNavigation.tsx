import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
export function describePosition(line: string, lineNumber: number, column: number) {
  const indent = line.match(/^[\t ]*/)?.[0] ?? '';
  const spaces = [...indent].filter(c=>c===' ').length;
  const tabs = indent.length-spaces;
  return `Line ${lineNumber}, column ${column}. Indentation: ${spaces} spaces, ${tabs} tabs.`;
}
type HierarchyItem = { name: string; path: string; line: number };
type HierarchyGroup = { heading: string; items: HierarchyItem[] };
export default function EditorNavigation({instance,path,onNavigate,onToggleBreakpoint}: {
  instance: monaco.editor.IStandaloneCodeEditor | null; path:string; onNavigate:(path:string,line:number)=>void; onToggleBreakpoint:()=>void;
}) {
  const [message,setMessage]=useState('');
  const [hierarchyTitle,setHierarchyTitle]=useState('');
  const [groups,setGroups]=useState<HierarchyGroup[]>([]);
  const [problems,setProblems]=useState<monaco.editor.IMarker[]>([]);
  useEffect(()=>{
    const refresh=()=>{const model=instance?.getModel();setProblems(model?monaco.editor.getModelMarkers({resource:model.uri}):[]);};
    refresh();
    const listener=monaco.editor.onDidChangeMarkers(refresh);
    const modelListener=instance?.onDidChangeModel(refresh);
    return ()=>{listener.dispose();modelListener?.dispose();};
  },[instance,path]);
  useEffect(()=>{setHierarchyTitle('');setGroups([]);},[path]);
  useEffect(()=>{
    const onHierarchy=(event:Event)=>{
      const detail=(event as CustomEvent<{path?:string;title?:string;groups?:HierarchyGroup[]}>).detail;
      if(!detail||detail.path!==path)return;
      setHierarchyTitle(detail.title??'');
      setGroups(detail.groups??[]);
      setMessage('');
    };
    window.addEventListener('afteredit:hierarchy',onHierarchy);
    return ()=>window.removeEventListener('afteredit:hierarchy',onHierarchy);
  },[path]);
  function runHierarchy(id:string){
    const action=instance?.getAction(id);
    if(action){setMessage('');void action.run();}
    else setMessage('Connect a language server that supports this hierarchy.');
  }
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
    <button disabled={!instance} onClick={()=>runHierarchy('afteredit.callHierarchy')}>Call hierarchy</button>
    <button disabled={!instance} onClick={()=>runHierarchy('afteredit.typeHierarchy')}>Type hierarchy</button>
    <details><summary>Problems in this file ({problems.length})</summary>
      {problems.length===0&&<p>No diagnostics reported for this file.</p>}
      <ul>{problems.map((p,i)=><li key={i}><button onClick={()=>{instance?.setPosition({lineNumber:p.startLineNumber,column:p.startColumn});instance?.revealLineInCenter(p.startLineNumber);instance?.focus();}}>
        {p.severity===monaco.MarkerSeverity.Error?'Error':p.severity===monaco.MarkerSeverity.Warning?'Warning':'Information'}: line {p.startLineNumber}, column {p.startColumn}: {p.message}
      </button></li>)}</ul>
    </details>
    {hierarchyTitle && <div><p>{hierarchyTitle}</p>{groups.map(group=><div key={group.heading}><h2>{group.heading}</h2>{group.items.length===0?<p>None</p>:<ul>{group.items.map((item,index)=><li key={`${item.path}:${item.line}:${index}`}><button onClick={()=>onNavigate(item.path,item.line)}>{item.name} {item.path}:{item.line}</button></li>)}</ul>}</div>)}</div>}
    <span role="status" aria-atomic="true">{message}</span>
  </div>;
}
