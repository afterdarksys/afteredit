import './monaco-setup';
import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { languageForFilename } from './languages';
import { editorOptions, type EditorPreferences } from './preferences';
export default function CodeEditor({ path, value, onChange, options, onSave }: { path: string; value: string; onChange: (value: string) => void; options: EditorPreferences; onSave: () => void }) {
  const [instance, setInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const save = useRef(onSave); save.current = onSave;
  useEffect(() => {
    if (!instance) return;
    const action = instance.addAction({ id:'afteredit.save', label:'Save file', run:()=>save.current() });
    return () => action.dispose();
  }, [instance]);
  useEffect(() => {
    if (!instance || !status.current) return;
    const node = status.current;
    node.textContent = options.keymap === 'standard' ? 'Standard keybindings' : `Loading ${options.keymap} keybindings…`;
    let disposed = false;
    let adapter: { dispose: () => void } | undefined;
    const attach = async () => {
      if (options.keymap === 'vim') {
        const {initVimMode, VimMode} = await import('monaco-vim');
        if (disposed) return;
        (VimMode as unknown as { Vim: { defineEx: (name: string, short: string, callback: (cm: {editor: editor.IStandaloneCodeEditor}) => void) => void } }).Vim.defineEx('write','w', cm=>{ void cm.editor.getAction('afteredit.save')?.run(); });
        adapter = initVimMode(instance, node);
      } else if (options.keymap === 'emacs') {
        const {EmacsExtension, registerGlobalCommand} = await import('monaco-emacs');
        if (disposed) return;
        registerGlobalCommand('C-x C-s', {description:'Save file',run:editor=>{void editor.getAction('afteredit.save')?.run();}});
        const mode = new EmacsExtension(instance);
        mode.onDidMarkChange(mark=>{node.textContent = mark ? 'Emacs · Mark set' : 'Emacs';});
        mode.onDidChangeKey(key=>{node.textContent = `Emacs · ${key}`;});
        mode.start(); adapter = mode; node.textContent = 'Emacs · C-x C-s save · C-g cancel';
      }
    };
    void attach().catch(e=>{if(!disposed) node.textContent = `Keymap could not load: ${String(e)}. Standard bindings remain available.`;});
    return ()=>{disposed=true;adapter?.dispose();node.textContent='';};
  },[instance,options.keymap]);
  return <div className="editor-host"><div className="editor-surface"><Editor height="100%" theme={options.theme} path={path} language={languageForFilename(path)} value={value} onChange={v=>onChange(v??'')} onMount={setInstance} options={editorOptions(options)} loading={<p>Loading local editor…</p>} /></div><div ref={status} className="keymap-status" aria-live="polite" /></div>;
}
