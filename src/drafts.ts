export type Draft = { path: string; basis: string; value: string };
export type DiskBuffer = { value: string; saved: string; disk: boolean };

/**
 * Put a stored draft back only when the file on disk is still the text the
 * edit was based on. A newer disk copy is left alone and reported.
 */
export function applyDrafts<T extends DiskBuffer>(buffers: Record<string, T>, drafts: Draft[]): { buffers: Record<string, T>; skipped: string[] } {
  const next = { ...buffers };
  const skipped: string[] = [];
  for (const draft of drafts) {
    const buffer = next[draft.path];
    if (!buffer?.disk || draft.value === draft.basis) continue;
    if (buffer.saved !== draft.basis) {
      skipped.push(draft.path);
      continue;
    }
    next[draft.path] = { ...buffer, value: draft.value };
  }
  return { buffers: next, skipped };
}
