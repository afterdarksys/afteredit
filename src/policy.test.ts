import test from 'node:test';
import assert from 'node:assert/strict';
import { policyDiagnostics, summarize, type PolicyFinding, type PolicyReport } from './policy.ts';

const finding = (over: Partial<PolicyFinding> = {}): PolicyFinding => ({
  severity: 'error', rule: 'terraform.s3', message: 'not encrypted',
  resource: 'aws_s3_bucket.artifacts', path: '/w/main.tf', line: 5, column: 1, ...over,
});

test('located findings become markers', () => {
  const [marker] = policyDiagnostics([finding()]);
  assert.equal(marker.path, '/w/main.tf');
  assert.equal(marker.line, 5);
  assert.equal(marker.severity, 'error');
  assert.equal(marker.source, 'policy');
  assert.match(marker.message, /not encrypted \(terraform\.s3\)/);
});

test('findings with no source line are not markers', () => {
  // A cluster-wide rule has nothing to point at; it still belongs in the list.
  assert.deepEqual(policyDiagnostics([finding({ path: null, line: null })]), []);
  assert.deepEqual(policyDiagnostics([finding({ line: 0 })]), []);
});

test('a missing column falls back to the start of the line', () => {
  assert.equal(policyDiagnostics([finding({ column: null })])[0].column, 1);
});

test('severity is carried through', () => {
  assert.equal(policyDiagnostics([finding({ severity: 'warning' })])[0].severity, 'warning');
});

const report = (findings: PolicyFinding[], unlocated = 0): PolicyReport =>
  ({ findings, unlocated, engine: '/usr/local/bin/opa', policies: '/w/policies', input: '/w/plan.json' });

test('summary counts by severity', () => {
  assert.equal(summarize(report([])), 'No policy violations');
  assert.equal(summarize(report([finding()])), '1 violation');
  assert.equal(
    summarize(report([finding(), finding(), finding({ severity: 'warning' })])),
    '2 violations, 1 warning',
  );
  assert.match(summarize(report([finding()], 2)), /2 without a source line/);
});
