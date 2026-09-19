import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecretLines, secretRefusal } from './secrets.ts';
import type { SecretFinding } from './policy.ts';

const finding = (over: Partial<SecretFinding> = {}): SecretFinding => ({
  rule: 'github-token', description: 'GitHub token', file: 'diagnostics.json', start_line: 2,
  fingerprint: null, detector: 'builtin', ...over,
});

test('refusal names locations and never needs the value', () => {
  const message = secretRefusal([finding(), finding({ start_line: 4, rule: 'aws-access-key', description: 'AWS access key id' })], 'the edit');
  assert.match(message, /2 possible secrets in the edit/);
  assert.match(message, /diagnostics.json:2 GitHub token/);
  assert.doesNotMatch(message, /ghp_/);
});

test('secret lines are replaced without copying their contents', () => {
  const text = '{\n  "token": "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",\n  "ok": true\n}';
  const redacted = redactSecretLines(text, [finding()]);
  assert.doesNotMatch(redacted, /ghp_/);
  assert.match(redacted, /redacted: github-token/);
  JSON.parse(redacted);
});

test('broken JSON after redaction is wrapped so the download stays valid', () => {
  const text = 'not json\nsecret line\n';
  const wrapped = redactSecretLines(text, [finding()]);
  const parsed = JSON.parse(wrapped);
  assert.equal(parsed.redacted, true);
  assert.doesNotMatch(wrapped, /secret line/);
});
