import test from 'node:test';
import assert from 'node:assert/strict';
import { entryName, retargetPath } from './fileOps.ts';
import { applyDrafts } from './drafts.ts';

test('explorer names are a single path component', () => {
  assert.equal(entryName('src'), 'src');
  assert.equal(entryName('  lib '), 'lib');
  assert.equal(entryName(null), null);
  assert.equal(entryName('..'), null);
  assert.equal(entryName('a/b'), null);
  assert.equal(entryName(''), null);
});

test('renaming a folder retargets the open buffers inside it', () => {
  assert.equal(retargetPath('/proj/src/lib.rs', '/proj/src', '/proj/lib'), '/proj/lib/lib.rs');
  assert.equal(retargetPath('/proj/src2/lib.rs', '/proj/src', '/proj/lib'), '/proj/src2/lib.rs');
});

test('a draft returns only when the disk baseline is unchanged', () => {
  const buffers = { '/proj/a.ts': { value: 'saved', saved: 'saved', disk: true } };
  const applied = applyDrafts(buffers, [{ path: '/proj/a.ts', basis: 'saved', value: 'edited' }]);
  assert.equal(applied.buffers['/proj/a.ts'].value, 'edited');
  assert.equal(applied.skipped.length, 0);
  const skipped = applyDrafts(buffers, [{ path: '/proj/a.ts', basis: 'older', value: 'edited' }]);
  assert.equal(skipped.buffers['/proj/a.ts'].value, 'saved');
  assert.deepEqual(skipped.skipped, ['/proj/a.ts']);
});
