import {useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
type Tool={name:string;available:boolean;detail:string};
export default function ApplePanel({root}:{root:string}){
 const [tools,setTools]=useState<Tool[]>([]),[projects,setProjects]=useState<string[]>([]),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 async function inspect(){setBusy(true);setStatus('Checking Apple toolchain…');try{setTools(await invoke<Tool[]>('apple_toolchain'));if(root)setProjects(await invoke<string[]>('apple_projects',{root}));setStatus('Toolchain checked. Project discovery searches five directory levels.');}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 return <section className="workbench-page"><h1>Apple development</h1><p>Develop Swift packages and iOS/macOS projects using your selected Xcode installation.</p><button disabled={!isTauri()||busy} onClick={()=>void inspect()}>Check Xcode and discover projects</button><p role="status">{status}</p>{tools.map(tool=><details key={tool.name}><summary>{tool.name}: {tool.available?'available':'unavailable'}</summary><pre>{tool.detail}</pre></details>)}<h2>Projects</h2>{projects.length?projects.map(path=><p key={path}>{path}</p>):<p>Open a project folder, then run discovery.</p>}</section>;
}
