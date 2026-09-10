import * as monaco from 'monaco-editor';
import type { Extension } from './extensions';
export function activateExtensions(extensions:Extension[], theme: string) {
 const disposables:monaco.IDisposable[]=[];
 for(const extension of extensions.filter(e=>e.enabled)) {
  for(const theme of extension.themes) monaco.editor.defineTheme(theme.id,{base:theme.base,inherit:true,colors:theme.colors,rules:theme.rules});
  const languages=new Set(extension.snippets.flatMap(s=>s.languages));
  for(const language of languages) disposables.push(monaco.languages.registerCompletionItemProvider(language,{provideCompletionItems(model,position){
   const word=model.getWordUntilPosition(position); const range=new monaco.Range(position.lineNumber,word.startColumn,position.lineNumber,word.endColumn);
   return {suggestions:extension.snippets.filter(s=>s.languages.includes(language)).map(s=>({label:s.prefix,detail:`${s.label} · ${extension.id}`,kind:monaco.languages.CompletionItemKind.Snippet,documentation:s.description,insertText:s.body,insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,range}))};
  }}));
 }
 monaco.editor.setTheme(theme);
 return ()=>disposables.forEach(d=>d.dispose());
}
