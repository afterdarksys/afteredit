import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectBuildSystems,serverPresets} from './languageServices.ts';
import {presets} from './workflows.ts';
test('Swift and Xcode projects have explicit toolchain entry points',()=>{
 assert.deepEqual(detectBuildSystems(['Package.swift','App.xcodeproj','App.xcworkspace']),['Swift Package','Xcode']);
 assert.deepEqual(serverPresets.swift.args,['sourcekit-lsp']);assert.deepEqual(presets['Swift Package'].test.args,['swift','test']);
});
import {appleMetadata,appleDestinations} from './appleDevelopment.ts';
test('Xcode and Swift metadata normalizes schemes targets and unavailable destinations',()=>{
 assert.deepEqual(appleMetadata('{"project":{"schemes":["App"],"targets":["App","Tests"],"configurations":["Debug"]}}').targets,['App','Tests']);
 assert.deepEqual(appleMetadata('{"targets":[{"name":"Core"}]}').targets,['Core']);
 const rows=appleDestinations('Available destinations:\n{ platform:iOS Simulator, id:ABC, OS:18.0, name:iPhone }\nIneligible destinations:\n{ platform:iOS, id:DEF, name:Device, error:Unavailable }');
 assert.equal(rows[0].available,true);assert.equal(rows[1].available,false);
});
import {appleBuild,appleDiagnostics} from './appleDevelopment.ts';
const selection={project:'My App.xcodeproj',scheme:'My App',target:'',configuration:'Debug',destination:'platform=macOS'};
test('build plans preserve literal project paths and require explicit test destinations',()=>{
 const plan=appleBuild(selection,'test','run-1');assert.ok(plan.tasks[1].args.includes('My App.xcodeproj'));assert.ok(plan.result?.endsWith('run-1.xcresult'));
 assert.throws(()=>appleBuild({...selection,destination:''},'test','run-1'),/destination/);
 assert.throws(()=>appleBuild({...selection,project:'../App.xcodeproj'},'build','run'),/relative/);
 assert.equal(appleBuild({...selection,project:'Library/Package.swift'},'test','run').tasks[0].cwd,'Library/');
});
test('Apple diagnostics preserve spaces and discard paths outside the workspace',()=>{
 const result=appleDiagnostics('/repo/My File.swift:3:7: error: Broken\n/repo/Test.swift:9: error: Failed\n/outside/a.swift:1:1: warning: Wrong','/repo');
 assert.equal(result.length,2);assert.equal(result[0].column,7);assert.equal(result[1].column,1);
});
import {appleSimulators,simulatorAction,appleProducts} from './appleDevelopment.ts';
test('simulator actions target an explicit device and app bundle',()=>{
 const id='12345678-1234-1234-1234-123456789ABC';assert.throws(()=>simulatorAction('booted','launch','','com.example.app'),/UUID/);
 assert.deepEqual(simulatorAction(id,'boot','','')[0].args,['simctl','bootstatus',id,'-b']);
 assert.throws(()=>simulatorAction(id,'install','../App.app',''),/relative/);
 assert.equal(appleSimulators('{"devices":{"iOS":[{"udid":"id","isAvailable":false}]}}')[0].available,false);
 assert.equal(appleProducts('[{"target":"App","buildSettings":{"TARGET_BUILD_DIR":"/repo/out","FULL_PRODUCT_NAME":"App.app"}}]','/repo')[0].app,'out/App.app');
});
import {appleDevices,deviceAction} from './appleDevelopment.ts';
test('physical devices use CoreDevice identifiers and explicit console launch',()=>{
 assert.deepEqual(appleDevices('{"info":{"outcome":"success"},"result":{"devices":[]}}'),[]);
 assert.throws(()=>deviceAction('My iPhone','launch','','com.example.App'),/identifier/);
 const id='12345678-1234-1234-1234-123456789ABC';assert.ok(deviceAction(id,'console','','com.example.App')[0].args.includes('--console'));
});
import {appleDebug} from './appleDevelopment.ts';
test('Swift and simulator debugging distinguish launch from attach',()=>{
 assert.equal(appleDebug('/repo','.build/debug/App','launch','').request,'launch');
 assert.equal(appleDebug('/repo','out/App','attach','42').configuration.pid,42);
 assert.throws(()=>appleDebug('/repo','out/App','device','42','device; quit'),/connected device/);
 assert.throws(()=>appleDebug('/repo','out/App','attach','0'),/process ID/);
});
import {defaultSigning,signingArguments,archivePlan,exportPlan,exportOptions} from './appleDevelopment.ts';
test('signing provisioning and export settings are explicit and escaped',()=>{
 assert.deepEqual(signingArguments(defaultSigning),[]);
 assert.throws(()=>archivePlan({...selection,destination:'platform=iOS Simulator'},defaultSigning,'App.xcarchive'),/destination/);
 assert.ok(!exportPlan('App.xcarchive','ExportOptions.plist','out',false).tasks[0].args.includes('-allowProvisioningUpdates'));
 const plist=exportOptions('debugging',{...defaultSigning,style:'manual',profile:'A & B'},{'com.example.App':'A & B'});
 assert.ok(plist.includes('A &amp; B'));assert.ok(plist.includes('<string>export</string>'));assert.ok(!plist.includes('<string>upload</string>'));
 assert.throws(()=>signingArguments({...defaultSigning,team:'bad'}),/Team ID/);
});
import {buildServerPlan} from './appleDevelopment.ts';
test('Xcode build-server setup preserves workspace and scheme arguments',()=>{
 assert.deepEqual(buildServerPlan({...selection,project:'App Space.xcworkspace'},'/repo').tasks[0].args,['config','-workspace','/repo/App Space.xcworkspace','-scheme','My App','--build_root','/repo/.afteredit/apple/DerivedData']);
 assert.throws(()=>buildServerPlan({...selection,project:'Package.swift'},'/repo'),/do not need/);
});
