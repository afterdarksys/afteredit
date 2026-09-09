/** Regex tester: compile, run, and report matches with their groups. */

export interface RegexMatch {
  index: number;
  text: string;
  groups: Array<{ name: string; value: string | undefined }>;
}

export interface RegexResult {
  ok: boolean;
  error?: string;
  matches: RegexMatch[];
  /** True when the pattern can match empty and we had to force progress. */
  matchedEmpty: boolean;
  truncated: boolean;
}

const MATCH_LIMIT = 500;

export function testRegex(
  pattern: string,
  flags: string,
  input: string,
  limit = MATCH_LIMIT,
): RegexResult {
  const empty: RegexResult = { ok: true, matches: [], matchedEmpty: false, truncated: false };
  if (!pattern) return empty;

  let regex: RegExp;
  try {
    // Always global: we want every match, not just the first.
    regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch (error) {
    return { ok: false, error: (error as Error).message, matches: [], matchedEmpty: false, truncated: false };
  }

  const matches: RegexMatch[] = [];
  let matchedEmpty = false;
  let truncated = false;
  let found: RegExpExecArray | null;

  while ((found = regex.exec(input)) !== null) {
    const groups: Array<{ name: string; value: string | undefined }> = [];
    for (let i = 1; i < found.length; i += 1) {
      groups.push({ name: String(i), value: found[i] });
    }
    for (const [name, value] of Object.entries(found.groups ?? {})) {
      groups.push({ name, value });
    }
    matches.push({ index: found.index, text: found[0], groups });

    // A zero-length match leaves lastIndex where it was; without this nudge
    // the loop never terminates.
    if (found[0] === "") {
      matchedEmpty = true;
      regex.lastIndex += 1;
    }
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
  }

  return { ok: true, matches, matchedEmpty, truncated };
}

/** Apply a replacement, honouring $1 / $<name> like String.replace does. */
export function replaceAll(pattern: string, flags: string, input: string, replacement: string): string {
  const regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  return input.replace(regex, replacement);
}

/** Escape a literal so it can be embedded in a pattern. */
export function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const COMMON_PATTERNS: Array<{ label: string; pattern: string; flags: string }> = [
  { label: "IPv4 address", pattern: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`, flags: "g" },
  { label: "Email", pattern: String.raw`[\w.+-]+@[\w-]+\.[\w.]+`, flags: "gi" },
  { label: "URL", pattern: String.raw`https?://[^\s"'<>]+`, flags: "gi" },
  { label: "UUID", pattern: String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`, flags: "gi" },
  { label: "ISO 8601 timestamp", pattern: String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`, flags: "g" },
  { label: "AWS access key id", pattern: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: "g" },
  { label: "Semver", pattern: String.raw`\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b`, flags: "g" },
  { label: "K8s resource name", pattern: String.raw`\b[a-z0-9]([-a-z0-9]*[a-z0-9])?\b`, flags: "g" },
];
