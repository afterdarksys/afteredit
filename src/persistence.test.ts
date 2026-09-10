import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restorePreference } from './persistence.ts';
test('corrupt and wrong-shaped preferences cannot poison startup', () => {
  assert.equal(restorePreference('null', 'mac'), 'mac');
  assert.equal(restorePreference('42', 'explorer'), 'explorer');
  assert.equal(restorePreference('{broken', false), false);
  assert.equal(restorePreference('1e999', 2048), 2048);
  assert.deepEqual(restorePreference('null', {}), {});
  assert.deepEqual(restorePreference('{"x":null}', {x:'text'}), {x:'text'});
  assert.equal(restorePreference('"win"', 'mac'), 'win');
});
