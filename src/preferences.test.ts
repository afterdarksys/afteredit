import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorDefaults, validateEditor, savedText, editorOptions } from './preferences.ts';
import { resolveConfig } from './workflows.ts';
test('personal defaults inherit through project/directory overrides', () => {
 const result=resolveConfig([{editor:{keymap:'vim',fontSize:18}},{editor:{tabSize:4}},{editor:{lineNumbers:'relative'}}]);
 assert.equal(result.editor.keymap,'vim'); assert.equal(result.editor.fontSize,18); assert.equal(result.editor.tabSize,4);
});
test('preferences reject invalid numbers, enum values and unknown options', () => {
 for(const v of [{keymap:'vi'}, {fontSize:NaN}, {minimap:{}}, {lineHeight:-1}, {unknown:true}]) assert.throws(()=>validateEditor(v));
 assert.deepEqual(editorOptions({...editorDefaults,minimap:false}).minimap,{enabled:false});
});
test('save normalization respects existing CRLF and can be disabled', () => {
 const raw='hello  \r\nworld\t';
 assert.equal(savedText(raw,editorDefaults),raw);
 assert.equal(savedText(raw,{...editorDefaults,trimTrailingWhitespace:true,insertFinalNewline:true}),'hello\r\nworld\r\n');
});
