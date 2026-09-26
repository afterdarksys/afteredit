import { menuCommands, editorCommands, type EditorMenuRequest } from './menuCommands';
import ApplePanel from './ApplePanel';
import {normalizeExtensionSettings,restoredExtensionSettings} from './extensionSettings';
import GitPanel from './GitPanel';
import { reconcileDisk } from './fileChanges';
import { useSoundCues } from './useSoundCues';
import OutputLog from './OutputLog';
import { AccessibilityContext, useReducedMotion } from './AccessibilityContext';
import CommandPalette from './CommandPalette';
import { cycleRegion, focusRegion } from './focus';
import AccessibilityPanel from './AccessibilityPanel';
import { restoreAccessibility } from './accessibility';
import InfrastructurePanel from './InfrastructurePanel';
import { detectInfrastructure, type InfrastructureDiagnostic } from './infrastructure';
import DebugPanel from './DebugPanel';
import { useDebugger } from './useDebugger';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { runTask, setTaskConfirmer, type Challenge } from './taskRunner';
import SharedWorkspacePanel from './SharedWorkspacePanel';
import RunMonitorPanel from './RunMonitorPanel';
import ProductionConfirm from './ProductionConfirm';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Cloud, Bug, Files, Search, Code, Wrench, Settings, Zap, Play, Package } from 'lucide-react';
import TerminalPanel from './TerminalPanel';
import ToolsPanel from './ToolsPanel';
import ErrorBoundary from './ErrorBoundary';
import AiPanel from './AiPanel';
import { relativePath, replaceUnique, rollbackChanges, type AgentChange } from './agent';
import { composeGuidance, discoverSkills, type Skill } from './guidance';
import type { SecretFinding } from './policy';
import { formatInspectDebug, formatInspectRun, prepareFailedTestLaunch } from './investigation';
import { runMonitor } from './runMonitor';
import { applyTextEdits, type FileEdits } from './workspaceEdit';
import LanguagePanel from './LanguagePanel';
import { detectBuildSystems, type ConnectedServer } from './languageServices';
import SearchPanel from './SearchPanel';
import FileTree from './FileTree';
import { applyDrafts } from './drafts';
import { retargetPath } from './fileOps';
import ExtensionsPanel from './ExtensionsPanel';
import { restoreExtensions, type Extension } from './extensions';
import PreferencesPanel from './PreferencesPanel';
import { editorDefaults, validateEditor, savedText } from './preferences';
import { formatText } from './externalFormatting';
import { languageForFilename } from './languages';
import EditorBridgeBanner, { type PendingEdit } from './EditorBridgeBanner';
import { History } from 'lucide-react';
import ContextBadge from './ContextBadge';
import HistoryPanel from './HistoryPanel';
import HttpPanel from './HttpPanel';
import { usePersistedState } from './usePersistedState';
import { defaults, matchingRules, expandTask, presets, resolveConfig, taskOrder, type ProjectConfig } from './workflows';
const CompatibilityEditor = lazy(() => import('./CompatibilityEditor'));
const CodeEditor = lazy(() => import('./CodeEditor'));
type Entry = { name: string; path: string; directory: boolean };
type Buffer = { value: string; saved: string; disk: boolean };
type View = 'shared' | 'apple' | 'git' | 'history' | 'http' | 'infrastructure' | 'debug' | 'editor' | 'tools' | 'settings' | 'tasks' | 'ai' | 'extensions' | 'search' | 'languages';
const parent = (path: string) => path.replace(/[\\/][^\\/]+$/, '');
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
function App() {
  const [accessibilityJSON, setAccessibilityJSON] = usePersistedState('accessibility.v1', '{}');
  const systemReducedMotion = useReducedMotion();
  const accessibility = restoreAccessibility(accessibilityJSON);
  const playCue = useSoundCues(accessibility);
  const effectiveAccessibility = {...accessibility,reducedMotion:accessibility.reducedMotion || systemReducedMotion};
  const [languageIntent,setLanguageIntent]=useState({root:'',language:'rust'});
  const [appleProblems,setAppleProblems]=useState<InfrastructureDiagnostic[]>([]);
  const [infrastructureProblems,setInfrastructureProblems]=useState<InfrastructureDiagnostic[]>([]);
  const [extensionSettingsRaw,setExtensionSettings]=usePersistedState('extension.settings.v1','{}');
  const extensionSettings=restoredExtensionSettings(extensionSettingsRaw);
  const persistExtensionSettings=(text:string)=>{const value=normalizeExtensionSettings(text);localStorage.setItem('extension.settings.v1',JSON.stringify(value));setExtensionSettings(value);};
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
  const [reveal,setReveal]=useState<{path:string;line:number}|null>(null);
  const [policyProblems,setPolicyProblems]=useState<InfrastructureDiagnostic[]>([]);
  const buffersRef=useRef(buffers);buffersRef.current=buffers;
  const activeRef=useRef('');
  const sideRef=useRef('');
  const [active, setActive] = useState('');
  const [diskChange,setDiskChange]=useState<{path:string;text?:string;error?:string}|null>(null);
  const [pendingEdit,setPendingEdit]=useState<PendingEdit|null>(null);
  // A destructive command aimed at production, waiting to be confirmed.
  const [challenge,setChallenge]=useState<{value:Challenge;settle:(typed:string|null)=>void}|null>(null);
  useEffect(()=>{
    setTaskConfirmer(value=>new Promise<string|null>(settle=>setChallenge({value,settle})));
  },[]);
  const rootRef=useRef('');
  const [reviewDisk,setReviewDisk]=useState(false);
  const [sessionReady,setSessionReady] = useState(!isTauri());
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState('');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sidebarVisible,setSidebarVisible]=useState(true),[terminalVisible,setTerminalVisible]=useState(true);
  const [aiSidebar,setAiSidebar]=usePersistedState('pref.aiSidebar','0');
  const [split,setSplit]=useState(false),[side,setSide]=useState('');
  const [treeTick,setTreeTick]=useState(0);
  const [draftsReady,setDraftsReady]=useState(!isTauri());
  const [editorMenu,setEditorMenu]=useState<EditorMenuRequest>();
  const [terminalMenu,setTerminalMenu]=useState<EditorMenuRequest>();
  useEffect(()=>{if(terminalMenu)window.dispatchEvent(new CustomEvent('afteredit:terminal-command',{detail:terminalMenu.id}));},[terminalMenu]);
  useEffect(()=>{
    if(!isTauri())return;
    let disposed=false,off=()=>{};
    void listen<Challenge>('pty:challenge', event=>{
      setChallenge({
        value:event.payload,
        settle:typed=>{void invoke('pty_confirm',{typed,root:rootRef.current||null}).catch(report);},
      });
    }).then(unlisten=>{if(disposed)unlisten();else off=unlisten;}).catch(report);
    return()=>{disposed=true;off();};
  },[]);
  const [editorReady,setEditorReady]=useState(false);
  const menuSequence=useRef(0),fileSequence=useRef(0);
  const [openEditorsOnly,setOpenEditorsOnly]=useState(false);
  const [view, setView] = useState<View>('editor');
  const [status, setStatus] = useState('Ready');
  const [config, setConfig] = useState<ProjectConfig>(defaults);
  const [agentsDoc, setAgentsDoc] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
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
  const runningRef = useRef(false);
  const [sharedDirty, setSharedDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = sharedDirty || Object.values(buffers).some(b => b.value !== b.saved);
  const cancelled = useRef(false);
  const [agentChanges,setAgentChanges]=useState<AgentChange[]>([]);
  const agentChangesRef=useRef(agentChanges);agentChangesRef.current=agentChanges;
  const activeBuffer = buffers[active];
  activeRef.current = active;
  sideRef.current = side;
  const sideBuffer = side ? buffers[side] : undefined;
  const value = activeBuffer?.value ?? scratch;
  const activeRoot = roots.filter(r => active.startsWith(r + '/') || active.startsWith(r + '\\')).sort((a,b) => b.length - a.length)[0] ?? (activeBuffer?.disk ? '' : root);
  rootRef.current = activeRoot;
  const [preparedDebug,setPreparedDebug]=useState<{config:import('./debugging').DebugConfig;origin:string;id:number}>();
  useEffect(()=>setPreparedDebug(undefined),[root]);
  const debug = useDebugger(root,activeBuffer?.disk?active:'',(path,line)=>{setCompatibility(false);void openFile(path).then(()=>{setReveal({path,line});setView('debug');}).catch(report);});
  const scope = !activeRoot ? '' : activeBuffer?.disk && (active.startsWith(activeRoot + '/') || active.startsWith(activeRoot + '\\')) ? parent(active) : directory || activeRoot;
  const update = (next: string) => { if (activeBuffer) setBuffers(b => ({ ...b, [active]: { ...b[active], value: next } })); else setScratch(next); };
  const report = (e: unknown) => { setStatus(String(e)); playCue('error'); };
  useEffect(()=>{if(debug.phase==="paused")playCue("paused");},[debug.phase,playCue]);
  useEffect(()=>{
    if(!isTauri())return;
    let disposed=false;
    void invoke<{roots:string[];files:string[];active:string;root:string;directory:string}>('restore_session').then(async session=>{
      const restored:Record<string,Buffer>={}; const failures:string[]=[]; let bytes=0;
      for(const path of session.files) {
        if(disposed)return;
        try {const value=await invoke<string>('read_file',{path});bytes+=value.length;if(bytes>16*1024*1024){failures.push('Remaining session files exceed the 16 MiB restore limit');break;}restored[path]={value,saved:value,disk:true};}
        catch {failures.push(path);}
      }
      if(disposed)return;
      let drafts: Array<{path:string;basis:string;value:string}> = [];
      try { drafts = await invoke('restore_drafts'); if (!disposed) setDraftsReady(true); } catch (error) { failures.push(String(error)); }
      const recovered = applyDrafts(restored, drafts);
      failures.push(...recovered.skipped.map(path => path + ' (unsaved draft skipped; the file changed on disk)'));
      setRoots(session.roots);setRoot(session.root);setBuffers(recovered.buffers);setActive(recovered.buffers[session.active]?session.active:'');
      if(session.directory)try{await browse(session.directory);}catch{failures.push(session.directory);}
      if(!disposed)setStatus(failures.length?'Session restored with unavailable files: '+failures.join(', '):'Previous session restored');
    }).catch(e=>{if(!disposed)report(e);}).finally(()=>{if(!disposed)setSessionReady(true);});
    return()=>{disposed=true;};
  },[]);
  useEffect(()=>{
    if(!isTauri() || !activeBuffer?.disk || !sessionReady)return;
    let disposed=false,checking=false;
    setDiskChange(null);setReviewDisk(false);
    const check=async()=>{
      if(disposed||checking)return;
      const before=buffersRef.current[active];if(!before)return;
      checking=true;
      try{
        const text=await invoke<string>('read_file',{path:active});
        if(disposed)return;
        const current=buffersRef.current[active];if(!current)return;
        const result=reconcileDisk(current,before.saved,text);
        if(result.stale)return;
        if(result.conflict)setDiskChange({path:active,text});
        else {
          setDiskChange(null);
          if(result.buffer!==current){
            setBuffers(buffers=>{const b=buffers[active];return b?{...buffers,[active]:reconcileDisk(b,before.saved,text).buffer}:buffers;});
            setStatus('Reloaded external changes in '+basename(active));
            if(basename(active)==='.afteredit.json')setRevision(n=>n+1);
          }
        }
      }catch(e){if(!disposed)setDiskChange({path:active,error:String(e)});}
      finally{checking=false;}
    };
    void check();const timer=setInterval(()=>void check(),3000);
    window.addEventListener('focus',check);
    return()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',check);};
  },[active,sessionReady]);
  const sessionFiles=JSON.stringify(Object.keys(buffers).filter(path=>buffers[path].disk));
  useEffect(()=>{
    if(!sessionReady || !isTauri())return;
    const timer=setTimeout(()=>{void invoke('save_session',{session:{roots,files:JSON.parse(sessionFiles),active,root,directory}}).catch(report);},300);
    return()=>clearTimeout(timer);
  },[sessionReady,roots,sessionFiles,active,root,directory]);
  const draftKey = JSON.stringify(Object.entries(buffers).filter(([,buffer]) => buffer.disk && buffer.value !== buffer.saved).map(([path,buffer]) => [path, buffer.saved, buffer.value]));
  useEffect(() => {
    if (!sessionReady || !draftsReady || !isTauri()) return;
    const timer = setTimeout(() => {
      const drafts = Object.entries(buffersRef.current).filter(([,buffer]) => buffer.disk && buffer.value !== buffer.saved).map(([path,buffer]) => ({path, basis: buffer.saved, value: buffer.value}));
      void invoke<{withheld:string[]}>('save_drafts', {drafts}).then(result => {
        if (result.withheld.length) setStatus('Unsaved drafts were not stored because they look like secrets or are too large to scan: ' + result.withheld.map(basename).join(', '));
      }).catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [sessionReady, draftsReady, draftKey]);
  useEffect(() => {
    if (!isTauri() || !sessionReady) return;
    let disposed = false;
    let off = () => {};
    void invoke('watch_project', {root}).catch(report);
    void listen<{paths:string[]}>('workspace:changed', event => {
      if (disposed) return;
      setTreeTick(tick => tick + 1);
      for (const path of event.payload.paths) {
        const before = buffersRef.current[path];
        if (!before?.disk) continue;
        void invoke<string>('read_file', {path}).then(text => {
          if (disposed) return;
          const current = buffersRef.current[path];
          if (!current) return;
          const result = reconcileDisk(current, before.saved, text);
          if (result.stale) return;
          if (result.conflict) {
            if (path === activeRef.current || path === sideRef.current) setDiskChange({path, text});
            else setStatus(`${basename(path)} changed on disk while it has unsaved edits`);
            return;
          }
          if (result.buffer !== current) {
            setBuffers(buffers => {
              const buffer = buffers[path];
              return buffer ? {...buffers, [path]: reconcileDisk(buffer, before.saved, text).buffer} : buffers;
            });
          }
        }).catch(() => {});
      }
    }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(report);
    return () => { disposed = true; off(); };
  }, [sessionReady, root]);
  useEffect(() => {
    document.body.classList.toggle('theme-mac', theme === 'mac');
    document.body.classList.toggle('theme-win', theme !== 'mac');
  }, [theme]);
  useEffect(() => {
    let stale = false;
    if (!activeRoot || !scope) { setConfig(resolveConfig([{editor:personal}])); setLayers([]); setAgentsDoc(''); setSkills([]); setConfigError(''); return; }
    setConfigError('Loading configuration…');
    invoke<Array<{ path: string; value: unknown }>>('project_config', { root: activeRoot, directory: scope }).then(result => {
      if (stale) return;
      setConfig(resolveConfig([{editor:personal}, ...result.map(l => l.value)])); setLayers(result.map(l => l.path)); setConfigError('');
    }).catch(e => { if (!stale) { setConfig(defaults); setConfigError(String(e)); } });
    void (async () => {
      let agents = '';
      try {
        const text = await invoke<string>('read_file', {path: `${activeRoot}/AGENTS.md`});
        const findings = await invoke<SecretFinding[]>('scan_buffer_secrets', {path: 'AGENTS.md', text});
        agents = findings.length ? '' : text.slice(0, 32000);
        if (findings.length && !stale) setStatus('AGENTS.md was not sent because it looks like it contains a secret.');
      } catch { agents = ''; }
      const found = await discoverSkills(activeRoot, path => invoke<Array<{name:string;path:string;directory:boolean}>>('list_directory', {path}), path => invoke<string>('read_file', {path}));
      if (!stale) { setAgentsDoc(agents); setSkills(found); }
    })();
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
  async function reloadFile(path = activeRef.current) {
    const buffer = buffersRef.current[path];
    if (!buffer?.disk) return;
    try {
      if(buffer.value!==buffer.saved && !await invoke<boolean>('confirm_discard'))return;
      const text = await invoke<string>('read_file', { path });
      setBuffers(b => ({ ...b, [path]: { value: text, saved: text, disk: true } }));
      setStatus(`Reloaded ${basename(path)}`);
      if (basename(path) === '.afteredit.json') setRevision(n => n + 1);
    } catch (e) { report(e); }
  }
  async function saveAs(snapshot = value, source = active) {
    try {
      const path = await invoke<string | null>('save_as', { content: snapshot });
      if (!path) return false;
      setBuffers(b => {const next={...b,[path]:{value:snapshot,saved:snapshot,disk:true}};if(source!==path&&b[source]&&!b[source].disk)delete next[source];return next;});
      setActive(path); setView('editor'); setStatus(`Created ${basename(path)}`);
      if (directory) await browse(directory);
      return true;
    } catch (e) { report(e); return false; }
  }
  async function browse(path: string) { const result = await invoke<Entry[]>('list_directory', { path }); setEntries(result); setDirectory(path); }
  async function openFile(path: string) {
    if (!buffers[path]) {
      const text = await invoke<string>('read_file', { path });
      setBuffers(b => ({ ...b, [path]: { value: text, saved: text, disk: true } }));
    }
    setActive(path); setView('editor');
  }
  async function openSide(path: string) {
    if (!path || path === activeRef.current) { setStatus('Choose another file for the second pane.'); return; }
    if (!buffersRef.current[path]) {
      const text = await invoke<string>('read_file', { path });
      setBuffers(current => ({...current, [path]: {value: text, saved: text, disk: true}}));
    }
    setSide(path); setSplit(true); setView('editor');
  }
  async function choose(directory: boolean) {
    try {
      const path = await invoke<string | null>('choose_path', { directory });
      if (!path) return;
      if (directory) { setRoots(r => r.includes(path) ? r : [...r, path]); setRoot(path); setActive(''); await browse(path); }
      else await openFile(path);
    } catch (e) { report(e); }
  }
  // A terminal command ($EDITOR) blocked on a file we opened for it.
  const bridge = useRef({ open: (_p: string) => Promise.resolve(), save: (_p: string): Promise<boolean> => Promise.resolve(false), report: (_e: unknown) => {} });
  const bridgeFinishing = useRef(false);
  useEffect(() => {
    if(!isTauri())return;
    let stop: (() => void) | undefined, dead = false;
    void listen<PendingEdit>('editor:request', async event => {
      try {
        if (event.payload.outsideWorkspace) { setPendingEdit(event.payload); return; }
        await bridge.current.open(event.payload.path); setPendingEdit(event.payload);
      }
      catch (e) { bridge.current.report(e); void invoke('editor_release', { id: event.payload.id, code: 1 }).catch(()=>{}); }
    }).then(off => { if (dead) off(); else stop = off; });
    return () => { dead = true; stop?.(); };
  }, []);

  async function openOutsideBridge() {
    const request = pendingEdit;
    if (!request?.outsideWorkspace) return;
    try {
      const path = await invoke<string>('editor_grant', { id: request.id });
      await bridge.current.open(path);
      setPendingEdit({ id: request.id, path, outsideWorkspace: false });
      setStatus('Opened '+basename(path)+' from the terminal');
    } catch (e) { report(e); }
  }

  async function finishBridgedEdit(code: number) {
    const request = pendingEdit;
    if (!request || bridgeFinishing.current) return;
    bridgeFinishing.current = true;
    try {
      // Save before releasing: git re-reads the file the instant we exit, and
      // an unmodified COMMIT_EDITMSG makes it abort.
      if (code === 0) {
        if (!buffersRef.current[request.path]?.disk) throw new Error('Open the requested file before saving and continuing.');
        if (!await bridge.current.save(request.path)) return;
      }
      await invoke('editor_release', { id: request.id, code });
      setStatus(code === 0 ? `Released ${basename(request.path)} to the terminal` : 'Terminal command aborted');
      setPendingEdit(current => current?.id === request.id ? null : current);
    } catch (e) { report(e); }
    finally { bridgeFinishing.current = false; }
  }

  async function save(path = activeRef.current): Promise<boolean> {
    const buffer = buffersRef.current[path];
    if (!buffer?.disk) { if (isTauri()) return saveAs(buffer?.value ?? value, path); setStatus('Scratch saved locally'); return true; }
    let formatted = buffer.value;
    if (config.editor.formatOnSave) {
      // Best effort: a missing or failing formatter must never block a save.
      try { formatted = (await formatText(languageForFilename(path), formatted)).text; }
      catch (e) { setStatus(`Saved without formatting: ${String(e)}`); }
    }
    // Formatting runs asynchronously. Never replace edits (or a new save
    // baseline) made while the formatter was working on the old snapshot.
    if (buffersRef.current[path] !== buffer) {
      setStatus(`Not saved: ${basename(path)} changed while formatting. Save again to include your latest edits.`);
      return false;
    }
    const snapshot = savedText(formatted, config.editor);
    try {
      await invoke('save_file', { path, content: snapshot, expected: buffer.saved });
      // Preserve typing during the disk write too. Apply formatting only to
      // the snapshot we saved, and advance the baseline to what reached disk.
      const complete = (current: Buffer): Buffer => ({...current, value: current.value === buffer.value && current.saved === buffer.saved ? snapshot : current.value, saved: snapshot});
      const current = buffersRef.current[path];
      const saved = current ? complete(current) : undefined;
      if (saved) buffersRef.current = {...buffersRef.current, [path]: saved};
      setBuffers(b => b[path] ? {...b, [path]: complete(b[path])} : b);
      const clean = !!saved && saved.value === saved.saved;
      setStatus(clean ? `Saved ${basename(path)}` : `Saved ${basename(path)}, but newer edits remain. Save again before continuing.`);
      window.dispatchEvent(new CustomEvent("afteredit:saved",{detail:{path,text:snapshot}}));
      if (basename(path) === '.afteredit.json') { setRevision(n => n + 1); return clean; }
      const relative = path.slice(activeRoot.length + 1).replace(/\\/g, '/');
      const ids = matchingRules(config,'save',relative).flatMap(r => r.tasks);
      if (ids.length) { setPendingTasks(ids); setView('tasks'); }
      return clean;
    } catch (e) { report(e); return false; }
  }
  useEffect(()=>{const open=(event:Event)=>{const {path,line}=(event as CustomEvent).detail;if(path.startsWith(root+'/'))void openFile(path).then(()=>{setReveal({path,line});setView('editor');}).catch(report);};window.addEventListener('afteredit:open-test-source',open);return()=>window.removeEventListener('afteredit:open-test-source',open);},[root]);
  async function run(ids: string[], approved=false):Promise<string> {
    if ((!trusted&&!approved) || configError || runningRef.current) throw new Error('Workflow unavailable: trust commands, wait for configuration, or stop the running task.');
    runningRef.current = true; cancelled.current = false; setRunning(true); setRunLog(''); setPendingTasks([]);
    let success=true;let transcript='';
    try {
      for (const id of taskOrder(config.tasks, ids)) {
        if (cancelled.current) break;
        const task = expandTask(config.tasks[id],{project:activeRoot,file:activeBuffer?.disk?active:''});
        setRunLog(log => log + `\n> ${id}: ${task.command} ${task.args.join(' ')}\n`);
        const {code,output} = await runTask(activeRoot, task.cwd ?? '.', task, {taskName:id});
        transcript+=`\n${id}:\n${output}\n[exit ${code}]\n`;
        setRunLog(log => log + `\n[exit ${code}]\n`);
        if (code !== 0) throw new Error(`Task ${id} failed (${code}); dependent tasks were skipped.`);
      }
    } catch (e) { success=false;transcript+='\n'+String(e);setRunLog(log => log + '\n' + String(e)); } finally { setHistoryJSON(JSON.stringify([{root:activeRoot,ids,date:new Date().toISOString(),success:success&&!cancelled.current},...history].slice(0,30)));runningRef.current = false; setRunning(false); }
    setStatus(success&&!cancelled.current ? "Workflow succeeded" : "Workflow failed or stopped");
    playCue(success&&!cancelled.current ? "success" : "error");
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
    const before=existing.value;
    const value=replaceUnique(before,oldText,newText);
    buffersRef.current={...buffersRef.current,[path]:{...existing,value}};
    setBuffers(current=>({...current,[path]:{...existing,value}}));
    setAgentChanges(changes=>[...changes,{path,before,after:value}]);
    return `Edited unsaved buffer ${relative}. Save it before running tasks.`;
  }
  /** Edits a language server wants to make in files other than the one on
   *  screen (a rename, a quick fix that touches a header). They land as
   *  unsaved buffers to review, never straight to disk, and every file is
   *  computed before any of them is committed so a bad edit set changes
   *  nothing. */
  async function applyWorkspaceEdit(files:FileEdits[]){
    const updates:Record<string,Buffer>={};
    for(const file of files){
      const existing=buffersRef.current[file.path];
      // Not open yet: take the file from disk, so a rename reaches code the
      // user has never had on screen.
      const disk=existing?null:await invoke<string>('read_file',{path:file.path});
      const base=existing??{value:disk!,saved:disk!,disk:true};
      updates[file.path]={...base,value:applyTextEdits(base.value,file.edits)};
    }
    buffersRef.current={...buffersRef.current,...updates};
    setBuffers(current=>({...current,...updates}));
    const names=Object.keys(updates).map(path=>basename(path));
    setStatus(`Changed ${names.length} other file${names.length===1?'':'s'}: ${names.join(', ')}. Review and save them.`);
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
  async function rollbackAgent(){
    const current=Object.fromEntries(Object.entries(buffersRef.current).map(([path,buffer])=>[path,buffer.value]));
    const result=rollbackChanges(agentChangesRef.current,current);
    setBuffers(buffers=>{
      const next={...buffers};
      for(const [path,value] of Object.entries(result.values))if(next[path])next[path]={...next[path],value};
      buffersRef.current=next;
      return next;
    });
    setAgentChanges([]);
    const restored=Object.keys(result.values).length;
    return restored?`Restored ${restored} file${restored===1?'':'s'}${result.skipped.length?`; left files you changed after the run: ${result.skipped.join(', ')}`:''}.`:'No run edits could be rolled back. The buffers no longer match what the run wrote.';
  }
  async function agentTask(name:string):Promise<string>{
    if(Object.entries(buffersRef.current).some(([path,b])=>(path.startsWith(activeRoot+'/')||path.startsWith(activeRoot+'\\'))&&b.value!==b.saved))throw new Error('Save modified project buffers before approving a task.');
    return run([name],true);
  }
  async function agentInspectRun(runId?:number){
    return formatInspectRun(runMonitor.getSnapshot(),activeRoot,runId);
  }
  async function agentProposeDebugLaunch(runId:number,testId:string){
    const tasks=Object.fromEntries(Object.entries(config.tasks).map(([id,task])=>{try{return [id,expandTask(task,{project:activeRoot,file:activeBuffer?.disk?active:''})];}catch{return [id,task];}}));
    const prepared=prepareFailedTestLaunch(runMonitor.getSnapshot(),activeRoot,tasks,config.debug,runId,testId);
    setPreparedDebug({config:prepared.config,origin:prepared.origin,id:Date.now()});
    setCompatibility(false);
    return prepared.preview;
  }
  async function agentInspectDebug(){
    return formatInspectDebug({phase:debug.phase,stopReason:debug.stopReason,frame:debug.frame,thread:debug.thread,watches:debug.tools.watches,values:debug.tools.values,snapshots:debug.tools.snapshots,exception:debug.tools.exception});
  }
  async function configure() {
    try {
      const content = JSON.stringify({ editor: defaults.editor, tasks: Object.fromEntries(Object.entries(presets[preset]).map(([id, task]) => [id, { ...task, cwd: scope.slice(activeRoot.length + 1) || '.' }])), rules: [], languageServers:preset==='Terraform'?{hcl:{command:'terraform-ls',args:['serve'],documentLanguage:'terraform'}}:preset==='OpenTofu'?{hcl:{command:'tofu-ls',args:['serve'],documentLanguage:'opentofu'}}:preset==='Ansible'?{ansible:{command:'ansible-language-server',args:['--stdio'],documentLanguage:'ansible'}}:{}, instructions: '' }, null, 2) + '\n';
      const path = await invoke<string>('create_config', { directory: scope, content });
      await openFile(path); setRevision(n => n + 1); await browse(scope);
    } catch (e) { report(e); }
  }
  async function closeEditors(paths:string[]) {
    if(paths.some(path=>buffersRef.current[path]?.value!==buffersRef.current[path]?.saved) && !await invoke<boolean>('confirm_discard'))return;
    setBuffers(current=>Object.fromEntries(Object.entries(current).filter(([path])=>!paths.includes(path))));
    if(paths.includes(active))setActive('');
    if(paths.includes(side))setSide('');
    setStatus('Editors closed');
  }
  async function saveAll() {
    for(const [path,buffer] of Object.entries(buffersRef.current)) {
      if(!buffer.disk){if(!await saveAs(buffer.value,path))return;continue;}
      if(buffer.value===buffer.saved)continue;
      const text=buffer.value;
      await invoke('save_file',{path,content:text,expected:buffer.saved});
      setBuffers(current=>current[path]?({...current,[path]:{...current[path],value:current[path].value===buffer.value?text:current[path].value,saved:text}}):current);
      window.dispatchEvent(new CustomEvent('afteredit:saved',{detail:{path,text}}));
    }
    setRevision(n=>n+1);setStatus('All open files saved');
  }
  bridge.current = { open: openFile, save, report };
  const editorCommandIds=editorCommands.map(c=>c.id);
  const enabledMenu=menuCommands.filter(({id})=>{
    if(!sessionReady)return false;
    if(editorCommandIds.includes(id))return editorReady&&(view==='editor'||view==='debug');
    if(id==='file.revert')return !!activeBuffer?.disk;
    if(id==='file.close')return !!activeBuffer;
    if(id==='file.close-all'||id==='file.save-all')return Object.keys(buffers).length>0;
    if(id==='file.close-folder')return !!root;
    if(id==='terminal.stop-task')return isTauri();
    if(id.startsWith('terminal.')&&id!=='terminal.workflows')return isTauri();
    return !id.startsWith('file.')||isTauri();
  }).map(c=>c.id);
  const enabledMenuJSON=JSON.stringify([...enabledMenu,...(sessionReady?['view.preferences']:[])]);
  useEffect(()=>{if(isTauri())void invoke('update_menu',{enabled:JSON.parse(enabledMenuJSON)}).catch(report);},[enabledMenuJSON]);
  async function dispatchMenu(id:string) {
    if(!sessionReady||(!enabledMenu.includes(id)&&id!=='view.preferences'))return;
    if(editorCommandIds.includes(id)){
      if(!editorReady)return;
      setEditorMenu({id,sequence:++menuSequence.current});return;
    }
    if(id==='file.new'){
      const path='inmemory://untitled-'+Date.now()+'-'+(++fileSequence.current)+'.txt';
      setBuffers(b=>({...b,[path]:{value:'',saved:'',disk:false}}));setActive(path);setView('editor');return;
    }
    if(id==='file.open')return choose(false);
    if(id==='file.folder')return choose(true);
    if(id==='file.save'){if(view==='shared'){window.dispatchEvent(new Event('afteredit:shared-save'));return;}return save();}
    if(id==='file.save-as')return saveAs();
    if(id==='file.save-all')return saveAll();
    if(id==='file.revert')return reloadFile();
    if(id==='file.close')return closeEditors([active]);
    if(id==='file.close-all')return closeEditors(Object.keys(buffersRef.current));
    if(id==='file.close-folder'){
      const paths=Object.keys(buffersRef.current).filter(path=>path.startsWith(root+'/'));
      if(paths.some(path=>buffersRef.current[path].value!==buffersRef.current[path].saved)&&!await invoke<boolean>('confirm_discard'))return;
      setBuffers(current=>Object.fromEntries(Object.entries(current).filter(([path])=>!paths.includes(path))));
      setRoots(current=>current.filter(path=>path!==root));setRoot('');setDirectory('');setEntries([]);setActive('');
      if(side.startsWith(root+'/'))setSide('');
      return;
    }
    if(id==='view.commands'||id==='view.open-editors'){setOpenEditorsOnly(id==='view.open-editors');setPalette(true);return;}
    if(id==='view.sidebar'){setSidebarVisible(v=>!v);return;}
    if(id==='view.terminal'){setTerminalVisible(v=>!v);return;}
    if(id==='view.layout'){setLayout(layout==='stacked'?'side-by-side':'stacked');return;}
    if(id.startsWith('view.zoom-')){const zoom=id==='view.zoom-reset'?100:Math.max(100,Math.min(200,accessibility.zoom+(id==='view.zoom-in'?25:-25)));setAccessibilityJSON(JSON.stringify({...accessibility,zoom}));return;}
    if(id==='go.next'||id==='go.previous'){
      const paths=['',...Object.keys(buffers)],index=paths.indexOf(active),offset=id==='go.next'?1:-1;
      setActive(paths[(index+offset+paths.length)%paths.length]);setView('editor');return;
    }
    if(id==='terminal.workflows') {setView('tasks');return;}
    if(id==='terminal.stop-task'){cancelled.current=true;await invoke('cancel_task');return;}
    if(id.startsWith('terminal.')){
      setTerminalVisible(true);setTerminalMenu({id:id.slice(9),sequence:++menuSequence.current});return;
    }
    if(id==='view.preferences'){setView('settings');return;}
    if(id.startsWith('view.')){const target=id.slice(5) as View;if(target==='debug')setCompatibility(false);setView(target);}
  }
  const menuHandler=useRef(dispatchMenu);menuHandler.current=dispatchMenu;
  useEffect(()=>{
    if(!isTauri())return;
    let disposed=false,off=()=>{};
    void listen<string>('menu:command',e=>{void menuHandler.current(e.payload).catch(report);}).then(unlisten=>{if(disposed)unlisten();else off=unlisten;}).catch(report);
    return()=>{disposed=true;off();};
  },[]);
  const commands = openEditorsOnly ? [{title:'Scratch',action:()=>{setActive('');setView('editor');}},...Object.keys(buffers).map(path=>({title:path,action:()=>{setActive(path);setView('editor');}}))] : [
    ...(['workbench-navigation','explorer','workspace','terminal'] as const).map(id=>({title:'Focus '+id,action:()=>{if(id==='explorer')setSidebarVisible(true);if(id==='terminal')setTerminalVisible(true);requestAnimationFrame(()=>focusRegion(id));}})),
    {title:'Shared workspace and CLI',action:()=>setView('shared')},
    {title:'Accessibility settings',action:()=>setView('settings')},
    ...menuCommands.filter(c=>enabledMenu.includes(c.id)&&!c.id.startsWith('window.')&&c.id!=='view.commands').map(c=>({title:c.title,action:()=>{void dispatchMenu(c.id).catch(report);}})),
  ];
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F6' && !palette) { e.preventDefault(); cycleRegion(e.shiftKey); return; }
      if (palette) return;
      if (e.defaultPrevented) return;
      if (view !== 'shared' && !isTauri() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !(config.editor.keymap === 'emacs' && e.ctrlKey && !e.metaKey)) { e.preventDefault(); void save(); }
      if (!isTauri() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); void choose(e.shiftKey); }
      if (!isTauri() && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setOpenEditorsOnly(false); setPalette(p => !p); }
      if (e.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', handler, true); return () => window.removeEventListener('keydown', handler, true);
  });
  return <AccessibilityContext.Provider value={effectiveAccessibility}><div className="app-container" data-contrast={accessibility.contrast} data-reduced-motion={accessibility.reducedMotion} style={{zoom:accessibility.zoom/100,width:`${10000/accessibility.zoom}vw`,height:`${10000/accessibility.zoom}vh`}}>
    <a className="skip-link" href="#workspace" onClick={e=>{e.preventDefault();focusRegion('workspace');}}>Skip to workspace</a>
    <header data-tauri-drag-region className="titlebar"><strong>AfterEdit</strong><span>{activeRoot ? basename(activeRoot) : 'Developer workbench'}</span><button onClick={() => {setOpenEditorsOnly(false);setPalette(true);}}>Commands ⌘⇧P</button></header>
    {!isTauri() && <div className="notice">Browser preview: scratch editing and tools work here. Open the desktop app for filesystem, builds, terminal and AI.</div>}
    {!sessionReady && <div role="status" className="session-loading">Restoring previous session…</div>}
    <div className="main-content" inert={!sessionReady}>
      <nav id="workbench-navigation" tabIndex={-1} data-focus-region className="activity-bar" aria-label="Workbench">{([
        ['editor', Files, 'Files'], ['shared', Code, 'Shared workspace'], ['apple', Code, 'Apple development'], ['git', Code, 'Source control'], ['history', History, 'Local history'], ['http', Zap, 'HTTP requests'], ['debug', Bug, 'Run and debug'], ['infrastructure', Cloud, 'Infrastructure'], ['search', Search, 'Project search'], ['languages',Code,'Language services'], ['tasks', Play, 'Build workflows'], ['tools', Wrench, 'Developer tools'], ['ai', Zap, 'AI assistant'], ['extensions', Package, 'Extensions'], ['settings', Settings, 'Settings'],
      ] as const).map(([id, Icon, title]) => <button key={id} title={title} aria-label={title} aria-pressed={id==='ai'?aiSidebar==='1':view === id} className={(id==='ai'?aiSidebar==='1':view === id) ? 'selected' : ''} onClick={() => {if(id==='ai'){setAiSidebar(aiSidebar==='1'?'0':'1');setView('editor');return;}if(id==='debug')setCompatibility(false);setView(id);}}><Icon size={21} /></button>)}</nav>
      <aside style={{display:sidebarVisible?undefined:'none'}} id="explorer" aria-label="File explorer" tabIndex={-1} data-focus-region className="sidebar"><div className="sidebar-header">EXPLORER</div><div className="explorer-actions"><button disabled={!isTauri()} onClick={() => void choose(false)}>Open file</button><button disabled={!isTauri()} onClick={() => void choose(true)}>Add folder</button></div>
        {roots.length > 0 && <select aria-label="Project" value={root} onChange={e => { const path = e.target.value; setRoot(path); setActive(''); void browse(path).catch(report); }}>{roots.map(r => <option key={r}>{r}</option>)}</select>}
        <div className="sidebar-content"><button className="file-item" onClick={() => { setActive(''); setView('editor'); }}>Scratch</button>
          {root ? <FileTree root={root} active={active} tick={treeTick} onOpen={path => void openFile(path).catch(report)} onOpenSide={path => void openSide(path).catch(report)} onSelectDirectory={path => { setDirectory(path); void browse(path).catch(report); }} onRenamed={(from, to) => { setBuffers(current => Object.fromEntries(Object.entries(current).map(([path, buffer]) => [retargetPath(path, from, to), buffer]))); setActive(current => retargetPath(current, from, to)); setSide(current => retargetPath(current, from, to)); setTreeTick(tick => tick + 1); }} onDeleted={path => { setBuffers(current => Object.fromEntries(Object.entries(current).filter(([item]) => item !== path && !item.startsWith(path + '/') && !item.startsWith(path + '\\')))); if (active === path || active.startsWith(path + '/')) setActive(''); if (side === path || side.startsWith(path + '/')) setSide(''); setTreeTick(tick => tick + 1); }} report={report} /> : entries.map(entry => <button className={`file-item ${active === entry.path ? 'active' : ''}`} key={entry.path} aria-label={`${entry.directory ? "Folder" : "File"}: ${entry.name}`} aria-current={active===entry.path ? "true" : undefined} title={entry.path} onClick={() => void (entry.directory ? (setActive(''), browse(entry.path)) : openFile(entry.path)).catch(report)}>{entry.directory ? '▸' : '·'} {entry.name}</button>)}
        </div>
      </aside>
      <div className={`center-area layout-${layout === 'side-by-side' ? 'side-by-side' : 'stacked'}`}>
        <main id="workspace" aria-label="Workspace" tabIndex={-1} data-focus-region className="editor-area"><div className="editor-tabs"><button className="editor-tab" onClick={() => { setView('editor'); setActive(''); }}>Scratch</button>{Object.entries(buffers).map(([path,b]) => <button key={path} aria-pressed={active===path} aria-label={`${path}${b.value!==b.saved ? ", unsaved changes" : ", saved"}`} title={path} className={`editor-tab ${active === path ? 'active' : ''}`} onClick={() => { setActive(path); setView('editor'); }}>{basename(path)}{b.value !== b.saved ? ' ●' : ''}</button>)}<button disabled={!isTauri()} onClick={() => void save()}>Save</button><button disabled={!isTauri()} onClick={() => void saveAs()}>Save as</button><button disabled={!activeBuffer?.disk} onClick={() => void reloadFile()}>Reload from disk (discard edits)</button><button onClick={() => setSplit(open => !open)}>{split ? 'Close split' : 'Split editor'}</button></div>
          {pendingEdit&&<EditorBridgeBanner
            pending={pendingEdit}
            dirty={!!buffers[pendingEdit.path]&&buffers[pendingEdit.path].value!==buffers[pendingEdit.path].saved}
            opened={!!buffers[pendingEdit.path]}
            onOpenOutside={()=>void openOutsideBridge()}
            onFinish={()=>void finishBridgedEdit(0)}
            onAbort={()=>void finishBridgedEdit(1)}
          />}
          {diskChange&&(diskChange.path===active||diskChange.path===side)&&<section className="disk-change" aria-label="External file change">
            <p role="status">{diskChange.error ? 'File unavailable on disk: '+diskChange.error : 'This file changed on disk. Your unsaved edits are preserved.'}</p>
            {diskChange.text!==undefined&&<><button onClick={()=>setReviewDisk(v=>!v)}>Review disk version</button>
            <button onClick={()=>{if(window.confirm('Discard your unsaved edits and reload the current disk version?'))void reloadFile(diskChange.path);}}>Reload disk version (discard edits)</button>
            <button onClick={()=>{const text=diskChange.text!;const path=diskChange.path;setBuffers(b=>b[path]?({...b,[path]:{...b[path],saved:text}}):b);setDiskChange(null);setStatus('Kept your edits. Save to replace the reviewed disk version.');}}>Keep my edits against this disk version</button>
            {reviewDisk&&<textarea readOnly aria-label="Current disk version" value={diskChange.text}/>}</>}
            <button onClick={()=>void saveAs()}>Save my buffer as a new file</button>
          </section>}
          <div className="breadcrumbs">{view === 'editor' ? active || 'Local scratch buffer' : view}</div>
          <div className="editor-container">
            <div className={split && sideBuffer && view==='editor' ? 'editor-split' : undefined} style={{display:(view==='editor'||view==='debug')?'flex':'none',flex:1,minWidth:0,minHeight:0,flexDirection:split && sideBuffer && view==='editor' ? 'row' : 'column'}}>
            <ErrorBoundary key={active || 'scratch'} fallback={<textarea aria-label="Recovery text editor" className="fallback-editor" value={value} onChange={e => update(e.target.value)} />}><Suspense fallback={<div className="recovery"><p>Loading syntax editor… You can edit below while it loads.</p><textarea aria-label="Loading text editor" className="fallback-editor" value={value} onChange={e => update(e.target.value)} /></div>}>{compatibility ? <CompatibilityEditor menuRequest={editorMenu} onReady={setEditorReady} root={activeRoot} settingsJSON={extensionSettings} onSettingsChange={persistExtensionSettings} key={extensionRevision+":"+activeRoot} path={active || 'inmemory://scratch.txt'} value={value} onChange={update} options={config.editor} extensions={extensions} onSave={() => void save()} /> : <CodeEditor menuRequest={editorMenu} onReady={setEditorReady} infrastructureDiagnostics={[...infrastructureProblems,...appleProblems,...policyProblems]} breakpoints={debug.points} onToggleBreakpoint={debug.toggle} debugLocation={debug.phase==='paused'&&debug.frame?.source?.path?{path:debug.frame.source.path,line:debug.frame.line}:undefined} path={active || 'inmemory://scratch.txt'} value={value} onChange={update} options={config.editor} servers={servers} onNavigate={(path,line)=>{void openFile(path).then(()=>setReveal({path,line})).catch(report);}} onError={report} onWorkspaceEdit={applyWorkspaceEdit} reveal={reveal} onRevealConsumed={()=>setReveal(null)} extensions={extensions} onSave={() => void save()} />}</Suspense></ErrorBoundary>
            {split && sideBuffer && view==='editor' && <ErrorBoundary key={side}><Suspense fallback={<p>Loading second editor…</p>}><CodeEditor onReady={()=>{}} infrastructureDiagnostics={[...infrastructureProblems,...appleProblems,...policyProblems]} breakpoints={debug.points} onToggleBreakpoint={debug.toggle} debugLocation={debug.phase==='paused'&&debug.frame?.source?.path?{path:debug.frame.source.path,line:debug.frame.line}:undefined} path={side} value={sideBuffer.value} onChange={next => setBuffers(current => current[side] ? {...current, [side]: {...current[side], value: next}} : current)} options={config.editor} servers={servers} onNavigate={(path,line)=>{void openFile(path).then(()=>setReveal({path,line})).catch(report);}} onError={report} onWorkspaceEdit={applyWorkspaceEdit} reveal={null} onRevealConsumed={()=>{}} extensions={extensions} onSave={() => void save(side)} /></Suspense></ErrorBoundary>}
            </div>
            {(view==='debug'||((view==='editor')&&debug.phase!=='idle'))&&<DebugPanel debug={debug} active={active} dirty={Object.entries(buffers).some(([path,b])=>path.startsWith(root+'/')&&b.value!==b.saved)} configured={config.debug} prepared={preparedDebug}/>}
            {view==='http' && <HttpPanel fileName={active||'scratch'} buffer={value} onOpenLine={line=>{setView('editor');setReveal({path:active||'inmemory://scratch.txt',line});}}/>}
            {view==='history' && <HistoryPanel path={activeBuffer?.disk?active:''} current={value} onRestore={text=>update(text)}/>}
            {<div style={{display:view==='infrastructure'?'flex':'none',flex:1,minWidth:0}}><InfrastructurePanel root={activeRoot} file={activeBuffer?.disk?active:''} dirty={Object.entries(buffers).some(([path,b])=>path.startsWith(activeRoot+'/')&&b.value!==b.saved)} detected={detectInfrastructure(entries.map(e=>e.name))} onDiagnostics={setInfrastructureProblems} onPolicyDiagnostics={setPolicyProblems} onOpen={(path,line)=>{void openFile(path).then(()=>setReveal({path,line})).catch(report);}} onConfigure={preset=>{setPreset(preset);setView('settings');}} onDebug={()=>{setCompatibility(false);setView('debug');}}/></div>}
            <div style={{display:view==='apple'?'flex':'none',flex:1,minWidth:0,minHeight:0}}><ApplePanel key={activeRoot} root={activeRoot} active={active} onLanguage={project=>{setLanguageIntent({root:project.endsWith('Package.swift')?activeRoot+(project.includes('/')?'/'+project.slice(0,project.lastIndexOf('/')):'' ):activeRoot,language:'swift'});setView('languages');}} dirty={Object.entries(buffers).some(([path,b])=>path.startsWith(activeRoot+'/')&&b.value!==b.saved)} onProblems={setAppleProblems} onDebug={config=>{localStorage.setItem('debug.config:'+activeRoot,JSON.stringify(config));setRoot(activeRoot);setCompatibility(false);setView('debug');}} onOpen={(path,line)=>{void openFile(path).then(()=>{setReveal({path,line});setView('editor');}).catch(report);}}/></div>
            {view === 'git' && <GitPanel key={root} root={root} dirty={Object.entries(buffers).some(([path,b])=>path.startsWith(root+'/')&&b.value!==b.saved)} onOpen={path=>void openFile(path).catch(report)}/>}
            <div style={{display:view==='shared'?'flex':'none',flex:1,minWidth:0,minHeight:0}}><SharedWorkspacePanel root={activeRoot} onDirty={setSharedDirty}/></div>
            {view === 'tools' && <ToolsPanel fileName={active || 'scratch.txt'} buffer={value} onApplyToBuffer={update} />}

            {view === 'languages' && <LanguagePanel initialLanguage={languageIntent.language} root={languageIntent.root===activeRoot||languageIntent.root.startsWith(activeRoot+'/')?languageIntent.root:activeRoot} configured={config.languageServers} connected={servers} onChange={setServers}/>}
            {view === 'search' && <SearchPanel root={activeRoot} servers={servers} dirty={Object.entries(buffers).filter(([,buffer])=>buffer.value!==buffer.saved).map(([path])=>path)} onReplaced={paths=>{for (const path of paths) void invoke<string>('read_file',{path}).then(text=>setBuffers(current=>current[path]?{...current,[path]:{value:text,saved:text,disk:true}}:current)).catch(report);}} onOpen={(path,line)=>{void openFile(path).then(()=>setReveal({path,line})).catch(report);}} /> }
            {view === 'extensions' && <ExtensionsPanel settingsJSON={extensionSettings} onSettingsChange={persistExtensionSettings} compatibility={compatibility} onCompatibility={enabled=>{setCompatibility(enabled);setView('editor');}} extensions={extensions} onChange={changeExtensions} onTheme={id=>{setPersonalJSON(JSON.stringify({...personal,theme:id}));setView('editor');}} />}
            {view === 'settings' && <section className="workbench-page"><h1>Workspace settings</h1><AccessibilityPanel onTestSound={()=>playCue('success')} value={accessibility} onChange={v=>setAccessibilityJSON(JSON.stringify(v))}/><PreferencesPanel value={personal} onChange={v => setPersonalJSON(JSON.stringify(v))} /><label>Appearance<select value={theme} onChange={e => setTheme(e.target.value)}><option value="mac">macOS</option><option value="win">Windows / Linux</option></select></label><label>Layout<select value={layout} onChange={e => setLayout(e.target.value)}><option value="stacked">Terminal below editor</option><option value="side-by-side">Terminal beside editor</option></select></label>
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
              <RunMonitorPanel root={activeRoot} tasks={Object.fromEntries(Object.entries(config.tasks).map(([id,task])=>{try{return [id,expandTask(task,{project:activeRoot,file:activeBuffer?.disk?active:''})];}catch{return [id,task];}}))} configured={config.debug} allowed={trusted&&!configError&&!running&&!Object.entries(buffers).some(([path,b])=>path.startsWith(activeRoot+'/')&&b.value!==b.saved)} onDebug={(config,origin)=>{setPreparedDebug({config,origin,id:Date.now()});setView('debug');}} />
              <OutputLog label="Workflow output">{runLog || 'Task output will appear here.'}</OutputLog><p>Save rules queue matching tasks for review. No project command runs just because you open or save a file. Use **/*.go style patterns relative to the project root.</p>
            </section>}
          </div>
        </main>
        <section style={{display:terminalVisible?undefined:'none'}} id="terminal" aria-label="Terminal" tabIndex={-1} data-focus-region className="terminal-panel"><div className="terminal-header">TERMINAL · {isTauri() ? 'Local shell' : 'Desktop only'}</div><ErrorBoundary>{isTauri() ? <TerminalPanel theme={theme === 'mac' ? 'mac' : 'win'} root={activeRoot} /> : <p className="recovery">Run npm run tauri dev to use the native terminal.</p>}</ErrorBoundary></section>
      </div>
      {activeRoot && <aside className="ai-sidebar" style={{display:aiSidebar==='1'?'flex':'none'}} aria-label="AI assistant"><AiPanel key={activeRoot} context={value} contextPath={active||'Scratch'} openFiles={Object.entries(buffers).filter(([,buffer])=>buffer.disk).map(([path,buffer])=>({path,text:buffer.value}))} instructions={composeGuidance({agents: agentsDoc, instructions: config.instructions})} root={activeRoot} tasks={config.tasks} skills={skills} mcp={config.mcp} onRead={agentRead} onEdit={agentEdit} onSaveEdits={saveProjectEdits} onTask={agentTask} onInspectRun={agentInspectRun} onProposeDebugLaunch={agentProposeDebugLaunch} onInspectDebug={agentInspectDebug} onStopTask={()=>{cancelled.current=true;void invoke("cancel_task").catch(report);}} changes={agentChanges.length} onRollback={rollbackAgent} onRunStart={()=>setAgentChanges([])} servers={servers} onOpenFile={(path,line)=>{const full=path.startsWith('/')?path:`${activeRoot}/${path}`;void openFile(full).then(()=>setReveal({path:full,line})).catch(report);}} onOpenRoot={path=>{setRoots(current=>current.includes(path)?current:[...current,path]);setRoot(path);setActive('');void browse(path).catch(report);}} /></aside>}
    </div>
    <span className="sr-only" role="status" aria-atomic="true">{view}. {active || "Scratch"}{activeBuffer && activeBuffer.value!==activeBuffer.saved ? ", unsaved changes" : ""}</span>
    <span className="sr-only" role="status" aria-atomic="true">{debug.phase==="paused" ? `Debugger paused at ${debug.frame?.source?.path ?? "unknown source"}, line ${debug.frame?.line ?? "unknown"}` : ""}</span>
    {challenge && <ProductionConfirm
        challenge={challenge.value}
        onConfirm={typed=>{challenge.settle(typed);setChallenge(null);}}
        onCancel={()=>{challenge.settle(null);setChallenge(null);}}
      />}
      <footer className="status-bar"><span role="status">{status}</span><ContextBadge root={activeRoot} revision={revision}/><span>{Object.values(buffers).filter(b => b.value !== b.saved).length} unsaved · {running ? 'Workflow running' : 'AfterEdit'}</span></footer>
    {palette && <CommandPalette commands={commands} onClose={()=>setPalette(false)}/>}
  </div></AccessibilityContext.Provider>;
}
export default App;
