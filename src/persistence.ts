/** Reject valid JSON with the wrong shape as well as malformed storage. */
export function restorePreference<T>(stored: string | null, fallback: T): T {
  try {
    const parsed: unknown = stored === null ? fallback : JSON.parse(stored);
    if (parsed === null || typeof parsed !== typeof fallback || Array.isArray(parsed) !== Array.isArray(fallback)) return fallback;
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) return fallback;
    if (typeof fallback === 'object' && !Array.isArray(fallback) && Object.values(parsed as object).some(v => typeof v !== 'string')) return fallback;
    return parsed as T;
  } catch { return fallback; }
}
