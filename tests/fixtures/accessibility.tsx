import React from 'react';
import { createRoot } from 'react-dom/client';
import TerminalPanel from '../../src/TerminalPanel';
import AgentPanel from '../../src/AgentPanel';
import '../../src/App.css';
const fixture=new URLSearchParams(location.search).get('fixture');
createRoot(document.getElementById('root')!).render(fixture==='terminal'
  ? <div className="terminal-panel" style={{height:700}}><TerminalPanel theme="win"/></div>
  : <div className="workbench-page"><AgentPanel root="/project" context="" tasks={{}}
      ask={async()=>JSON.stringify({type:'edit_file',path:'example.ts',oldText:'const value = 1;',newText:'const value = 2;'})}
      onRead={async()=>''} onEdit={async()=>''} onTask={async()=>''} onStopTask={()=>{}} onSaveEdits={async()=>{}}/></div>);
