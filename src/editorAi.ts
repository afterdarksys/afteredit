export type GhostComplete = (prefix: string, suffix: string) => Promise<string>;
export type SelectionEdit = (selection: string, instruction: string) => Promise<string>;
type Binding = { ghost: GhostComplete | null; edit: SelectionEdit | null };
let binding: Binding = { ghost: null, edit: null };
const listeners = new Set<() => void>();
export function bindEditorAi(next: Binding) {
  binding = next;
  listeners.forEach(listener => listener());
}
export function editorAi() { return binding; }
export function subscribeEditorAi(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
