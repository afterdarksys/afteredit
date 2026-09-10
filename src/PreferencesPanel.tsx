import { useState } from 'react';
import { editorDefaults, validateEditor, type EditorPreferences } from './preferences';
export default function PreferencesPanel({ value, onChange }: { value: EditorPreferences; onChange: (v: EditorPreferences) => void }) {
  const [query, setQuery] = useState('');
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const choices: Record<string, string[]> = { wordWrap:['on','off'], lineNumbers:['on','off','relative'], renderWhitespace:['none','boundary','selection','all'], cursorStyle:['line','block','underline'], cursorBlinking:['blink','smooth','solid'], keymap:['standard','vim','emacs'], theme:['vs-dark','vs','hc-black','hc-light'] };
  const label = (key: string) => key.replace(/[A-Z]/g, c => ' ' + c.toLowerCase());
  return <section><h2>Personal editor preferences</h2><p>These defaults persist across projects. A project's .afteredit.json can override them. Vim includes normal/insert/visual modes, motions and search; Emacs includes navigation, mark and kill/yank bindings.</p>
    <input aria-label="Search preferences" placeholder="Find a preference…" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="preference-grid">{Object.entries(value).filter(([key]) => label(key).includes(query.toLowerCase())).map(([key,v]) => <label key={key}>{label(key)}
      {typeof v === 'boolean' ? <input type="checkbox" checked={v} onChange={e => onChange({...value,[key]:e.target.checked})} /> : choices[key] ? <select value={String(v)} onChange={e => onChange({...value,[key]:e.target.value})}>{choices[key].map(c => <option key={c}>{c}</option>)}{key === 'theme' && !choices[key].includes(String(v)) && <option>{String(v)}</option>}</select> : <input type={typeof v === 'number' ? 'number' : 'text'} value={v} onChange={e => { try { onChange({...value,...validateEditor({[key]:typeof v === 'number' ? Number(e.target.value) : e.target.value})}); setError(''); } catch (err) { setError(String(err)); } }} />}
    </label>)}</div>
    <button onClick={() => onChange({...editorDefaults})}>Reset personal preferences</button>
    <details><summary>Import / export preferences JSON</summary><textarea aria-label="Preferences JSON" rows={10} value={json} onChange={e => setJson(e.target.value)} /><button onClick={() => setJson(JSON.stringify(value,null,2))}>Export to text</button><button onClick={() => { try { onChange({...editorDefaults,...validateEditor(JSON.parse(json))}); setError(''); } catch(e) { setError(String(e)); } }}>Import</button></details>
    <p role="alert">{error}</p><p>Vim: Esc returns to normal mode; :w saves. Emacs: C-x C-s saves; C-g cancels. The Commands button remains available in every mode.</p>
  </section>;
}
