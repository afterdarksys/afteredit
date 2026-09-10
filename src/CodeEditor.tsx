import './monaco-setup';
import Editor from '@monaco-editor/react';
import { languageForFilename } from './languages';
import type { ProjectConfig } from './workflows';
export default function CodeEditor({ path, value, onChange, options }: { path: string; value: string; onChange: (value: string) => void; options: ProjectConfig['editor'] }) {
  return <Editor height="100%" theme="vs-dark" path={path} language={languageForFilename(path)} value={value} onChange={v => onChange(v ?? '')} options={{ ...options, automaticLayout: true }} loading={<p>Loading local editor…</p>} />;
}
