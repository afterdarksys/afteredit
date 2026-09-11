import { useCallback, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { contextParts, type ActiveContext } from './activeContext';

/**
 * What a command launched from here would actually target. Resolved through
 * the same PATH and environment the app uses for tasks, so it reflects the
 * real blast radius rather than a guess.
 */
export default function ContextBadge({ root, revision }: { root: string; revision: number }) {
  const [context, setContext] = useState<ActiveContext | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    setBusy(true);
    try {
      setContext(await invoke<ActiveContext>('active_context', { root: root || null }));
    } catch {
      setContext(null); // A probe that cannot run shows nothing, never a wrong answer.
    } finally {
      setBusy(false);
    }
  }, [root]);

  useEffect(() => { void refresh(); }, [refresh, revision]);

  if (!context) return null;
  const parts = contextParts(context);
  if (!parts.length) return null;

  return (
    <span
      className={`context-badge ${context.production ? 'context-production' : ''}`}
      title="Cluster, account and workspace a command from this window would use. Click to refresh."
      onClick={() => void refresh()}
      role="status"
    >
      {context.production && <strong className="context-warn">PROD</strong>}
      {parts.map(part => (
        <span key={part.label} className="context-part">
          <span className="context-label">{part.label}</span> {part.value}
        </span>
      ))}
      {busy && <span className="context-busy">…</span>}
    </span>
  );
}
