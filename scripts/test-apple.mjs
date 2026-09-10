import {mkdtempSync,cpSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {run} from './infrastructure-process.mjs';
import {appleMetadata,appleBuild,appleProducts,appleDestinations,defaultSigning} from '../src/appleDevelopment.ts';
if(process.platform!=='darwin')throw new Error('Apple smoke tests require macOS and Xcode.');
const root=mkdtempSync(join(tmpdir(),'afteredit-apple-live-'));cpSync(resolve('fixtures/apple-xcode'),root,{recursive:true});
const selection={project:'Smoke.xcodeproj',scheme:'Smoke',target:'',configuration:'Debug',destination:'platform=macOS'};
async function invoke(command,args){const result=await run(command,args,root,{timeout:300000,maxBytes:8_000_000});if(result.code!==0)throw new Error(command+' failed ('+result.code+')\n'+result.stdout+'\n'+result.stderr);return result.stdout;}
const metadata=appleMetadata(await invoke('/usr/bin/xcodebuild',['-project',selection.project,'-list','-json']));assert.ok(metadata.schemes.includes('Smoke'));console.log('Xcode schemes and targets discovered');
const destinations=appleDestinations(await invoke('/usr/bin/xcodebuild',['-project',selection.project,'-scheme','Smoke','-showdestinations']));assert.ok(destinations.some(d=>d.platform==='macOS'&&d.available));console.log('macOS build destination discovered');
const plan=appleBuild(selection,'test','live',{...defaultSigning,style:'unsigned'});
for(const task of plan.tasks){const output=await invoke(task.command,task.args);writeFileSync(join(root,'build.log'),output);}
assert.ok(existsSync(join(root,plan.result)));console.log('Real Xcode build and XCTest completed');
const summary=JSON.parse(await invoke('/usr/bin/xcrun',['xcresulttool','get','test-results','summary','--path',plan.result,'--compact']));assert.ok(summary.passedTests>=1);assert.equal(summary.failedTests,0);console.log('xcresult test summary reports passing tests');
const products=appleProducts(await invoke('/usr/bin/xcodebuild',['-project',selection.project,'-scheme','Smoke','-showBuildSettings','-json','-derivedDataPath',join(root,'.afteredit/apple/DerivedData')]),root);
assert.ok(products.some(p=>p.app.endsWith('Smoke.app')&&existsSync(join(root,p.app))));console.log('Built app path matches product settings');
console.log('Fixtures and logs: '+root);
