import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {zipSync,strToU8} from 'fflate';
const base={publisher:'afteredit-test',name:'web-fixture',version:'1.0.0',engines:{vscode:'^1.95.0'},browser:'browser.js',activationEvents:['onCommand:afteredit.fixture.activation','onCommand:afteredit.fixture.format'],contributes:{commands:[{command:'afteredit.fixture.activation',title:'Test extension activation'},{command:'afteredit.fixture.format',title:'Test formatter: uppercase buffer'}]}};
const out=process.argv[2]??'/tmp/afteredit-extension-fixtures';mkdirSync(out,{recursive:true});
for(const [name,manifest] of Object.entries({web:base,desktop:{...base,browser:undefined,main:'browser.js'},debugger:{...base,contributes:{debuggers:[{type:'fixture',label:'Test debugger'}]}}})){
 const archive=zipSync({'extension/package.json':strToU8(JSON.stringify(manifest)),'extension/browser.js':new Uint8Array(readFileSync('fixtures/extensions/browser.cjs'))});
 writeFileSync(`${out}/${name}.vsix`,archive);
}
console.log(`Extension fixtures written to ${out}`);
