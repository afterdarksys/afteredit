export const editorDefaults = {
  fontSize: 14, fontFamily: 'Menlo, Monaco, Consolas, monospace', lineHeight: 0,
  tabSize: 2, insertSpaces: true, detectIndentation:true,
  autoClosingBrackets: "languageDefined" as "always"|"languageDefined"|"beforeWhitespace"|"never", autoClosingQuotes: "languageDefined" as "always"|"languageDefined"|"beforeWhitespace"|"never", autoSurround: "languageDefined" as "languageDefined"|"quotes"|"brackets"|"never", autoIndent: "full" as "none"|"keep"|"brackets"|"advanced"|"full", tabCompletion: "on" as "on"|"off"|"onlySnippets", shellBlockCompletion:true, wordWrap: 'off' as 'on' | 'off',
  lineNumbers: 'on' as 'on' | 'off' | 'relative', minimap: true, fontLigatures: false,
  renderWhitespace: 'selection' as 'none' | 'boundary' | 'selection' | 'all',
  cursorStyle: 'line' as 'line' | 'block' | 'underline', cursorBlinking: 'blink' as 'blink' | 'smooth' | 'solid',
  smoothScrolling: false, bracketPairColorization: true, stickyScroll: true,
  folding: true, formatOnPaste: false, formatOnType: false, scrollBeyondLastLine: false,
  keymap: 'standard' as 'standard' | 'vim' | 'emacs', theme: 'vs-dark',
  trimTrailingWhitespace: false, insertFinalNewline: false,
};
export type EditorPreferences = typeof editorDefaults;
export function validateEditor(value: unknown): Partial<EditorPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('editor must be an object');
  const clean: Record<string, unknown> = {};
  const numbers: Record<string, [number, number]> = { fontSize: [8,48], tabSize:[1,8], lineHeight:[0,80] };
  const choices: Record<string, string[]> = {
    autoClosingBrackets:['always','languageDefined','beforeWhitespace','never'],autoClosingQuotes:['always','languageDefined','beforeWhitespace','never'],autoSurround:['languageDefined','quotes','brackets','never'],autoIndent:['none','keep','brackets','advanced','full'],tabCompletion:['on','off','onlySnippets'],
    wordWrap: ['on','off'], lineNumbers:['on','off','relative'], renderWhitespace:['none','boundary','selection','all'],
    cursorStyle:['line','block','underline'], cursorBlinking:['blink','smooth','solid'], keymap:['standard','vim','emacs'],
  };
  for (const [key, v] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(editorDefaults, key)) throw new Error(`Unknown editor preference: ${key}`);
    const fallback = editorDefaults[key as keyof EditorPreferences];
    if (numbers[key]) { const [min,max] = numbers[key]; if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${key} must be ${min}–${max}`); }
    else if (choices[key]) { if (!choices[key].includes(String(v))) throw new Error(`Invalid ${key}`); }
    else if (typeof v !== typeof fallback || (typeof v === 'string' && (!v.trim() || v.length > 256))) throw new Error(`Invalid ${key}`);
    clean[key] = v;
  }
  return clean;
}
export function savedText(text: string, prefs: EditorPreferences): string {
  let result = prefs.trimTrailingWhitespace ? text.replace(/[\t ]+(?=\r?$)/gm, '') : text;
  if (prefs.insertFinalNewline && result && !result.endsWith('\n')) result += result.includes('\r\n') ? '\r\n' : '\n';
  return result;
}
export function editorOptions(prefs: EditorPreferences) {
  const { shellBlockCompletion: _shell, keymap: _keymap, theme: _theme, trimTrailingWhitespace: _trim, insertFinalNewline: _newline, minimap, bracketPairColorization, stickyScroll, ...rest } = prefs;
  return { ...rest, minimap: { enabled: minimap }, bracketPairColorization: { enabled: bracketPairColorization }, stickyScroll: { enabled: stickyScroll }, automaticLayout: true };
}
