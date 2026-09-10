import test from 'node:test';
import assert from 'node:assert/strict';
import {accessibilityDefaults,restoreAccessibility,accessibleEditorOptions,accessibleEditorTheme} from './accessibility.ts';
test('damaged accessibility preferences cannot hide the app or enable sound',()=>{
  for(const value of ['broken','null','[]','false','{"zoom":0,"soundCues":"true","contrast":"invisible"}']){
    assert.deepEqual(restoreAccessibility(value),accessibilityDefaults);
  }
  assert.equal(restoreAccessibility('{"zoom":201}').zoom,100);
  assert.equal(restoreAccessibility('{"zoom":150,"reducedMotion":true,"screenReader":"on"}').zoom,150);
});
test('personal accessibility overrides editor display and can be switched off',()=>{
  const prefs={...accessibilityDefaults,screenReader:'on' as const,largeCursor:true,reducedMotion:true};
  assert.equal(accessibleEditorOptions(prefs,'test.ts').tabFocusMode,true);
  assert.equal(accessibleEditorOptions(prefs,'test.ts').cursorBlinking,'solid');
  assert.equal(accessibleEditorOptions(accessibilityDefaults,'test.ts').tabFocusMode,false);
  assert.equal(accessibleEditorOptions(accessibilityDefaults,'test.ts').cursorWidth,2);
  assert.equal(accessibleEditorTheme({...prefs,contrast:'light'},'custom-theme'),'hc-light');
  assert.equal(accessibleEditorTheme(accessibilityDefaults,'custom-theme'),'custom-theme');
});
