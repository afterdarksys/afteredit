import { useCallback, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  describeLabel, formatSize, formatWhen, summarizeChange, type HistoryEntry,
} from './localHistory';

/**
 * Every save of this file, independent of version control.
 *
 * Restoring loads the snapshot into the buffer rather than writing to disk --
 * you still see it, and still have to save. An undo feature that silently
 * overwrites the file would be its own hazard.
 */
export default function HistoryPanel({
  path,
  current,
  onRestore,
}: {
  path: string;
  current: string;
  onRestore: (text: string) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<{ id: string; text: string } | null>(null);
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    if (!path || !isTauri()) { setEntries([]); return; }
    try {
      setEntries(await invoke<HistoryEntry[]>('history_list', { path }));
      setStatus('');
    } catch (e) {
      setEntries([]);
      setStatus(String(e));
    }
  }, [path]);

  useEffect(() => { setSelected(null); void refresh(); }, [refresh, current]);

  async function preview(entry: HistoryEntry) {
    try {
      const text = await invoke<string>('history_read', { path, id: entry.id });
      setSelected({ id: entry.id, text });
      setStatus(summarizeChange(text, current));
    } catch (e) {
      setStatus(String(e));
    }
  }

  if (!path) return <p className="history-empty">Open a file to see its history.</p>;

  return (
    <section className="history-panel" aria-label={`Local history for ${path}`}>
      <div className="field-row">
        <h2>Local history</h2>
        <button type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {!entries.length && (
        <p className="history-empty">
          No snapshots yet. One is taken on every save, and before any terminal
          command edits this file.
        </p>
      )}

      <ul className="history-list">
        {entries.map(entry => (
          <li key={entry.id} className={selected?.id === entry.id ? 'history-selected' : ''}>
            <button type="button" className="history-entry" onClick={() => void preview(entry)}>
              <span className="history-when">{formatWhen(entry.millis)}</span>
              <span className={`history-label history-${entry.label}`}>{describeLabel(entry.label)}</span>
              <span className="history-size">{formatSize(entry.bytes)}</span>
            </button>
          </li>
        ))}
      </ul>

      <p role="status">{status}</p>

      {selected && (
        <div className="history-preview">
          <div className="field-row">
            <button
              type="button"
              disabled={selected.text === current}
              onClick={() => { onRestore(selected.text); setStatus('Loaded into the buffer — save to keep it.'); }}
            >
              Restore into buffer
            </button>
            <button type="button" onClick={() => setSelected(null)}>Close</button>
          </div>
          <pre className="history-content">{selected.text}</pre>
        </div>
      )}
    </section>
  );
}
