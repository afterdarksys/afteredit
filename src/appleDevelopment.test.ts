import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectBuildSystems,serverPresets} from './languageServices.ts';
import {presets} from './workflows.ts';
test('Swift and Xcode projects have explicit toolchain entry points',()=>{
 assert.deepEqual(detectBuildSystems(['Package.swift','App.xcodeproj','App.xcworkspace']),['Swift Package','Xcode']);
 assert.deepEqual(serverPresets.swift.args,['sourcekit-lsp']);assert.deepEqual(presets['Swift Package'].test.args,['swift','test']);
});
