import { useEffect, useState } from "react";

/**
 * `useState` mirrored into localStorage, so a preference survives a restart.
 *
 * Storage can throw outright (private mode, site data blocked) and can hold
 * junk from an older build, so every access is guarded: failing to remember a
 * preference should never stop the app from rendering.
 */
export function usePersistedState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : (JSON.parse(stored) as T);
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* preference just won't persist this session */
    }
  }, [key, value]);

  return [value, setValue] as const;
}
