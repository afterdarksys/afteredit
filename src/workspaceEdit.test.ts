import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTextEdits, fileUriToPath, offsetAt, workspaceEditFiles } from './workspaceEdit.ts';

const at = (line: number, character: number) => ({ line, character });
const edit = (sl: number, sc: number, el: number, ec: number, newText: string) =>
  ({ range: { start: at(sl, sc), end: at(el, ec) }, newText });

test('positions resolve against lines, not raw offsets', () => {
  const text = 'let a = 1\nlet bb = 2\nlet c = 3\n';
  assert.equal(offsetAt(text, at(0, 4)), 4);
  assert.equal(offsetAt(text, at(1, 4)), 14);
  // A character past the end of a line clamps to its terminator rather than
  // eating the next line.
  assert.equal(offsetAt(text, at(0, 999)), 9);
  assert.equal(offsetAt(text, at(99, 0)), text.length, 'a line past the end clamps to the end');
});

test('a multi-site rename applies every occurrence, back to front', () => {
  const text = 'let total = 1\nprint(total)\nreturn total\n';
  const renamed = applyTextEdits(text, [
    edit(0, 4, 0, 9, 'sum'),
    edit(1, 6, 1, 11, 'sum'),
    edit(2, 7, 2, 12, 'sum'),
  ]);
  assert.equal(renamed, 'let sum = 1\nprint(sum)\nreturn sum\n');
});

test('edits arriving out of order still land in the right places', () => {
  const text = 'aaa\nbbb\nccc\n';
  const shuffled = applyTextEdits(text, [edit(2, 0, 2, 3, 'Z'), edit(0, 0, 0, 3, 'X'), edit(1, 0, 1, 3, 'Y')]);
  assert.equal(shuffled, 'X\nY\nZ\n');
});

test('CRLF files keep their line endings', () => {
  const text = 'let a = 1\r\nlet b = a\r\n';
  assert.equal(applyTextEdits(text, [edit(1, 8, 1, 9, 'total')]), 'let a = 1\r\nlet b = total\r\n');
});

test('a rename spanning several lines collapses to one edit', () => {
  const text = 'func a(\n  x: Int\n) {}\n';
  assert.equal(applyTextEdits(text, [edit(0, 6, 2, 1, '(y: Int)')]), 'func a(y: Int) {}\n');
});

// ---- refusals: a half-applied refactor is worse than none ------------------

test('overlapping edits are refused outright, not applied in some order', () => {
  const text = 'let total = 1\n';
  assert.throws(
    () => applyTextEdits(text, [edit(0, 4, 0, 9, 'sum'), edit(0, 6, 0, 9, 'x')]),
    /overlapping/i,
  );
});

test('a backwards range is refused', () => {
  assert.throws(() => applyTextEdits('abc\n', [edit(0, 3, 0, 1, 'z')]), /backwards/i);
});

test('a rename that also creates or deletes files is refused, not half-applied', () => {
  assert.throws(
    () => workspaceEditFiles({ documentChanges: [
      { textDocument: { uri: 'file:///p/A.java', version: 1 }, edits: [edit(0, 0, 0, 1, 'B')] },
      { kind: 'rename', oldUri: 'file:///p/A.java', newUri: 'file:///p/B.java' },
    ] }),
    /cannot do yet/i,
  );
});

test('non-file URIs are refused rather than written somewhere surprising', () => {
  assert.throws(() => fileUriToPath('untitled:Untitled-1'), /Only files/);
  assert.throws(() => workspaceEditFiles({ changes: { 'jdt://contents/rt.jar': [edit(0, 0, 0, 1, 'x')] } }), /Only files/);
});

// ---- shapes ---------------------------------------------------------------

test('both WorkspaceEdit shapes flatten to the same per-file list', () => {
  const one = workspaceEditFiles({ changes: { 'file:///p/a.swift': [edit(0, 0, 0, 1, 'x')] } });
  const two = workspaceEditFiles({ documentChanges: [{ textDocument: { uri: 'file:///p/a.swift', version: 2 }, edits: [edit(0, 0, 0, 1, 'x')] }] });
  assert.deepEqual(one, two);
  assert.deepEqual(one, [{ path: '/p/a.swift', edits: [edit(0, 0, 0, 1, 'x')] }]);
});

test('percent-encoded paths survive the round trip', () => {
  assert.equal(fileUriToPath('file:///Users/me/My%20Project/App.swift'), '/Users/me/My Project/App.swift');
  assert.equal(fileUriToPath('file:///C:/src/App.java'), 'C:/src/App.java');
});

test('files with no edits are dropped, and a null edit is not an error', () => {
  assert.deepEqual(workspaceEditFiles(null), []);
  assert.deepEqual(workspaceEditFiles({ changes: { 'file:///p/a.swift': [] } }), []);
});
