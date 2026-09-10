import AgentPanel, {type RunBudget} from './AgentPanel';
import type { Task } from './workflows';
import { useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { usePersistedState } from './usePersistedState';
export default function AiPanel({ context, instructions, root, tasks, onRead, onEdit, onTask, onStopTask, onSaveEdits }: { context:string;instructions:string;root:string;tasks:Record<string,Task>;onRead:(path:string)=>Promise<string>;onEdit:(path:string,oldText:string,newText:string)=>Promise<string>;onTask:(name:string)=>Promise<string>;onStopTask:()=>void;onSaveEdits:()=>Promise<void> }) {
  const [protocol,setProtocol]=usePersistedState('ai.protocol','openai');
  const [tokenParameter,setTokenParameter]=usePersistedState('ai.tokenParameter','max_tokens');
  const [endpoint, setEndpoint] = usePersistedState('ai.endpoint', 'https://api.openai.com/v1/chat/completions');
  const [model, setModel] = usePersistedState('ai.model', '');
  const [key, setKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [include, setInclude] = useState(false);
  const [maxTokens, setMaxTokens] = usePersistedState('ai.maxTokens', 2048);
  const [dailyUnits, setDailyUnits] = usePersistedState('ai.dailyUnits', 100000);
  const [dailyRequests, setDailyRequests] = usePersistedState('ai.dailyRequests', 20);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  async function ask() {
    setBusy(true); setStatus('Requesting…');
    try {
      const response = await invoke<{ text: string; reservedUnits: number; requests: number }>('ask_ai', { request: { endpoint, model, key, protocol, tokenParameter, prompt, context: include ? context : '', instructions, maxTokens, dailyUnits, dailyRequests } });
      setAnswer(response.text); setStatus(`${response.requests} requests · ${response.reservedUnits} reserved units today (UTC)`);
    } catch (e) { setStatus(String(e)); } finally { setBusy(false); }
  }
  async function agentAsk(prompt:string,selectedContext:string,agentRun:RunBudget){
    const response=await invoke<{text:string;reservedUnits:number;requests:number}>('ask_ai',{request:{endpoint,model,key,protocol,tokenParameter,prompt,context:selectedContext,instructions,maxTokens,dailyUnits,dailyRequests,agentRun}});
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
    <label className="check"><input type="checkbox" checked={include} onChange={e => setInclude(e.target.checked)} /> Send the active file ({context.length.toLocaleString()} characters)</label>
    <details><summary>Project instructions sent with every request</summary><pre>{instructions || '(none)'}</pre></details>
    <label>Request<textarea rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Review this code, propose a change, or plan a build workflow…" /></label>
    <button disabled={busy || !isTauri() || !model.trim() || !prompt.trim()} onClick={() => void ask()}>{busy ? 'Waiting for provider…' : 'Send request'}</button>
    <p role="status">{status}</p><pre className="ai-answer">{answer}</pre>
    <AgentPanel root={root} context={include?context:''} tasks={tasks} ask={agentAsk} onRead={onRead} onEdit={onEdit} onTask={onTask} onStopTask={onStopTask} onSaveEdits={onSaveEdits}/>
    <p>Chat responses are suggestions. Agent runs use reviewed tool actions and separate per-run caps. External agent CLIs in the terminal have their own billing and limits.</p>
  </section>;
}
