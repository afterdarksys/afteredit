import AgentPanel, {type RunBudget} from './AgentPanel';
import { bindEditorAi } from './editorAi';
import type { SecretFinding } from './policy';
import type { ConnectedServer } from './languageServices';
import type { Task } from './workflows';
import { useEffect, useRef, useState } from 'react';
import {listen} from '@tauri-apps/api/event';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { usePersistedState } from './usePersistedState';
export default function AiPanel({ context, contextPath = 'Active file', openFiles = [], instructions, root, tasks, onRead, onEdit, onTask, onInspectRun, onProposeDebugLaunch, onInspectDebug, onStopTask, onSaveEdits, changes = 0, onRollback, onRunStart, servers = [] }: { context:string;contextPath?:string;openFiles?:Array<{path:string;text:string}>;instructions:string;root:string;tasks:Record<string,Task>;servers?:ConnectedServer[];onRead:(path:string)=>Promise<string>;onEdit:(path:string,oldText:string,newText:string)=>Promise<string>;onTask:(name:string)=>Promise<string>;onInspectRun:(runId?:number)=>Promise<string>;onProposeDebugLaunch:(runId:number,testId:string)=>Promise<string>;onInspectDebug:()=>Promise<string>;onStopTask:()=>void;onSaveEdits:()=>Promise<void>;changes?:number;onRollback?:()=>Promise<string>;onRunStart?:()=>void }) {
  const [stream,setStream]=usePersistedState('ai.stream',true);
  const activeRequests=useRef(new Set<string>()),dispatched=useRef(new Set<string>());
  const chatRequest=useRef<string|null>(null),agentRequest=useRef<string|null>(null),mounted=useRef(true);
  const cancel=(id:string|null)=>{if(id){activeRequests.current.delete(id);if(dispatched.current.has(id))void invoke('cancel_ai',{requestId:id}).catch(()=>{});}};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const id of activeRequests.current)cancel(id);};},[]);
  async function requestAi(request:Record<string,unknown>,slot:{current:string|null},onDelta?:(text:string)=>void){
    const requestId=crypto.randomUUID();slot.current=requestId;activeRequests.current.add(requestId);
    let off=()=>{};
    try{
      if(request.stream)off=await listen<{requestId:string;text:string}>('ai:chunk',event=>{if(event.payload.requestId===requestId&&activeRequests.current.has(requestId)&&mounted.current)onDelta?.(event.payload.text);});
      if(!activeRequests.current.has(requestId))throw new Error('Request cancelled before sending.');
      dispatched.current.add(requestId);
      const result=await invoke<{text:string;reservedUnits:number;requests:number}>('ask_ai',{request:{...request,requestId}});
      if(!activeRequests.current.has(requestId))throw new Error('Request cancelled. Partial output is retained.');
      return result;
    }finally{off();activeRequests.current.delete(requestId);dispatched.current.delete(requestId);if(slot.current===requestId)slot.current=null;}
  }
  const [protocol,setProtocol]=usePersistedState('ai.protocol','openai');
  const [tokenParameter,setTokenParameter]=usePersistedState('ai.tokenParameter','max_tokens');
  const [endpoint, setEndpoint] = usePersistedState('ai.endpoint', 'https://api.openai.com/v1/chat/completions');
  const [model, setModel] = usePersistedState('ai.model', '');
  const [key, setKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [include, setInclude] = useState(false);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [ghost, setGhost] = usePersistedState('ai.ghostText', false);
  const [history, setHistory] = useState<Array<{role:'user'|'assistant';text:string}>>([]);
  const ghostRequest = useRef<string|null>(null);
  const editRequest = useRef<string|null>(null);
  const files = openFiles.length ? openFiles : context ? [{path: contextPath, text: context}] : [];
  const chosen = (picked ?? (contextPath ? [contextPath] : [])).filter(path => files.some(file => file.path === path));
  const sentContext = include ? files.filter(file => chosen.includes(file.path)).map(file => `File ${file.path}\n${file.text}`).join('\n\n').slice(0, 60000) : '';
  const [maxTokens, setMaxTokens] = usePersistedState('ai.maxTokens', 2048);
  const [dailyUnits, setDailyUnits] = usePersistedState('ai.dailyUnits', 100000);
  const [dailyRequests, setDailyRequests] = usePersistedState('ai.dailyRequests', 20);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('ai.history.v1:' + root) ?? '[]');
      setHistory(Array.isArray(stored) ? stored.filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string').slice(-40) : []);
    } catch { setHistory([]); }
  }, [root]);
  async function remember(turns: Array<{role:'user'|'assistant';text:string}>) {
    const safe = [];
    for (const turn of turns.slice(-40)) {
      const findings = await invoke<SecretFinding[]>('scan_buffer_secrets', {path: 'transcript.txt', text: turn.text}).catch(() => [{description:'scan failed'}] as SecretFinding[]);
      safe.push(findings.length ? {role: turn.role, text: '[withheld: possible secret]'} : turn);
    }
    let rows = safe;
    while (JSON.stringify(rows).length > 100000 && rows.length > 1) rows = rows.slice(1);
    try { localStorage.setItem('ai.history.v1:' + root, JSON.stringify(rows)); } catch { /* the transcript stays on screen */ }
    if (mounted.current) setHistory(rows);
  }
  useEffect(() => {
    if (!isTauri() || !key.trim() || !model.trim()) { bindEditorAi({ghost: null, edit: null}); return () => bindEditorAi({ghost: null, edit: null}); }
    const request = {endpoint, model, key, protocol, tokenParameter, instructions: '', maxTokens: 256, dailyUnits, dailyRequests, stream: false};
    bindEditorAi({
      ghost: ghost ? async (prefix, suffix) => (await requestAi({...request, prompt: 'Continue this source line. Return only the characters to insert after the cursor, with no explanation or code fence.', context: `Before cursor:\n${prefix}\nAfter cursor:\n${suffix}`}, ghostRequest)).text.replace(/[\r\n].*$/s, '').slice(0, 240) : null,
      edit: async (selection, instruction) => (await requestAi({...request, maxTokens, prompt: instruction, context: selection, instructions: 'Return only the replacement for the selected text.'}, editRequest)).text,
    });
    return () => bindEditorAi({ghost: null, edit: null});
  }, [ghost, key, model, endpoint, protocol, tokenParameter, maxTokens, dailyUnits, dailyRequests]);
  async function ask() {
    setBusy(true); setAnswer(''); setStatus('Requesting…');
    try {
      const response = await requestAi({ endpoint, model, key, protocol, tokenParameter, prompt, context: sentContext, instructions, maxTokens, dailyUnits, dailyRequests,stream },chatRequest,text=>setAnswer(value=>value+text));
      if(!mounted.current)return;
      setAnswer(response.text); setStatus(`${response.requests} requests · ${response.reservedUnits} reserved units today (UTC)`);
      await remember([...history, {role:'user', text: prompt}, {role:'assistant', text: response.text}]);
    } catch (e) { if(mounted.current)setStatus(String(e)); } finally { if(mounted.current)setBusy(false); }
  }
  async function agentAsk(prompt:string,selectedContext:string,agentRun:RunBudget){
    const response=await requestAi({endpoint,model,key,protocol,tokenParameter,prompt,context:selectedContext || sentContext,instructions,maxTokens,dailyUnits,dailyRequests,agentRun,stream:false},agentRequest);
    setStatus(`${response.requests} requests · ${response.reservedUnits} reserved units today (UTC)`);return response.text;
  }
  return <section className="workbench-page"><h1>Developer assistant</h1><p>Bring your own key for OpenAI-compatible Chat Completions or Anthropic Messages. Keys stay in memory for this session.</p>
    <label>Provider protocol<select value={protocol} onChange={e=>{setProtocol(e.target.value);setEndpoint(e.target.value==='anthropic'?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/chat/completions');}}><option value="openai">OpenAI-compatible chat</option><option value="anthropic">Anthropic Messages</option></select></label>
    {protocol==='openai'&&<label>Output token parameter<select value={tokenParameter} onChange={e=>setTokenParameter(e.target.value)}><option>max_tokens</option><option>max_completion_tokens</option></select></label>}
    <label>Endpoint<input value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
    <label>Model ID<input value={model} onChange={e => setModel(e.target.value)} placeholder="Provider model identifier" /></label>
    <label>API key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} /></label>
    <div className="field-row"><label>Max output tokens<input type="number" min="1" max="32768" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} /></label><label>Daily reservation units<input type="number" min="1" value={dailyUnits} onChange={e => setDailyUnits(Number(e.target.value))} /></label><label>Daily requests<input type="number" min="1" value={dailyRequests} onChange={e => setDailyRequests(Number(e.target.value))} /></label></div>
    <p>Limits are enforced locally before sending and survive restarts. Each request reserves UTF-8 input bytes + output tokens + 1,024 units, including failures. This is an app usage cap, not a provider dollar limit.</p>
    <fieldset><legend>Context that will be sent</legend>
      <label className="check"><input type="checkbox" checked={include} onChange={e => setInclude(e.target.checked)} /> Include checked files ({sentContext.length.toLocaleString()} characters{sentContext.length>=60000?', trimmed to 60,000':''})</label>
      {files.map(file => <label className="check" key={file.path}><input type="checkbox" checked={include && chosen.includes(file.path)} onChange={e => { setInclude(true); setPicked(current => { const base = current ?? chosen; return e.target.checked ? [...new Set([...base, file.path])] : base.filter(path => path !== file.path); }); }} />{file.path === contextPath ? 'Active: ' : ''}{file.path} ({file.text.length.toLocaleString()} characters)</label>)}
      <pre aria-label="Context preview">{sentContext.slice(0, 1500) || '(nothing from the editor will be sent)'}{sentContext.length > 1500 ? '\n…' : ''}</pre>
    </fieldset>
    <details><summary>Project instructions sent with every request ({instructions.length.toLocaleString()} characters)</summary><pre>{instructions || '(none)'}</pre></details>
    <label className="check"><input type="checkbox" checked={ghost} onChange={e => setGhost(e.target.checked)} /> Ghost text in the editor. Each pause can spend a request. Tab accepts it only when the snippet list is closed.</label>
    {history.length > 0 && <details><summary>Conversation in this project ({history.length})</summary>{history.map((turn, index) => <p key={index}><strong>{turn.role}</strong> {turn.text}</p>)}<button type="button" onClick={() => { localStorage.removeItem('ai.history.v1:' + root); setHistory([]); }}>Clear saved conversation</button></details>}
    <label>Request<textarea rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Review this code, propose a change, or plan a build workflow…" /></label>
    <label className="check"><input type="checkbox" checked={stream} disabled={busy} onChange={e=>setStream(e.target.checked)}/> Stream chat responses</label>
    <button disabled={busy || !isTauri() || !model.trim() || !prompt.trim()} onClick={() => void ask()}>{busy ? 'Waiting for provider…' : 'Send request'}</button>
    {busy&&<button onClick={()=>{cancel(chatRequest.current);setStatus("Cancelling request…");}}>Stop response</button>}
    <p role="status">{status}</p><pre className="ai-answer" tabIndex={0} aria-label="AI response">{answer}</pre>
    <AgentPanel onCancelRequest={()=>cancel(agentRequest.current)} root={root} context={sentContext} tasks={tasks} ask={agentAsk} onRead={onRead} onEdit={onEdit} onTask={onTask} onInspectRun={onInspectRun} onProposeDebugLaunch={onProposeDebugLaunch} onInspectDebug={onInspectDebug} onStopTask={onStopTask} onSaveEdits={onSaveEdits} changes={changes} onRollback={onRollback} onRunStart={onRunStart} servers={servers}/>
    <p>Chat responses are suggestions. Agent runs use reviewed tool actions and separate per-run caps. External agent CLIs in the terminal have their own billing and limits.</p>
  </section>;
}
