import test from 'node:test';
import assert from 'node:assert/strict';
import { externalFormattingWanted } from './formatterPolicy.ts';
import type { ConnectedServer } from './languageServices.ts';

const server = (language: string, formats: boolean): ConnectedServer => ({
  id: 1, root: '/w', root_uri: 'file:///w', language,
  capabilities: formats ? { documentFormattingProvider: true } : {},
});

test('no server means the external formatter runs', () => {
  assert.equal(externalFormattingWanted('python', []), true);
});

test('a server that formats takes over the language', () => {
  assert.equal(externalFormattingWanted('go', [server('go', true)]), false);
});

test('a server that does not advertise formatting leaves it to us', () => {
  // pyright and bash-language-server are the real cases: configured, useful,
  // but no documentFormattingProvider.
  assert.equal(externalFormattingWanted('python', [server('python', false)]), true);
  assert.equal(externalFormattingWanted('shell', [server('shell', false)]), true);
});

test('another language formatting does not disable ours', () => {
  assert.equal(externalFormattingWanted('yaml', [server('go', true), server('rust', true)]), true);
});

test('capabilities may be missing entirely', () => {
  const bare = { id: 2, root: '/w', root_uri: 'file:///w', language: 'toml' } as unknown as ConnectedServer;
  assert.equal(externalFormattingWanted('toml', [bare]), true);
});
