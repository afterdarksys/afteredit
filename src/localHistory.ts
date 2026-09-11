export type HistoryLabel = 'save' | 'bridge-open' | 'restore';

export type HistoryEntry = {
  id: string;
  millis: number;
  label: HistoryLabel;
  bytes: number;
};

const LABELS: Record<HistoryLabel, string> = {
  save: 'Saved',
  // The one that matters: what the file looked like before a terminal
  // command edited it, which the temp file itself does not survive.
  'bridge-open': 'Before terminal edit',
  restore: 'Restored',
};

export function describeLabel(label: HistoryLabel): string {
  return LABELS[label] ?? label;
}

export function formatWhen(millis: number, now = Date.now()): string {
  const delta = now - millis;
  if (delta < 0) return new Date(millis).toLocaleString();
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(millis).toLocaleDateString();
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Line counts for a quick sense of the change without a full diff. */
export function summarizeChange(before: string, after: string): string {
  if (before === after) return 'identical to the current buffer';
  const from = before === '' ? 0 : before.split('\n').length;
  const to = after === '' ? 0 : after.split('\n').length;
  const delta = to - from;
  if (delta === 0) return `${from} lines, content differs`;
  return delta > 0 ? `${from} → ${to} lines (+${delta})` : `${from} → ${to} lines (${delta})`;
}
