/** A single path component the explorer may create or rename to. */
export function entryName(input: string | null): string | null {
  if (input === null) return null;
  const name = input.trim();
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/\0]/.test(name)) return null;
  return name;
}

/**
 * Parent directory and final component of a path a language server named.
 * The name is not trimmed. `/file` has parent `/`. No slash, or a mix of
 * slash and backslash, returns null.
 */
export function parentName(path: string): { parent: string; name: string } | null {
  if (path.includes('/') && path.includes('\\')) return null;
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slash < 0) return null;
  const name = path.slice(slash + 1);
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/\0]/.test(name)) return null;
  const rootish = slash === 0 || /^[A-Za-z]:[\\/]$/.test(path.slice(0, slash + 1));
  const parent = rootish ? path.slice(0, slash + 1) : path.slice(0, slash);
  return parent ? { parent, name } : null;
}

/** Point open buffers at a file or folder after the explorer renames it. */
export function retargetPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  const slash = path.startsWith(from + '/') || path.startsWith(from + '\\');
  return slash ? to + path.slice(from.length) : path;
}
