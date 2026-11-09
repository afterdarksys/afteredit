import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

type Buffer = { path: string; text: string; version: number; dirty: boolean };
type Capabilities = { root: string; protocol: number; methods: string[] };
type RemoteEntry = { name: string; path: string; directory: boolean };

function remoteListing(value: unknown): RemoteEntry[] {
  if (!Array.isArray(value)) throw new Error('The remote file list was not a directory listing.');
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.path !== 'string' || typeof row.directory !== 'boolean') return [];
    if (!row.name || row.name === '.' || row.name === '..' || row.name.includes('/') || row.name.includes('\\')) return [];
    return [{ name: row.name, path: row.path, directory: row.directory }];
  }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export default function SharedWorkspacePanel({ root, onDirty }: { root: string; onDirty: (dirty: boolean) => void }) {
  const [endpoint, setEndpoint] = useState('');
  const [connected, setConnected] = useState('');
  const [caps, setCaps] = useState<Capabilities>();
  const [path, setPath] = useState('');
  const [buffer, setBuffer] = useState<Buffer>();
  const [draft, setDraft] = useState('');
  const [remote, setRemote] = useState<Buffer>();
  const [status, setStatus] = useState('Start a workspace or connect to an existing CLI session.');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState('session.status');
  const [params, setParams] = useState('{}');
  const [result, setResult] = useState('');
  const [review, setReview] = useState<{ method: string; params: unknown }>();
  const [sshHost, setSshHost] = useState('');
  const [remoteProject, setRemoteProject] = useState('');
  const [remoteEntries, setRemoteEntries] = useState<RemoteEntry[] | null>(null);
  const [remoteStack, setRemoteStack] = useState<string[]>(['.']);
  const current = useRef({ buffer, draft, connected, busy });
  current.current = { buffer, draft, connected, busy };
  const call = <T,>(method: string, params: unknown, target = connected) => invoke<T>('service_request', { endpoint: target, method, params });
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  function accept(value: Buffer) { setBuffer(value); setDraft(value.text); setRemote(undefined); setPath(value.path); }
  useEffect(() => {
    if (!root) return;
    const raw = localStorage.getItem(`ssh.workspace.v1:${root}`);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { host?: unknown; path?: unknown };
      if (typeof saved.host === 'string' && typeof saved.path === 'string') {
        setSshHost(saved.host);
        setRemoteProject(saved.path);
      }
    } catch {
      /* A broken note is ignored. The fields stay as they are. */
    }
  }, [root]);
  async function showRemote(target: string, stack: string[]) {
    const dir = stack[stack.length - 1] || '.';
    const entries = remoteListing(await call<unknown>('files', { path: dir }, target));
    setRemoteStack(stack);
    setRemoteEntries(entries);
  }
  useEffect(() => {
    if (!connected) return;
    let cancelled = false, pending = false;
    const timer = setInterval(async () => {
      const snapshot = current.current;
      if (!snapshot.buffer || snapshot.busy || pending) return;
      pending = true;
      try {
        const value = await call<Buffer>('buffer.get', { path: snapshot.buffer.path }, connected);
        const latest = current.current;
        if (cancelled || latest.busy || latest.buffer?.path !== value.path || latest.buffer.version !== snapshot.buffer.version) return;
        if (value.version !== latest.buffer.version) {
          if (latest.draft !== latest.buffer.text) setRemote(value);
          else { accept(value); setStatus(`Received shared revision ${value.version}.`); }
        }
      } catch (e) { if (!cancelled) setError(String(e)); } finally { pending = false; }
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [connected]);
  async function save(toDisk: boolean) {
    if (!buffer) return;
    let value = buffer;
    if (draft !== buffer.text) value = await call<Buffer>('buffer.edit', { path: buffer.path, version: buffer.version, text: draft });
    accept(value);
    if (toDisk) { value = await call<Buffer>('buffer.save', { path: value.path, version: value.version }); accept(value); }
    setStatus(toDisk ? 'Saved to disk and shared with terminal clients.' : 'Published shared draft. Disk is unchanged.');
  }
  useEffect(() => { const handler = () => { if (!busy && !remote) void act(() => save(true)); }; window.addEventListener('afteredit:shared-save', handler); return () => window.removeEventListener('afteredit:shared-save', handler); });
  const localChanges = !!buffer && draft !== buffer.text;
  useEffect(() => { onDirty(localChanges); }, [localChanges, onDirty]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (current.current.buffer && current.current.draft !== current.current.buffer.text) e.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  function downloadDraft() {
    const url = URL.createObjectURL(new Blob([draft], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = (buffer?.path.split('/').pop() || 'draft') + '.recovery.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="workbench-page" aria-label="Shared workspace">
    <h1>Shared workspace</h1>
    <p>One workspace service for the GUI, plain terminal editor and optional full-screen editor. Shared editing happens here; Files editor tabs keep their own drafts.</p>
    <fieldset>
      <legend>Remote host</legend>
      <p>SSH uses the afteredit command on the remote PATH and your existing SSH config and keys. No password is stored. If SSH has never seen that host, accept its host key in a terminal once. Each shared action opens one SSH command. SAH is the next transport. This panel does not open it yet.</p>
      <label>Transport<select aria-label="Remote transport" defaultValue="ssh"><option value="ssh">SSH</option><option value="sah" disabled>SAH (after SSH)</option></select></label>
      <label>SSH host<input aria-label="SSH host" value={sshHost} placeholder="alias from ~/.ssh/config" onChange={e => setSshHost(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
      <label>Remote project<input aria-label="Remote project" value={remoteProject} placeholder="/absolute/path" onChange={e => setRemoteProject(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
      <button type="button" disabled={!isTauri() || busy || localChanges || !sshHost.trim() || !remoteProject.trim()} onClick={() => void act(async () => {
        const host = sshHost.trim();
        const workspace = remoteProject.trim();
        const value = await invoke<{ endpoint: string; capabilities: Capabilities }>('ssh_workspace_connect', { host, workspace });
        if (value.capabilities.protocol !== 1) throw new Error('The remote AfterEdit service speaks an unsupported protocol.');
        setSshHost(host); setRemoteProject(workspace); setEndpoint(value.endpoint); setConnected(value.endpoint); setCaps(value.capabilities); setBuffer(undefined); setDraft(''); setRemote(undefined);
        if (root) localStorage.setItem(`ssh.workspace.v1:${root}`, JSON.stringify({ host, path: workspace }));
        await showRemote(value.endpoint, ['.']);
        setStatus('Remote project is open. Files stay on that host.');
      })}>Check and open remote project</button>
    </fieldset>
    <div className="toolbar">
      <button disabled={!isTauri() || !root || busy || localChanges} onClick={() => void act(async () => {
        const value = await invoke<{ endpoint: string; capabilities: Capabilities }>('service_start', { root });
        setEndpoint(value.endpoint); setConnected(value.endpoint); setCaps(value.capabilities); setBuffer(undefined); setDraft(''); setRemote(undefined); setRemoteEntries(null); setRemoteStack(['.']); setStatus('Workspace service ready.');
      })}>Start or join current workspace</button>
      <label>Session endpoint<input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="Socket from Start or join" /></label>
      <button disabled={!isTauri() || !endpoint || busy || localChanges} onClick={() => void act(async () => {
        const value = await call<Capabilities>('capabilities', {}, endpoint);
        if (value.protocol !== 1) throw new Error('Unsupported service protocol');
        setConnected(endpoint); setCaps(value); setBuffer(undefined); setDraft(''); setRemote(undefined);
        if (endpoint.startsWith('ssh://')) await showRemote(endpoint, ['.']);
        else { setRemoteEntries(null); setRemoteStack(['.']); }
        setStatus('Connected to shared workspace.');
      })}>Connect</button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
    {error && <p role="alert">{error}</p>}
    {caps && <>
      <p>Workspace: {caps.root}. Protocol {caps.protocol}. CLI: <code>afteredit --connect '{connected.split("'").join("'\\''")}'</code></p>
      {connected.startsWith('ssh://') && remoteEntries && <>
        <h2>Remote files</h2>
        <p>{remoteStack.length < 2 ? 'Remote project root' : remoteStack[remoteStack.length - 1]}</p>
        <button type="button" disabled={busy || remoteStack.length < 2 || localChanges} onClick={() => void act(() => showRemote(connected, remoteStack.slice(0, -1)))}>Up to parent folder</button>
        {remoteEntries.length === 0 ? <p>This directory is empty.</p> : <ul className="remote-files">{remoteEntries.map(entry => <li key={entry.path}><button type="button" disabled={busy || localChanges} onClick={() => void act(async () => {
          if (entry.directory) { await showRemote(connected, [...remoteStack, entry.path]); setStatus(`Opened remote folder ${entry.name}.`); return; }
          setPath(entry.path); accept(await call<Buffer>('buffer.open', { path: entry.path })); setStatus('Shared buffer opened.');
        })}>{entry.directory ? `${entry.name}/` : entry.name}</button></li>)}</ul>}
      </>}
      <label>File path<input value={path} onChange={e => setPath(e.target.value)} /></label>
      <button disabled={busy || !path || localChanges} onClick={() => void act(async () => { accept(await call<Buffer>('buffer.open', { path })); setStatus('Shared buffer opened.'); })}>Open shared file</button>
      <button disabled={busy || !path || localChanges} onClick={() => void act(async () => { accept(await call<Buffer>('buffer.create', { path })); setStatus('Created empty file and opened shared buffer.'); })}>Create shared file</button>
      {buffer && <>
        <p>{buffer.path} · Revision {buffer.version} · {localChanges ? 'Local changes awaiting publication' : buffer.dirty ? 'Shared draft, not saved to disk' : 'Saved'}</p>
        <label>Shared buffer<textarea aria-label="Shared buffer" style={{ width: '100%', minHeight: 240, fontFamily: 'monospace' }} spellCheck={false} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void act(() => save(true)); } }} /></label>
        <div className="toolbar">
          <button disabled={busy || !!remote} onClick={() => void act(() => save(false))}>Publish draft</button>
          <button disabled={busy || !!remote} onClick={() => void act(() => save(true))}>Save shared file</button>
          {(['undo', 'redo'] as const).map(action => <button key={action} disabled={busy || localChanges || !!remote} onClick={() => void act(async () => accept(await call<Buffer>(`buffer.${action}`, { path: buffer.path, version: buffer.version })))}>{action === 'undo' ? 'Undo shared edit' : 'Redo shared edit'}</button>)}
          <button onClick={downloadDraft}>Download draft copy</button>
        </div>
        {remote && <div role="region" aria-label="Conflicting shared edit"><p role="alert">Another client published revision {remote.version}. Your local text is retained. Download it before replacing it, or copy changes into the latest version.</p><label>Latest shared text<textarea aria-label="Latest shared text" readOnly value={remote.text} /></label><button disabled={busy} onClick={() => { accept(remote); setStatus('Loaded shared revision; local draft replaced.'); }}>Replace local draft with displayed shared version</button></div>}
      </>}
      <details><summary>Workspace capabilities and commands</summary>
        <p>Search, task monitoring, Git, language services and debugging use the same API as the CLI. Review the method and parameters before executing. Tasks require the exact approval value returned by task.plan. Starting language servers or debuggers requires approve: true.</p>
        <label>Service method<select value={method} onChange={e => { setMethod(e.target.value); setReview(undefined); }}>{caps.methods.map(name => <option key={name}>{name}</option>)}</select></label>
        <label>JSON parameters<textarea aria-label="JSON parameters" value={params} onChange={e => { setParams(e.target.value); setReview(undefined); }} /></label>
        <button disabled={busy} onClick={() => { try { setReview({ method, params: JSON.parse(params) }); setError(''); } catch (e) { setError(String(e)); } }}>Review request</button>
        {review && <><pre>{JSON.stringify(review, null, 2)}</pre><button disabled={busy} onClick={() => void act(async () => { setResult(JSON.stringify(await call(review.method, review.params), null, 2)); setReview(undefined); })}>Execute reviewed request</button></>}
        <label>Service response<textarea aria-label="Service response" readOnly value={result} style={{ width: '100%', minHeight: 160 }} /></label>
      </details>
    </>}
  </section>;
}
