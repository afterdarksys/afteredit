import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeExtensionSettings,restoredExtensionSettings} from './extensionSettings.ts';
test('extension settings accept JSONC and reject malformed or oversized storage',()=>{
 assert.equal(JSON.parse(normalizeExtensionSettings('{// comment\n"fixture.message":"hello",}'))['fixture.message'],'hello');
 for(const value of ['null','[]','broken',' '.repeat(256001)])assert.throws(()=>normalizeExtensionSettings(value));
 assert.equal(restoredExtensionSettings('broken'),'{}');
});
