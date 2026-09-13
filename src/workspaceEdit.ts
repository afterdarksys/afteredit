/**
 * Turning an LSP WorkspaceEdit into text this editor can actually apply.
 *
 * A rename is the one language-server feature that writes to files you are not
 * looking at. Getting the offsets or the ordering wrong silently corrupts
 * source, so every step here refuses rather than guesses: overlapping edits,
 * reversed ranges and file create/rename/delete operations are errors, not
 * things to skip quietly.
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

/**
 * Flatten either WorkspaceEdit shape into per-file edits.
 *
 * Refuses a `documentChanges` array containing create/rename/delete file
 * operations: this editor cannot perform them, and applying only the text half
 * of such a refactor leaves the project broken in a way that is hard to undo.
 */
export function workspaceEditFiles(edit: unknown): FileEdits[] {
  const source = edit as { changes?: Record<string, LspTextEdit[]>; documentChanges?: unknown[] } | null;
  if (!source) return [];

  if (Array.isArray(source.documentChanges)) {
    const files: FileEdits[] = [];
    for (const change of source.documentChanges as Record<string, any>[]) {
      if (change.kind) {
        throw new Error(`This rename also wants to ${change.kind} files, which AfterEdit cannot do yet. Nothing was changed.`);
      }
      const uri = change.textDocument?.uri;
      if (typeof uri !== 'string') throw new Error('The language server sent an edit with no file.');
      files.push({ path: fileUriToPath(uri), edits: (change.edits ?? []) as LspTextEdit[] });
    }
    return files.filter(file => file.edits.length > 0);
  }

  return Object.entries(source.changes ?? {})
    .map(([uri, edits]) => ({ path: fileUriToPath(uri), edits: edits ?? [] }))
    .filter(file => file.edits.length > 0);
}
