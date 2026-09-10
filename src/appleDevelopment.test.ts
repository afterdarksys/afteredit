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
