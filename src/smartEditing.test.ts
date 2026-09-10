import {test} from 'node:test';import assert from 'node:assert/strict';
import {shellClosingBlock} from './smartEditing.ts';
import {editorDefaults,editorOptions,validateEditor} from './preferences.ts';
test('shell headers close blocks without duplicating an existing terminator',()=>{
 assert.deepEqual(shellClosingBlock('  if [ -f "$file" ]; then',''),{indent:'  ',close:'fi'});
 assert.equal(shellClosingBlock('while true; do','')?.close,'done');assert.equal(shellClosingBlock('case "$x" in','')?.close,'esac');
 assert.equal(shellClosingBlock('if [ true ]; then','\n  echo hi\nfi'),null);assert.equal(shellClosingBlock('echo "if true; then"',''),null);assert.equal(shellClosingBlock('# if true; then',''),null);
});
test('editing assistance preferences validate and shell-only controls stay out of Monaco options',()=>{
 assert.equal(validateEditor({autoClosingBrackets:'never'}).autoClosingBrackets,'never');assert.throws(()=>validateEditor({autoIndent:'magic'}));
 assert.equal(editorOptions(editorDefaults).tabSize,2);assert.equal('shellBlockCompletion' in editorOptions(editorDefaults),false);
});
