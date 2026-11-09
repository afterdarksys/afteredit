import type { DebugConfig } from './debugging';
import { listen } from '@tauri-apps/api/event';
import OutputLog from './OutputLog';
import type { InfrastructureDiagnostic } from './infrastructure';
import { useEffect, useRef, useState } from 'react';
import { runTask } from './taskRunner';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { autotoolsNote, clangdDraft, kernelNote, manRequest, pkgRequest, unixBuild, unixDebug, unixDiagnostics, unixShapes, type UnixProject, type UnixShape } from './unixDevelopment';

type Tool = { name: string; available: boolean; detail: string };
type Plan = { tasks: { command: string; args: string[]; cwd?: string }[]; note?: string };
const emptyProject: UnixProject = { cmake: [], makefiles: [], meson: [], autotools: [], kernel: [], compileCommands: [] };

export default function UnixPanel({ root, dirty, onOpen, onProblems, onDebug, onLanguage }: { root: string; dirty: boolean; onOpen: (path: string, line: number) => void; onProblems: (problems: InfrastructureDiagnostic[]) => void; onDebug: (config: DebugConfig) => void; onLanguage: (intent: { root: string; language: string; draft?: string }) => void }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [project, setProject] = useState<UnixProject>(emptyProject);
  const [shapes, setShapes] = useState<UnixShape[]>([]);
  const [shapeId, setShapeId] = useState('');
  const [buildDir, setBuildDir] = useState('build');
  const [makeTarget, setMakeTarget] = useState('');
  const [binary, setBinary] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [runningTask, setRunningTask] = useState(false);
  const [output, setOutput] = useState('');
  const [problems, setProblems] = useState<InfrastructureDiagnostic[]>([]);
  const [page, setPage] = useState('');
  const [section, setSection] = useState('');
  const [reference, setReference] = useState('');
  const [packageName, setPackageName] = useState('');
  const [packageFlags, setPackageFlags] = useState('');
  const shape = shapes.find(item => item.id === shapeId);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const running = useRef(false), cancelled = useRef(false);
  useEffect(() => { if (plan) reviewHeading.current?.focus(); }, [plan]);
  useEffect(() => () => { cancelled.current = true; if (running.current) void invoke('cancel_task').catch(() => {}); }, []);

  function selectShape(id: string) {
    const next = shapes.find(item => item.id === id);
    setShapeId(id);
    setMakeTarget(next?.targets[0] ?? '');
    setPlan(null);
    setTrusted(false);
  }
  async function checkTools() {
    setBusy(true);
    setStatus('Checking installed tools…');
    try {
      setTools(await invoke<Tool[]>('unix_toolchain'));
      setStatus('Installed tools checked. Nothing was built.');
    } catch (error) { setStatus(String(error)); } finally { setBusy(false); }
  }
  async function discover() {
    setPlan(null);
    setTrusted(false);
    setBusy(true);
    setStatus('Reading project files…');
    try {
      const found = await invoke<UnixProject>('unix_project', { root });
      const next = unixShapes(found);
      setProject(found);
      setShapes(next);
      setShapeId(next[0]?.id ?? '');
      setMakeTarget(next[0]?.targets[0] ?? '');
      setStatus(next.length ? 'Project shapes discovered. Review a command before it runs.' : 'No CMake, Make, Meson, Autotools, or kernel-shaped tree was found.');
    } catch (error) { setStatus(String(error)); } finally { setBusy(false); }
  }
  function prepare(action: 'build' | 'test') {
    setPlan(null);
    if (!shape) { setStatus('Discover a project shape first.'); return; }
    try {
      const built = unixBuild(shape.kind, { source: shape.source, build: buildDir, target: makeTarget, targets: shape.targets, makefile: shape.makefile, action });
      if (!built.tasks.length) { setStatus(built.note ?? 'No reviewed command for this shape.'); return; }
      setPlan(built);
      setStatus(built.note ?? 'Review the commands, then run.');
    } catch (error) { setStatus(String(error)); }
  }
  async function execute() {
    if (!plan || running.current) return;
    running.current = true;
    cancelled.current = false;
    setBusy(true);
    setRunningTask(true);
    setOutput('');
    setProblems([]);
    onProblems([]);
    let off = () => {}, combined = '';
    try {
      off = await listen<{ text: string }>('task:output', event => { if (running.current) setOutput(value => (value + event.payload.text).slice(-200000)); });
      for (const task of plan.tasks) {
        if (cancelled.current) break;
        const result = await runTask(root, task.cwd ?? '.', task);
        combined = (combined + '\n' + result.output).slice(-200000);
        const found = unixDiagnostics(result.output, root, task.cwd ?? '.');
        setProblems(value => [...value, ...found]);
        onProblems(unixDiagnostics(combined, root, task.cwd ?? '.'));
        if (result.code !== 0) throw new Error('Unix command exited ' + result.code + '. See output.');
      }
      setStatus(cancelled.current ? 'Unix action stopped.' : 'Unix action completed.');
    } catch (error) { setStatus(String(error)); } finally {
      off();
      running.current = false;
      setRunningTask(false);
      setBusy(false);
      setOutput(previous => previous || combined || 'No command output captured.');
    }
  }
  async function lookupMan() {
    setBusy(true);
    try {
      const request = manRequest(page, section);
      setReference(await invoke<string>('unix_man', request));
      setStatus('Manual page loaded.');
    } catch (error) { setStatus(String(error)); } finally { setBusy(false); }
  }
  async function lookupPackage() {
    setBusy(true);
    try {
      const name = pkgRequest(packageName);
      const result = await invoke<{ found: boolean; detail: string }>('unix_pkg_config', { name });
      setPackageFlags(result.found ? result.detail : 'Package not found' + (result.detail ? '\n' + result.detail : ''));
      setStatus(result.found ? 'Package flags loaded.' : 'Package not found.');
    } catch (error) { setStatus(String(error)); } finally { setBusy(false); }
  }
  function openClangd() {
    const database = project.compileCommands[0];
    onLanguage({ root, language: 'cpp', draft: JSON.stringify(clangdDraft(database), null, 2) });
  }
  let preview = 'man -P cat';
  try {
    const request = manRequest(page, section);
    preview = 'man -P cat' + (request.section ? ' ' + request.section : '') + ' ' + request.page;
  } catch { /* The lookup button reports the name error. */ }
  const needsBuild = shape?.kind === 'cmake' || shape?.kind === 'meson';
  const needsTarget = shape?.kind === 'make' || shape?.kind === 'kernel';
  return <section className="workbench-page"><h1>Unix development</h1>
    <p>Xcode builds Apple platforms. This page is the Unix side of the same Mac: the compiler, Make, CMake, Meson, pkg-config, man pages, and LLDB that are installed on the machine, shown as one project. Opening it runs nothing. It is not a remote Linux workspace, not a kernel menuconfig screen, and not a virtual-machine launcher. Rust and Go stay in Build workflows.</p>
    <p>Make targets are names read from the makefile. Recipes are not executed to discover them. ./configure is a project script, so it is not offered as a reviewed task; use the terminal, then build with make here. Cross-compile variables such as ARCH and CROSS_COMPILE are not set by this page. QEMU is detected only.</p>
    <button disabled={!isTauri() || busy} onClick={() => void checkTools()}>Check installed tools</button>
    <button disabled={!isTauri() || busy || !root} onClick={() => void discover()}>Discover project</button>
    <p role="status">{status}</p>
    {tools.map(tool => <p key={tool.name}>{tool.name}: {tool.available ? 'available' : 'unavailable'}. {tool.detail}</p>)}
    <h2>Project shape</h2>
    <p>Discovery reads the opened folder and two levels of subdirectories. It skips generated trees. A compilation database at the project root, in build/, or in out/ is still listed.</p>
    <label>Project shape<select disabled={busy || !shapes.length} value={shapeId} onChange={event => selectShape(event.target.value)}><option value="">Discover a project first</option>{shapes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    {needsBuild && <label>Build directory<input disabled={busy} value={buildDir} onChange={event => { setBuildDir(event.target.value); setPlan(null); }} /></label>}
    {needsTarget && shape && <label>Make target<select disabled={busy || !shape.targets.length} value={makeTarget} onChange={event => { setMakeTarget(event.target.value); setPlan(null); }}><option value="">No target read from the makefile</option>{shape.targets.map(target => <option key={target}>{target}</option>)}</select></label>}
    {shape?.kind === 'autotools' && <p>{autotoolsNote}</p>}
    {shape?.kind === 'kernel' && <p>{kernelNote}</p>}
    <label className="check"><input type="checkbox" checked={trusted} disabled={busy} onChange={event => setTrusted(event.target.checked)} /> Trust Unix commands for this project</label>
    <h2>Build and test</h2>
    <button disabled={busy || !trusted || dirty || !shape} onClick={() => prepare('build')}>Prepare build</button>
    <button disabled={busy || !trusted || dirty || !shape} onClick={() => prepare('test')}>Prepare test</button>
    {dirty && <p>Save modified project files before running Unix commands.</p>}
    {plan && <section aria-label="Unix command review"><h3 ref={reviewHeading} tabIndex={-1}>Command review</h3>{plan.note && <p>{plan.note}</p>}<pre tabIndex={0}>{JSON.stringify(plan.tasks, null, 2)}</pre><button disabled={busy || !trusted || dirty || !isTauri()} onClick={() => void execute()}>Run reviewed commands</button></section>}
    {runningTask && <button onClick={() => { cancelled.current = true; void invoke('cancel_task').catch(error => setStatus(String(error))); }}>Stop Unix action</button>}
    <h2>Reference</h2>
    <p>These lookups use a fixed argument list.</p>
    <p>{preview}</p>
    <label>Man page<input disabled={busy} value={page} onChange={event => setPage(event.target.value)} /></label>
    <label>Manual section<input disabled={busy} value={section} onChange={event => setSection(event.target.value)} /></label>
    <button disabled={busy || !isTauri()} onClick={() => void lookupMan()}>Look up man page</button>
    <pre tabIndex={0} aria-label="Unix reference">{reference || 'Manual text appears here.'}</pre>
    <label>pkg-config package<input disabled={busy} value={packageName} onChange={event => setPackageName(event.target.value)} /></label>
    <button disabled={busy || !isTauri()} onClick={() => void lookupPackage()}>Look up package flags</button>
    {packageFlags && <pre tabIndex={0} aria-label="pkg-config flags">{packageFlags}</pre>}
    <h2>clangd and LLDB</h2>
    <p>Open clangd setup fills a draft for this project. Connect still takes an explicit click in Language services. {project.compileCommands[0] ? 'Compilation database: ' + project.compileCommands[0] : 'No compilation database yet. Configure the project first, then connect clangd.'}</p>
    <button disabled={busy || !root} onClick={openClangd}>Open clangd setup</button>
    <label>Debug binary relative to project<input disabled={busy} value={binary} onChange={event => setBinary(event.target.value)} /></label>
    <button disabled={busy || dirty || !root || !binary} onClick={() => { try { onDebug(unixDebug(root, binary)); } catch (error) { setStatus(String(error)); } }}>Configure LLDB launch</button>
    <h2>Build problems</h2>
    {problems.map((problem, index) => <button key={index} onClick={() => onOpen(problem.path, problem.line)}>{problem.severity}: {problem.path}:{problem.line} — {problem.message}</button>)}
    <OutputLog label="Unix command output">{output || 'Build and test output appears here.'}</OutputLog>
  </section>;
}
