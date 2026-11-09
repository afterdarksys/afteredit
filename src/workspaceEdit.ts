/**
 * Turning an LSP WorkspaceEdit into steps this editor can apply.
 *
 * A rename is the one language-server feature that writes to files you are not
 * looking at. Getting the offsets or the ordering wrong silently corrupts
 * source, so every step here refuses rather than guesses: overlapping edits,
 * reversed ranges, paths that leave their folder, overwrites, and directory
 * deletes are errors, not things to skip quietly.
 *
 * `workspaceEditFiles` stays text-only and refuses file operations. Creating,
 * renaming, or deleting a file goes through `workspaceEditPlan`, then a
 * confirm, then the jailed commands. Disk steps are not transactional.
 */

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspTextEdit = { range: LspRange; newText: string };
/** Edits for one file, already resolved to an absolute path. */
export type FileEdits = { path: string; edits: LspTextEdit[] };

/** Offset of the start of every line, so positions resolve in one pass. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

/**
 * LSP positions are zero-based, and `character` counts UTF-16 code units --
 * which is what JavaScript string indexing already uses. Positions past the
 * end of a line clamp to its terminator rather than spilling into the next.
 */
export function offsetAt(text: string, position: LspPosition): number {
  const starts = lineStarts(text);
  if (position.line < 0) return 0;
  if (position.line >= starts.length) return text.length;
  const start = starts[position.line];
  // Clamp to the end of the line's *content*: including the terminator would
  // turn "past the end of line 3" into "start of line 4".
  let end = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : text.length;
  if (end > start && text[end - 1] === '\r') end -= 1;
  return Math.min(start + Math.max(0, position.character), end);
}

/**
 * Apply edits to `text`. Server edits are all expressed against the original
 * document, so they are applied back-to-front and never see each other's
 * offsets.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const resolved = edits.map(edit => ({
    start: offsetAt(text, edit.range.start),
    end: offsetAt(text, edit.range.end),
    text: edit.newText ?? '',
  }));
  for (const edit of resolved) {
    if (edit.end < edit.start) throw new Error('The language server sent a backwards edit range.');
  }
  resolved.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < resolved.length; index++) {
    // Two edits over the same characters cannot both be right, and applying
    // either one alone is a corrupted file rather than a rename.
    if (resolved[index].start < resolved[index - 1].end) {
      throw new Error('The language server sent overlapping edits; nothing was changed.');
    }
  }
  let output = text;
  for (let index = resolved.length - 1; index >= 0; index--) {
    output = output.slice(0, resolved[index].start) + resolved[index].text + output.slice(resolved[index].end);
  }
  return output;
}

/** `file:///Users/me/a b.swift` -> `/Users/me/a b.swift`. */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) throw new Error(`Only files can be edited, not ${uri.split(':')[0]}: URIs.`);
  const withoutScheme = uri.slice('file://'.length).replace(/^[^/]*/, '');
  const decoded = decodeURIComponent(withoutScheme);
  // file:///C:/x on Windows arrives with a leading slash that is not part of it.
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

export type PlanStep =
  | { kind: 'text'; path: string; edits: LspTextEdit[] }
  | { kind: 'create'; path: string; ignoreIfExists: boolean }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'delete'; path: string };

/** A disk change. Text steps stay unsaved and are not in this set. */
export type FileOperation = Exclude<PlanStep, { kind: 'text' }>;

/**
 * Reject an empty path, a bare drive, or any `.`, `..`, or empty component.
 * The leading empty component of an absolute Unix path is the root slash.
 */
function assertProjectPath(path: string): void {
  if (!path || path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    throw new Error('The language server sent an empty path. Nothing was changed.');
  }
  const parts = path.split(/[\\/]/);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (index === 0 && part === '' && path.startsWith('/')) continue;
    if (part === '' || part === '.' || part === '..') {
      throw new Error('The language server sent a path that leaves its folder. Nothing was changed.');
    }
  }
}

function pathFromUri(uri: unknown): string {
  if (typeof uri !== 'string') throw new Error('The language server sent an edit with no file.');
  const path = fileUriToPath(uri);
  assertProjectPath(path);
  return path;
}

function refuseOverwrite(options: { overwrite?: boolean } | undefined): void {
  if (options?.overwrite) {
    throw new Error('AfterEdit refuses to overwrite an existing file. Nothing was changed.');
  }
}

/**
 * Ordered steps for one WorkspaceEdit. `documentChanges` wins over `changes`
 * when both are present, matching the language server protocol. Text edits in
 * one step are against that step's snapshot; later steps see earlier results.
 */
export function workspaceEditPlan(edit: unknown): PlanStep[] {
  const source = edit as { changes?: Record<string, LspTextEdit[]>; documentChanges?: unknown[] } | null;
  if (!source) return [];
  if (Array.isArray(source.documentChanges)) {
    const steps: PlanStep[] = [];
    for (const change of source.documentChanges as Record<string, any>[]) {
      if (change.kind === 'create') {
        refuseOverwrite(change.options);
        steps.push({ kind: 'create', path: pathFromUri(change.uri), ignoreIfExists: change.options?.ignoreIfExists === true });
      } else if (change.kind === 'rename') {
        refuseOverwrite(change.options);
        steps.push({ kind: 'rename', from: pathFromUri(change.oldUri), to: pathFromUri(change.newUri) });
      } else if (change.kind === 'delete') {
        if (change.options?.recursive) {
          throw new Error('Language servers can delete a file, not a folder. Nothing was changed.');
        }
        steps.push({ kind: 'delete', path: pathFromUri(change.uri) });
      } else if (change.kind) {
        throw new Error(`The language server sent an unsupported file change (${String(change.kind)}). Nothing was changed.`);
      } else {
        const edits = (change.edits ?? []) as LspTextEdit[];
        if (edits.length === 0) continue;
        steps.push({ kind: 'text', path: pathFromUri(change.textDocument?.uri), edits });
      }
    }
    return steps;
  }
  return Object.entries(source.changes ?? {}).flatMap(([uri, edits]) => {
    const list = edits ?? [];
    return list.length ? [{ kind: 'text' as const, path: pathFromUri(uri), edits: list }] : [];
  });
}

/**
 * Ask once before any file is created, renamed, or deleted. Cancel throws, so
 * the text half of the same edit is not applied either. An empty list does
 * not ask. Node tests pass `confirm`; the browser default is `window.confirm`.
 */
export function confirmFileOperations(
  operations: FileOperation[],
  confirm: (message: string) => boolean = message => window.confirm(message),
): void {
  if (operations.length === 0) return;
  const lines = operations.map(operation => {
    if (operation.kind === 'create') return `Create ${operation.path}`;
    if (operation.kind === 'rename') return `Rename ${operation.from} to ${operation.to}`;
    return `Delete ${operation.path}`;
  });
  const accepted = confirm(`AfterEdit will change these files on disk:\n${lines.join('\n')}\n\nText edits stay unsaved until you save them.`);
  if (!accepted) throw new Error('File changes were not confirmed. Nothing was changed.');
}

/**
 * Flatten either WorkspaceEdit shape into per-file text edits.
 *
 * A plan that also creates, renames, or deletes files throws. Applying only
 * the text half of that refactor leaves the project broken.
 */
export function workspaceEditFiles(edit: unknown): FileEdits[] {
  const plan = workspaceEditPlan(edit);
  if (plan.some(step => step.kind !== 'text')) {
    throw new Error('This change also creates, renames, or deletes files. Apply the reviewed plan, or nothing was changed.');
  }
  return plan.flatMap(step => step.kind === 'text' ? [{ path: step.path, edits: step.edits }] : []);
}
