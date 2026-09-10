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
