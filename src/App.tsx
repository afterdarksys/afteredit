import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Files, Search, Code, Wrench, Settings, Zap, Play, Package } from 'lucide-react';
import TerminalPanel from './TerminalPanel';
import ToolsPanel from './ToolsPanel';
import ErrorBoundary from './ErrorBoundary';
import AiPanel from './AiPanel';
import { relativePath, replaceUnique } from './agent';
import LanguagePanel from './LanguagePanel';
import { detectBuildSystems, type ConnectedServer } from './languageServices';
import SearchPanel from './SearchPanel';
import ExtensionsPanel from './ExtensionsPanel';
import { restoreExtensions, type Extension } from './extensions';
import PreferencesPanel from './PreferencesPanel';
import { editorDefaults, validateEditor, savedText } from './preferences';
import { usePersistedState } from './usePersistedState';
import { defaults, matchingRules, expandTask, presets, resolveConfig, taskOrder, type ProjectConfig } from './workflows';
const CompatibilityEditor = lazy(() => import('./CompatibilityEditor'));
const CodeEditor = lazy(() => import('./CodeEditor'));
type Entry = { name: string; path: string; directory: boolean };
type Buffer = { value: string; saved: string; disk: boolean };
type View = 'editor' | 'tools' | 'settings' | 'tasks' | 'ai' | 'extensions' | 'search' | 'languages';
const parent = (path: string) => path.replace(/[\\/][^\\/]+$/, '');
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
function App() {
  const [compatibility,setCompatibility]=useState(false);
  const [extensionRevision,setExtensionRevision]=useState(0);
  const [servers,setServers]=useState<ConnectedServer[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>(()=>{try{return restoreExtensions(localStorage.getItem('extensions.v1')??'[]');}catch{return [];}});
  const changeExtensions = (next:Extension[]) => {try {localStorage.setItem('extensions.v1',JSON.stringify(next));setExtensions(next);setExtensionRevision(n=>n+1);return true;}catch {setStatus('Extension storage is full; remove an extension and retry.');return false;}};
  const [personalJSON, setPersonalJSON] = usePersistedState('editor.preferences.v1', '{}');
  const personal = (() => { try { return {...editorDefaults,...validateEditor(JSON.parse(personalJSON))}; } catch { return editorDefaults; } })();
  const [theme, setTheme] = usePersistedState('pref.osTheme', 'mac');
  const [layout, setLayout] = usePersistedState('pref.layout', 'stacked');
  const [scratch, setScratch] = usePersistedState('scratch.v2', '// Welcome to AfterEdit. Open a file or a project to begin.\n');
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [revealLine,setRevealLine]=useState(0);
  const buffersRef=useRef(buffers);buffersRef.current=buffers;
  const [active, setActive] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState('');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [view, setView] = useState<View>('editor');
  const [status, setStatus] = useState('Ready');
  const [config, setConfig] = useState<ProjectConfig>(defaults);
  const [layers, setLayers] = useState<string[]>([]);
  const [configError, setConfigError] = useState('');
  const [revision, setRevision] = useState(0);
  const [preset, setPreset] = useState(Object.keys(presets)[0]);
  const [historyJSON,setHistoryJSON]=usePersistedState('workflow.history.v1','[]');
  const history: Array<{root:string;ids:string[];date:string;success:boolean}> = (()=>{try {const rows=JSON.parse(historyJSON);return Array.isArray(rows)?rows.filter(r=>r&&typeof r.root==='string'&&Array.isArray(r.ids)&&r.ids.every((id:unknown)=>typeof id==='string')&&typeof r.date==='string'&&typeof r.success==='boolean'):[];}catch{return [];}})();
  const [runLog, setRunLog] = useState('');
  const [running, setRunning] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<string[]>([]);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const runningRef = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = Object.values(buffers).some(b => b.value !== b.saved);
  const cancelled = useRef(false);
  const activeBuffer = buffers[active];
  const value = activeBuffer?.value ?? scratch;
  const activeRoot = roots.filter(r => active.startsWith(r + '/') || active.startsWith(r + '\\')).sort((a,b) => b.length - a.length)[0] ?? (activeBuffer?.disk ? '' : root);
  const scope = !activeRoot ? '' : activeBuffer?.disk && (active.startsWith(activeRoot + '/') || active.startsWith(activeRoot + '\\')) ? parent(active) : directory || activeRoot;
  const update = (next: string) => { if (activeBuffer) setBuffers(b => ({ ...b, [active]: { ...b[active], value: next } })); else setScratch(next); };
  const report = (e: unknown) => setStatus(String(e));
  useEffect(() => {
    document.body.classList.toggle('theme-mac', theme === 'mac');
    document.body.classList.toggle('theme-win', theme !== 'mac');
  }, [theme]);
  useEffect(() => {
    let stale = false;
    if (!activeRoot || !scope) { setConfig(resolveConfig([{editor:personal}])); setLayers([]); setConfigError(''); return; }
    setConfigError('Loading configuration…');
    invoke<Array<{ path: string; value: unknown }>>('project_config', { root: activeRoot, directory: scope }).then(result => {
      if (stale) return;
      setConfig(resolveConfig([{editor:personal}, ...result.map(l => l.value)])); setLayers(result.map(l => l.path)); setConfigError('');
    }).catch(e => { if (!stale) { setConfig(defaults); setConfigError(String(e)); } });
    return () => { stale = true; };
  }, [activeRoot, scope, revision, personalJSON]);
  useEffect(() => { setTrusted(false); setPendingTasks([]); }, [activeRoot, scope, revision]);
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let off: (() => void) | undefined;
    listen<{ text: string }>('task:output', e => setRunLog(log => (log + e.payload.text).slice(-200000))).then(unlisten => { if (stopped) unlisten(); else off = unlisten; }).catch(report);
    return () => { stopped = true; off?.(); };
  }, []);
  useEffect(() => {
    const dirty = Object.values(buffers).some(b => b.value !== b.saved);
    const before = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [buffers]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async event => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      try { if (await invoke<boolean>('confirm_discard')) await getCurrentWindow().destroy(); } catch (e) { report(e); }
    }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(report);
    return () => { disposed = true; off?.(); };
  }, []);
  async function reloadFile() {
    if (!activeBuffer) return;
    try {
      const path = active;
      const text = await invoke<string>('read_file', { path });
      setBuffers(b => ({ ...b, [path]: { value: text, saved: text, disk: true } }));
      setStatus(`Reloaded ${basename(path)}`);
      if (basename(path) === '.afteredit.json') setRevision(n => n + 1);
    } catch (e) { report(e); }
  }
  async function saveAs() {
    try {
      const snapshot = value;
      const path = await invoke<string | null>('save_as', { content: snapshot });
      if (!path) return;
      setBuffers(b => ({ ...b, [path]: { value: snapshot, saved: snapshot, disk: true } }));
      setActive(path); setView('editor'); setStatus(`Created ${basename(path)}`);
      if (directory) await browse(directory);
    } catch (e) { report(e); }
  }
  async function browse(path: string) { const result = await invoke<Entry[]>('list_directory', { path }); setEntries(result); setDirectory(path); }
  async function openFile(path: string) {
    if (!buffers[path]) {
      const text = await invoke<string>('read_file', { path });
      setBuffers(b => ({ ...b, [path]: { value: text, saved: text, disk: true } }));
    }
    setActive(path); setView('editor');
  }
  async function choose(directory: boolean) {
    try {
      const path = await invoke<string | null>('choose_path', { directory });
      if (!path) return;
      if (directory) { setRoots(r => r.includes(path) ? r : [...r, path]); setRoot(path); setActive(''); await browse(path); }
      else await openFile(path);
    } catch (e) { report(e); }
  }
  async function save() {
    if (!activeBuffer) { if (isTauri()) await saveAs(); else setStatus('Scratch saved locally'); return; }
    const snapshot = savedText(activeBuffer.value, config.editor), path = active;
    if (snapshot !== activeBuffer.value) update(snapshot);
    try {
      await invoke('save_file', { path, content: snapshot, expected: activeBuffer.saved });
      setBuffers(b => ({ ...b, [path]: { ...b[path], saved: snapshot } }));
      setStatus(`Saved ${basename(path)}`);
      window.dispatchEvent(new CustomEvent("afteredit:saved",{detail:{path,text:snapshot}}));
      if (basename(path) === '.afteredit.json') { setRevision(n => n + 1); return; }
      const relative = path.slice(activeRoot.length + 1).replace(/\\/g, '/');
      const ids = matchingRules(config,'save',relative).flatMap(r => r.tasks);
      if (ids.length) { setPendingTasks(ids); setView('tasks'); }
    } catch (e) { report(e); }
  }
  async function run(ids: string[], approved=false):Promise<string> {
    if ((!trusted&&!approved) || configError || runningRef.current) throw new Error('Workflow unavailable: trust commands, wait for configuration, or stop the running task.');
    runningRef.current = true; cancelled.current = false; setRunning(true); setRunLog(''); setPendingTasks([]);
    let success=true;let transcript='';
    try {
      for (const id of taskOrder(config.tasks, ids)) {
        if (cancelled.current) break;
        const task = expandTask(config.tasks[id],{project:activeRoot,file:activeBuffer?.disk?active:''});
        setRunLog(log => log + `\n> ${id}: ${task.command} ${task.args.join(' ')}\n`);
        const {code,output} = await invoke<{code:number;output:string}>('run_task', { root: activeRoot, cwd: task.cwd ?? '.', task });
        transcript+=`\n${id}:\n${output}\n[exit ${code}]\n`;
        setRunLog(log => log + `\n[exit ${code}]\n`);
        if (code !== 0) throw new Error(`Task ${id} failed (${code}); dependent tasks were skipped.`);
      }
    } catch (e) { success=false;transcript+='\n'+String(e);setRunLog(log => log + '\n' + String(e)); } finally { setHistoryJSON(JSON.stringify([{root:activeRoot,ids,date:new Date().toISOString(),success:success&&!cancelled.current},...history].slice(0,30)));runningRef.current = false; setRunning(false); }
    return (success&&!cancelled.current?"Workflow succeeded":"Workflow failed or stopped")+transcript;
  }
  async function agentRead(relative:string):Promise<string>{
    const path=await invoke<string>('project_file_path',{root:activeRoot,relative:relativePath(relative)});
    return buffersRef.current[path]?.value??await invoke<string>('read_file',{path});
  }
  async function agentEdit(relative:string,oldText:string,newText:string):Promise<string>{
    const path=await invoke<string>('project_file_path',{root:activeRoot,relative:relativePath(relative)});
    const disk=await invoke<string>('read_file',{path});
    const existing=buffersRef.current[path]??{value:disk,saved:disk,disk:true};
    const value=replaceUnique(existing.value,oldText,newText);
    buffersRef.current={...buffersRef.current,[path]:{...existing,value}};
    setBuffers(current=>({...current,[path]:{...existing,value}}));
    return `Edited unsaved buffer ${relative}. Save it before running tasks.`;
  }
  async function saveProjectEdits(){
    for(const [path,buffer] of Object.entries(buffersRef.current)){
      if(!(path.startsWith(activeRoot+'/')||path.startsWith(activeRoot+'\\'))||buffer.value===buffer.saved)continue;
      await invoke('save_file',{path,content:buffer.value,expected:buffer.saved});
      setBuffers(current=>({...current,[path]:{...current[path],saved:buffer.value}}));
      window.dispatchEvent(new CustomEvent('afteredit:saved',{detail:{path,text:buffer.value}}));
    }
    setRevision(n=>n+1);
  }
  async function agentTask(name:string):Promise<string>{
    if(Object.entries(buffersRef.current).some(([path,b])=>(path.startsWith(activeRoot+'/')||path.startsWith(activeRoot+'\\'))&&b.value!==b.saved))throw new Error('Save modified project buffers before approving a task.');
    return run([name],true);
  }
  async function configure() {
    try {
      const content = JSON.stringify({ editor: defaults.editor, tasks: Object.fromEntries(Object.entries(presets[preset]).map(([id, task]) => [id, { ...task, cwd: scope.slice(activeRoot.length + 1) || '.' }])), rules: [], instructions: '' }, null, 2) + '\n';
      const path = await invoke<string>('create_config', { directory: scope, content });
      await openFile(path); setRevision(n => n + 1); await browse(scope);
    } catch (e) { report(e); }
  }
  const commands = [
    { title: 'Open file', action: () => void choose(false) }, { title: 'Add project folder', action: () => void choose(true) },
    { title: 'Save file', action: () => void save() }, { title: 'Save as new file', action: () => void saveAs() }, { title: 'Build workflows', action: () => setView('tasks') },
    { title: 'Project settings', action: () => setView('settings') }, { title: 'Developer tools', action: () => setView('tools') }, { title: 'AI assistant', action: () => setView('ai') },
  ];
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !(config.editor.keymap === 'emacs' && e.ctrlKey && !e.metaKey)) { e.preventDefault(); void save(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); void choose(e.shiftKey); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setPalette(p => !p); }
      if (e.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  return <div className="app-container">
    <header data-tauri-drag-region className="titlebar"><strong>AfterEdit</strong><span>{activeRoot ? basename(activeRoot) : 'Developer workbench'}</span><button onClick={() => setPalette(true)}>Commands ⌘⇧P</button></header>
    {!isTauri() && <div className="notice">Browser preview: scratch editing and tools work here. Open the desktop app for filesystem, builds, terminal and AI.</div>}
    <div className="main-content">
      <nav className="activity-bar" aria-label="Workbench">{([
        ['editor', Files, 'Files'], ['search', Search, 'Project search'], ['languages',Code,'Language services'], ['tasks', Play, 'Build workflows'], ['tools', Wrench, 'Developer tools'], ['ai', Zap, 'AI assistant'], ['extensions', Package, 'Extensions'], ['settings', Settings, 'Settings'],
      ] as const).map(([id, Icon, title]) => <button key={id} title={title} aria-label={title} aria-pressed={view === id} className={view === id ? 'selected' : ''} onClick={() => setView(id)}><Icon size={21} /></button>)}</nav>
      <aside className="sidebar"><div className="sidebar-header">EXPLORER</div><div className="explorer-actions"><button disabled={!isTauri()} onClick={() => void choose(false)}>Open file</button><button disabled={!isTauri()} onClick={() => void choose(true)}>Add folder</button></div>
        {roots.length > 0 && <select aria-label="Project" value={root} onChange={e => { const path = e.target.value; setRoot(path); setActive(''); void browse(path).catch(report); }}>{roots.map(r => <option key={r}>{r}</option>)}</select>}
        <div className="sidebar-content"><button className="file-item" onClick={() => { setActive(''); setView('editor'); }}>Scratch</button>
          {directory && <div className="folder-location"><span title={directory}>{basename(directory)}</span><button aria-label="Refresh folder" onClick={() => void browse(directory).catch(report)}>↻</button>{directory !== root && <button onClick={() => void browse(parent(directory)).catch(report)}>Up</button>}</div>}
          {entries.map(entry => <button className={`file-item ${active === entry.path ? 'active' : ''}`} key={entry.path} title={entry.path} onClick={() => void (entry.directory ? (setActive(''), browse(entry.path)) : openFile(entry.path)).catch(report)}>{entry.directory ? '▸' : '·'} {entry.name}</button>)}
        </div>
      </aside>
      <div className={`center-area layout-${layout === 'side-by-side' ? 'side-by-side' : 'stacked'}`}>
        <main className="editor-area"><div className="editor-tabs"><button className="editor-tab" onClick={() => { setView('editor'); setActive(''); }}>Scratch</button>{Object.entries(buffers).map(([path,b]) => <button key={path} title={path} className={`editor-tab ${active === path ? 'active' : ''}`} onClick={() => { setActive(path); setView('editor'); }}>{basename(path)}{b.value !== b.saved ? ' ●' : ''}</button>)}<button disabled={!isTauri()} onClick={() => void save()}>Save</button><button disabled={!isTauri()} onClick={() => void saveAs()}>Save as</button><button disabled={!activeBuffer} onClick={() => void reloadFile()}>Reload from disk (discard edits)</button></div>
          <div className="breadcrumbs">{view === 'editor' ? active || 'Local scratch buffer' : view}</div>
          <div className="editor-container">
            {view === 'editor' && <ErrorBoundary key={active || 'scratch'} fallback={<textarea aria-label="Recovery text editor" className="fallback-editor" value={value} onChange={e => update(e.target.value)} />}><Suspense fallback={<div className="recovery"><p>Loading syntax editor… You can edit below while it loads.</p><textarea aria-label="Loading text editor" className="fallback-editor" value={value} onChange={e => update(e.target.value)} /></div>}>{compatibility ? <CompatibilityEditor key={extensionRevision} path={active || 'inmemory://scratch.txt'} value={value} onChange={update} options={config.editor} extensions={extensions} onSave={() => void save()} /> : <CodeEditor path={active || 'inmemory://scratch.txt'} value={value} onChange={update} options={config.editor} servers={servers} onNavigate={(path,line)=>{void openFile(path).then(()=>setRevealLine(line)).catch(report);}} onError={report} revealLine={revealLine} extensions={extensions} onSave={() => void save()} />}</Suspense></ErrorBoundary>}
            {view === 'tools' && <ToolsPanel fileName={active || 'scratch.txt'} buffer={value} onApplyToBuffer={update} />}
            {view === 'ai' && <AiPanel key={activeRoot} context={value} instructions={config.instructions} root={activeRoot} tasks={config.tasks} onRead={agentRead} onEdit={agentEdit} onSaveEdits={saveProjectEdits} onTask={agentTask} onStopTask={()=>{cancelled.current=true;void invoke("cancel_task").catch(report);}} />}
            {view === 'languages' && <LanguagePanel root={activeRoot} configured={config.languageServers} connected={servers} onChange={setServers}/>}
            {view === 'search' && <SearchPanel root={activeRoot} onOpen={(path,line)=>{void openFile(path).then(()=>setRevealLine(line)).catch(report);}} /> }
            {view === 'extensions' && <ExtensionsPanel compatibility={compatibility} onCompatibility={enabled=>{setCompatibility(enabled);setView('editor');}} extensions={extensions} onChange={changeExtensions} onTheme={id=>{setPersonalJSON(JSON.stringify({...personal,theme:id}));setView('editor');}} />}
            {view === 'settings' && <section className="workbench-page"><h1>Workspace settings</h1><PreferencesPanel value={personal} onChange={v => setPersonalJSON(JSON.stringify(v))} /><label>Appearance<select value={theme} onChange={e => setTheme(e.target.value)}><option value="mac">macOS</option><option value="win">Windows / Linux</option></select></label><label>Layout<select value={layout} onChange={e => setLayout(e.target.value)}><option value="stacked">Terminal below editor</option><option value="side-by-side">Terminal beside editor</option></select></label>
              <h2>Project and directory overrides</h2><p>Detected in explorer directory: {detectBuildSystems(entries.map(e=>e.name)).join(", ")||"No build manifests detected"}</p><p>Each .afteredit.json overrides its ancestors. Editor settings and named tasks merge; rules and instructions replace the parent value. Task cwd is relative to the project root.</p><p>Scope: {scope || 'Open a project folder'}</p><select aria-label="Build environment preset" value={preset} onChange={e => setPreset(e.target.value)}>{Object.keys(presets).map(p => <option key={p}>{p}</option>)}</select><button disabled={!scope} onClick={() => void configure()}>Create configuration in this directory</button><button onClick={() => setRevision(n => n + 1)}>Reload configuration</button>
              {layers.map(path => <button key={path} onClick={() => void openFile(path).catch(report)}>{path}</button>)}<p role="alert">{configError}</p><h2>Effective settings</h2><pre>{JSON.stringify(config, null, 2)}</pre>
            </section>}
            {view === 'tasks' && <section className="workbench-page"><h1>Build workflows</h1><p>Commands use installed toolchains. Configure executable paths, arguments, environment variables, working directories and dependencies in .afteredit.json.</p><button onClick={() => setView('settings')}>Configure build environment</button><button onClick={() => setRevision(n => n + 1)}>Reload rules</button><p role="alert">{configError}</p>
              <label className="check"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)} /> I trust the commands shown for this project scope.</label>
              {Object.entries(config.workflows).map(([name,ids])=><button key={name} disabled={!trusted||running||!!configError} onClick={()=>void run(ids)}>Run workflow: {name} ({taskOrder(config.tasks,ids).join(' → ')})</button>)}
              {Object.entries(config.tasks).map(([id, task]) => <div className="task-row" key={id}><div><strong>{id}</strong><code>{task.command} {task.args.join(' ')}</code><small>cwd: {task.cwd ?? '.'} · dependencies: {(task.dependsOn ?? []).join(', ') || 'none'}</small>{task.env && <pre>{JSON.stringify(task.env, null, 2)}</pre>}</div><button disabled={!trusted || running || !!configError} onClick={() => void run([id])}>Run</button></div>)}
              {pendingTasks.length > 0 && <button disabled={!trusted || running || !!configError} onClick={() => void run(pendingTasks)}>Run tasks matched by save: {pendingTasks.join(', ')}</button>}
              {matchingRules(config,'manual',active.slice(activeRoot.length + 1).replace(/\\/g,'/')).map((r,i) => <button key={i} disabled={!trusted || running || !!configError} onClick={() => void run(r.tasks)}>Run rule: {r.tasks.join(', ')}</button>)}
              {running && <button onClick={() => { cancelled.current = true; void invoke('cancel_task').catch(report); }}>Stop workflow</button>}
              <details><summary>Recent workflow runs</summary>{history.filter(h=>h.root===activeRoot).map((h,i)=><p key={i}>{h.date} · {h.ids.join(", ")} · {h.success?"Passed":"Failed / stopped"}</p>)}</details>
              <pre className="task-log" role="log">{runLog || 'Task output will appear here.'}</pre><p>Save rules queue matching tasks for review. No project command runs just because you open or save a file. Use **/*.go style patterns relative to the project root.</p>
            </section>}
          </div>
        </main>
        <section className="terminal-panel"><div className="terminal-header">TERMINAL · {isTauri() ? 'Local shell' : 'Desktop only'}</div><ErrorBoundary>{isTauri() ? <TerminalPanel theme={theme === 'mac' ? 'mac' : 'win'} /> : <p className="recovery">Run npm run tauri dev to use the native terminal.</p>}</ErrorBoundary></section>
      </div>
    </div>
    <footer className="status-bar"><span role="status">{status}</span><span>{Object.values(buffers).filter(b => b.value !== b.saved).length} unsaved · {running ? 'Workflow running' : 'AfterEdit'}</span></footer>
    {palette && <div className="command-palette-overlay" onClick={() => setPalette(false)}><div className="command-palette" role="dialog" aria-label="Command palette" onClick={e => e.stopPropagation()}><input className="cp-input" autoFocus placeholder="Search commands…" value={query} onChange={e => setQuery(e.target.value)} />{commands.filter(c => c.title.toLowerCase().includes(query.toLowerCase())).map(c => <button className="cp-item" key={c.title} onClick={() => { setPalette(false); c.action(); }}>{c.title}</button>)}</div></div>}
  </div>;
}
export default App;
