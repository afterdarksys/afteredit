import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { importVSIX } from './extensions.ts';
const pack=(manifest:object,extra:Record<string,object>={})=>zipSync(Object.fromEntries(Object.entries({'extension/package.json':{publisher:'test',name:'sample',version:'1.0.0',...manifest},...extra}).map(([p,v])=>[p,strToU8(JSON.stringify(v))])));
test('imports declarative theme and snippet contributions',()=>{
 const e=importVSIX(pack({contributes:{themes:[{path:'theme.json',label:'Night',uiTheme:'vs-dark'}],snippets:[{path:'snippet.json',language:'go'}]}},{'extension/theme.json':{colors:{'editor.background':'#112233'}},'extension/snippet.json':{hello:{prefix:'hi',body:['hello','$0']}}}));
 assert.equal(e.themes[0].colors['editor.background'],'#112233');assert.equal(e.snippets[0].body,'hello\n$0');
});
test('rejects executable extensions and escaping contribution paths',()=>{
 assert.throws(()=>importVSIX(pack({main:'index.js'})),/extension host/);
 assert.throws(()=>importVSIX(pack({contributes:{themes:[{path:'../theme.json'}]}})),/path/);
 assert.throws(()=>importVSIX(pack({contributes:{commands:[]}})),/Only theme/);
});
