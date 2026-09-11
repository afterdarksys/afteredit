import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLabel, formatWhen, formatSize, summarizeChange } from './localHistory.ts';

test('the bridge label explains itself', () => {
  assert.equal(describeLabel('bridge-open'), 'Before terminal edit');
  assert.equal(describeLabel('save'), 'Saved');
});

test('relative times', () => {
  const now = Date.parse('2024-06-01T12:00:00Z');
  assert.equal(formatWhen(now - 5_000, now), 'just now');
  assert.equal(formatWhen(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatWhen(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatWhen(now - 2 * 86_400_000, now), '2d ago');
  // Past a week, an absolute date is more useful than "23d ago".
  assert.match(formatWhen(now - 23 * 86_400_000, now), /\d/);
});

test('sizes', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
});

test('change summary reports line movement', () => {
  assert.equal(summarizeChange('a\nb', 'a\nb'), 'identical to the current buffer');
  assert.equal(summarizeChange('a\nb', 'a\nb\nc'), '2 → 3 lines (+1)');
  assert.equal(summarizeChange('a\nb\nc', 'a'), '3 → 1 lines (-2)');
  assert.equal(summarizeChange('a\nb', 'x\ny'), '2 lines, content differs');
});

test('an empty document counts as zero lines', () => {
  assert.equal(summarizeChange('', 'a'), '0 → 1 lines (+1)');
});
