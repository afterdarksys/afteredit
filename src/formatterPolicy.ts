import type { ConnectedServer } from './languageServices';

/**
 * The external (subprocess) formatter is a *fallback*.
 *
 * A connected language server that advertises `documentFormattingProvider`
 * already owns the language; registering a second Monaco provider for it makes
 * the editor stop and ask the user which formatter to use on every format.
 *
 * The test is the server's advertised capability, not its preset: pyright and
 * bash-language-server are configured for python and shell but format neither,
 * so those languages still need the external tool (ruff/black, shfmt).
 */
export function externalFormattingWanted(language: string, servers: ConnectedServer[]): boolean {
  return !servers.some(
    (server) => server.language === language && Boolean(server.capabilities?.documentFormattingProvider),
  );
}
