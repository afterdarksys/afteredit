import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

type Buffer = { path: string; text: string; version: number; dirty: boolean };
type Capabilities = { root: string; protocol: number; methods: string[] };

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
  const current = useRef({ buffer, draft, connected, busy });
  current.current = { buffer, draft, connected, busy };
  const call = <T,>(method: string, params: unknown, target = connected) => invoke<T>('service_request', { endpoint: target, method, params });
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  function accept(value: Buffer) { setBuffer(value); setDraft(value.text); setRemote(undefined); setPath(value.path); }
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
    <div className="toolbar">
      <button disabled={!isTauri() || !root || busy || localChanges} onClick={() => void act(async () => {
        const value = await invoke<{ endpoint: string; capabilities: Capabilities }>('service_start', { root });
        setEndpoint(value.endpoint); setConnected(value.endpoint); setCaps(value.capabilities); setBuffer(undefined); setDraft(''); setRemote(undefined); setStatus('Workspace service ready.');
      })}>Start or join current workspace</button>
      <label>Session endpoint<input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="/path/session.sock or ssh://host/workspace" /></label>
      <button disabled={!isTauri() || !endpoint || busy || localChanges} onClick={() => void act(async () => {
        const value = await call<Capabilities>('capabilities', {}, endpoint);
        if (value.protocol !== 1) throw new Error('Unsupported service protocol');
        setConnected(endpoint); setCaps(value); setBuffer(undefined); setDraft(''); setRemote(undefined); setStatus('Connected to shared workspace.');
      })}>Connect</button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
    {error && <p role="alert">{error}</p>}
    {caps && <>
      <p>Workspace: {caps.root}. Protocol {caps.protocol}. CLI: <code>afteredit --connect '{connected.split("'").join("'\\''")}'</code></p>
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
