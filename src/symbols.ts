/**
 * Workspace-wide symbol search.
 *
 * Kept clear of Monaco on purpose: the standalone editor has no workspace
 * symbol UI to plug into, so this is a plain backend query that the search
 * panel renders itself (and that tests can exercise without a DOM).
 */
import { invoke } from '@tauri-apps/api/core';
import type { ConnectedServer } from './languageServices';
import { fileUriToPath } from './workspaceEdit';

export type WorkspaceSymbol = { name: string; container: string; kind: number; path: string; line: number; column: number; language: string };

export async function workspaceSymbols(servers: ConnectedServer[], query: string): Promise<WorkspaceSymbol[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const answers = await Promise.all(
    servers.filter(server => server.capabilities.workspaceSymbolProvider).map(async server => {
      // One slow or dead server must not blank out the others' results.
      const rows = await invoke<any[]>('lsp_request', { session: server.id, method: 'workspace/symbol', params: { query: trimmed } }).catch(() => null);
      return (rows ?? []).flatMap((row: any) => {
        // SymbolInformation carries `location`; the newer WorkspaceSymbol may
        // carry only a uri until it is resolved.
        const uri = row.location?.uri ?? row.uri;
        const start = row.location?.range?.start ?? { line: 0, character: 0 };
        if (typeof uri !== 'string') return [];
        // A symbol inside a jar or a generated stub has no file to open.
        let path: string;
        try { path = fileUriToPath(uri); } catch { return []; }
        return [{ name: String(row.name ?? ''), container: row.containerName ?? '', kind: Number(row.kind ?? 0), path, line: start.line + 1, column: start.character + 1, language: server.language }];
      });
    }),
  );
  return answers.flat();
}
