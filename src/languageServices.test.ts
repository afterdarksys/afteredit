import test from 'node:test';
import assert from 'node:assert/strict';
import { clientCapabilities, decodeSemanticTokens } from './languageServices.ts';

function dynamicRegistration(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(dynamicRegistration);
  const record = value as Record<string, unknown>;
  if (record.dynamicRegistration === true) return true;
  return Object.values(record).some(dynamicRegistration);
}

test('initialize asks for tokens, hints, and hierarchy without dynamic registration or deltas', () => {
  const capabilities = clientCapabilities();
  assert.equal(dynamicRegistration(capabilities), false);
  assert.equal(capabilities.textDocument.semanticTokens.requests.full.delta, false);
  assert.equal(capabilities.textDocument.semanticTokens.requests.range, false);
  assert.deepEqual(capabilities.textDocument.inlayHint, {});
  assert.deepEqual(capabilities.textDocument.callHierarchy, {});
  assert.deepEqual(capabilities.textDocument.typeHierarchy, {});
  assert.ok(capabilities.textDocument.semanticTokens.tokenTypes.includes('function'));
  assert.ok(capabilities.textDocument.semanticTokens.tokenModifiers.includes('declaration'));
});

test('a semantic token payload paints only when it is five integers per token', () => {
  assert.equal(decodeSemanticTokens(null)?.length, 0);
  assert.equal(decodeSemanticTokens({ data: null })?.length, 0);
  assert.equal(decodeSemanticTokens('nope'), null);
  assert.equal(decodeSemanticTokens({ data: [1, 2, 3] }), null);
  assert.equal(decodeSemanticTokens({ data: [1, 2, 3, 4, -1] }), null);
  assert.equal(decodeSemanticTokens({ data: [1.5, 0, 0, 0, 0] }), null);
  assert.equal(decodeSemanticTokens({ data: [0, 0, 0, 0, 0x1_0000_0000] }), null);
  const decoded = decodeSemanticTokens({ data: [0, 1, 2, 3, 4] });
  assert.ok(decoded instanceof Uint32Array);
  assert.deepEqual([...(decoded ?? [])], [0, 1, 2, 3, 4]);
});
