import {mkdtempSync,cpSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {run} from './infrastructure-process.mjs';
import {appleBuild,defaultSigning,appleProducts,simulatorAction} from '../src/appleDevelopment.ts';
if(process.platform!=='darwin')throw new Error('Simulator smoke requires macOS.');
const root=mkdtempSync(join(tmpdir(),'afteredit-simulator-live-'));cpSync(resolve('fixtures/apple-xcode'),root,{recursive:true});
async function invoke(command,args){const r=await run(command,args,root,{timeout:300000,maxBytes:8_000_000});writeFileSync(join(root,'last-command.log'),r.stdout+'\n'+r.stderr);if(r.code!==0)throw new Error(command+' '+args.join(' ')+' failed: '+r.stderr+'\nSee '+root+'/last-command.log');return r.stdout;}
const available=JSON.parse(await invoke('/usr/bin/xcrun',['simctl','list','devices','available','--json']));
const candidates=Object.entries(available.devices).flatMap(([runtime,list])=>runtime.includes('.iOS-')?list.filter(d=>d.isAvailable&&d.name.startsWith('iPhone')).map(d=>({runtime,type:d.deviceTypeIdentifier})):[]);
assert.ok(candidates.length,'Install an available iOS Simulator runtime to run this opt-in check.');
let id;
try{
 id=(await invoke('/usr/bin/xcrun',['simctl','create','AfterEdit isolated smoke',candidates[0].type,candidates[0].runtime])).trim();console.log('Created temporary simulator '+id);
 await invoke('/usr/bin/xcrun',['simctl','bootstatus',id,'-b']);console.log('Simulator booted');
 const selection={project:'Smoke.xcodeproj',scheme:'Smoke',target:'',configuration:'Debug',destination:'platform=iOS Simulator,id='+id};
 for(const task of appleBuild(selection,'build','simulator',{...defaultSigning,style:'unsigned'}).tasks)await invoke(task.command,task.args);
 const products=appleProducts(await invoke('/usr/bin/xcodebuild',['-project','Smoke.xcodeproj','-scheme','Smoke','-destination',selection.destination,'-showBuildSettings','-json','-derivedDataPath',join(root,'.afteredit/apple/DerivedData')]),root);
 const product=products.find(p=>p.app.endsWith('Smoke.app'));assert.ok(product);
 for(const action of ['install','launch'])for(const task of simulatorAction(id,action,product.app,product.bundle))await invoke(task.command,task.args);
 console.log('Simulator app build, install and launch passed');
}finally{
 if(id){await run('/usr/bin/xcrun',['simctl','shutdown',id],root);await invoke('/usr/bin/xcrun',['simctl','delete',id]);console.log('Removed temporary simulator '+id);}
 console.log('Fixtures and logs: '+root);
}
