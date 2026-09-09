/** Line-ending detection and conversion -- the CRLF-in-a-Dockerfile class of bug. */

export type Eol = "lf" | "crlf" | "cr";

export interface EolStats {
  lf: number;
  crlf: number;
  cr: number;
  mixed: boolean;
  dominant: Eol | null;
  /** Trailing whitespace is the usual companion complaint. */
  trailingWhitespaceLines: number;
  finalNewline: boolean;
}

const TERMINATORS: Record<Eol, string> = { lf: "\n", crlf: "\r\n", cr: "\r" };

export function analyzeLineEndings(text: string): EolStats {
  // Count CRLF first, then the CR and LF that are not part of one.
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;

  const counts: Array<[Eol, number]> = [["lf", lf], ["crlf", crlf], ["cr", cr]];
  const present = counts.filter(([, n]) => n > 0);
  const dominant = present.length
    ? present.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
    : null;

  const lines = text.split(/\r\n|\r|\n/);
  return {
    lf,
    crlf,
    cr,
    mixed: present.length > 1,
    dominant,
    trailingWhitespaceLines: lines.filter((line) => /[ \t]+$/.test(line)).length,
    finalNewline: text.length === 0 || /[\r\n]$/.test(text),
  };
}

export function convertLineEndings(text: string, target: Eol): string {
  return text.replace(/\r\n|\r|\n/g, TERMINATORS[target]);
}

export function stripTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+(?=\r?\n|$)/g, "");
}

export function ensureFinalNewline(text: string, target: Eol = "lf"): string {
  if (text.length === 0 || /[\r\n]$/.test(text)) return text;
  return text + TERMINATORS[target];
}
