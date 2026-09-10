import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {zipSync,strToU8} from 'fflate';
const base={publisher:'afteredit-test',name:'web-fixture',version:'1.0.0',engines:{vscode:'^1.95.0'},browser:'browser.js',activationEvents:['onCommand:afteredit.fixture.activation','onCommand:afteredit.fixture.format','onCommand:afteredit.fixture.configuration','onCommand:afteredit.fixture.keybinding','onCommand:afteredit.fixture.workspace'],contributes:{commands:[{command:'afteredit.fixture.activation',title:'Test extension activation'},{command:'afteredit.fixture.format',title:'Test formatter: uppercase buffer'},{command:'afteredit.fixture.configuration',title:'Test persistent configuration'},{command:'afteredit.fixture.keybinding',title:'Test extension keybinding'},{command:'afteredit.fixture.workspace',title:'Test workspace identity'}],configuration:{title:'Fixture',properties:{'afteredit.fixture.message':{type:'string',default:'initial'}}},keybindings:[{command:'afteredit.fixture.keybinding',key:'ctrl+alt+y',when:'editorTextFocus'}]}};
const out=process.argv[2]??'/tmp/afteredit-extension-fixtures';mkdirSync(out,{recursive:true});
for(const [name,manifest] of Object.entries({web:base,desktop:{...base,browser:undefined,main:'browser.js'},debugger:{...base,contributes:{debuggers:[{type:'fixture',label:'Test debugger'}]}}})){
 const archive=zipSync({'extension/package.json':strToU8(JSON.stringify(manifest)),'extension/browser.js':new Uint8Array(readFileSync('fixtures/extensions/browser.cjs'))});
 writeFileSync(`${out}/${name}.vsix`,archive);
}
console.log(`Extension fixtures written to ${out}`);
