/** A single path component the explorer may create or rename to. */
export function entryName(input: string | null): string | null {
  if (input === null) return null;
  const name = input.trim();
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/\0]/.test(name)) return null;
  return name;
}

/** Point open buffers at a file or folder after the explorer renames it. */
export function retargetPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  const slash = path.startsWith(from + '/') || path.startsWith(from + '\\');
  return slash ? to + path.slice(from.length) : path;
}
