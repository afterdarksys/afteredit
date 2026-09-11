import test from 'node:test';
import assert from 'node:assert/strict';
import { contextParts, type ActiveContext } from './activeContext.ts';

const ctx = (over: Partial<ActiveContext> = {}): ActiveContext => ({
  kube_context: null, kube_namespace: null, aws_profile: null,
  aws_region: null, terraform_workspace: null, production: false, ...over,
});

test('nothing configured shows nothing', () => {
  assert.deepEqual(contextParts(ctx()), []);
});

test('kube context includes the namespace when there is one', () => {
  assert.deepEqual(contextParts(ctx({ kube_context: 'acme-prod' })), [{ label: 'k8s', value: 'acme-prod' }]);
  assert.deepEqual(
    contextParts(ctx({ kube_context: 'acme-prod', kube_namespace: 'payments' })),
    [{ label: 'k8s', value: 'acme-prod/payments' }],
  );
});

test('aws pairs the profile with its region', () => {
  assert.deepEqual(contextParts(ctx({ aws_profile: 'admin' })), [{ label: 'aws', value: 'admin' }]);
  assert.deepEqual(
    contextParts(ctx({ aws_profile: 'admin', aws_region: 'us-east-1' })),
    [{ label: 'aws', value: 'admin (us-east-1)' }],
  );
});

test('a region with no profile is not shown alone', () => {
  // Region without a profile says nothing about blast radius.
  assert.deepEqual(contextParts(ctx({ aws_region: 'us-east-1' })), []);
});

test('parts are ordered by blast radius', () => {
  const parts = contextParts(ctx({
    kube_context: 'c', aws_profile: 'p', terraform_workspace: 'w',
  }));
  assert.deepEqual(parts.map(p => p.label), ['k8s', 'aws', 'tf']);
});
