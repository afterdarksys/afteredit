import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { importVSIX, restoreExtensions } from './extensions.ts';
import { importWebVSIX, safeExtensionPath } from './webExtensions.ts';
const pack=(changes:object={},files:Record<string,string>={})=>zipSync(Object.fromEntries(Object.entries({'extension/package.json':JSON.stringify({publisher:'test',name:'web',version:'1.0.0',engines:{vscode:'^1.95.0'},browser:'./browser.js',contributes:{commands:[{command:'test.hello',title:'Hello'}]},...changes}),'extension/browser.js':'exports.activate = () => {};',...files}).map(([p,v])=>[p,strToU8(v)])));
test('web extensions import disabled with executable bytes intact and survive persistence',()=>{
 const imported=importVSIX(pack());assert.equal(imported.enabled,false);assert.equal(atob(imported.web!.files['browser.js']),'exports.activate = () => {};');assert.deepEqual(restoreExtensions(JSON.stringify([imported])),[imported]);
});
test('rejects desktop-only packages, missing entrypoints, dependencies and debugger contributions',()=>{
 assert.throws(()=>importWebVSIX(pack({browser:undefined,main:'desktop.js'})),/Desktop-only/);
 assert.throws(()=>importVSIX(pack({browser:'missing.js'})),/Missing browser entry/);
 assert.throws(()=>importVSIX(pack({extensionDependencies:['other.extension']})),/dependencies/);
 assert.throws(()=>importVSIX(pack({contributes:{debuggers:[{}]}})),/debuggers/);
 assert.throws(()=>importVSIX(pack({enabledApiProposals:['test']})),/proposed APIs/);
});
test('archive paths cannot escape extension roots and expanded payloads are bounded',()=>{
 for(const p of ['../x','/x','a/../x','C:/x','a\\x','a//x'])assert.throws(()=>safeExtensionPath(p));
 assert.throws(()=>importVSIX(pack({}, {'extension/../escape.js':'bad'})),/path/);
 assert.throws(()=>importVSIX(pack({}, {'extension/large.js':'x'.repeat(4*1024*1024+1)})),/limits/);
 const e=importVSIX(pack());e.web!.files['../bad']='eA==';assert.deepEqual(restoreExtensions(JSON.stringify([e])),[]);
});
