export const accessibilityDefaults = {
  zoom: 100,
  contrast: 'system' as 'system' | 'dark' | 'light',
  screenReader: 'auto' as 'auto' | 'on' | 'off',
  reducedMotion: false,
  largeCursor: false,
  announceOutput: false,
  soundCues: false,
  soundVolume: 20,
};
export type AccessibilityPreferences = typeof accessibilityDefaults;
export function restoreAccessibility(json: string): AccessibilityPreferences {
  const result = { ...accessibilityDefaults };
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const key of ['reducedMotion', 'largeCursor', 'announceOutput', 'soundCues'] as const)
      if (typeof value[key] === 'boolean') result[key] = value[key];
    if (Number.isInteger(value.zoom) && value.zoom >= 100 && value.zoom <= 200) result.zoom = value.zoom;
    if (Number.isInteger(value.soundVolume) && value.soundVolume >= 0 && value.soundVolume <= 100) result.soundVolume = value.soundVolume;
    if (['system', 'dark', 'light'].includes(value.contrast)) result.contrast = value.contrast;
    if (['auto', 'on', 'off'].includes(value.screenReader)) result.screenReader = value.screenReader;
  } catch { /* Older or damaged storage uses safe defaults. */ }
  return result;
}
