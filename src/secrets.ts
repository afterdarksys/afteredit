import type { SecretFinding } from './policy';

/** Locations only — findings never carry the matched value. */
export function secretRefusal(findings: SecretFinding[], what: string): string {
  const head = findings.slice(0, 5).map(finding => `${finding.file}:${finding.start_line} ${finding.description}`).join('; ');
  const more = findings.length > 5 ? `; +${findings.length - 5} more` : '';
  return `Blocked: ${findings.length} possible secret${findings.length === 1 ? '' : 's'} in ${what}. ${head}${more}`;
}

/** Replace secret-bearing lines. The matched text is never copied into the replacement. */
export function redactSecretLines(text: string, findings: SecretFinding[]): string {
  if (!findings.length) return text;
  const rules = new Map<number, string>();
  for (const finding of findings) rules.set(finding.start_line, finding.rule);
  const redacted = text.split('\n').map((line, index) => rules.has(index + 1) ? `"<redacted: ${rules.get(index + 1)}>"` : line).join('\n');
  try {
    JSON.parse(redacted);
    return redacted;
  } catch {
    return JSON.stringify({ format: 'afteredit-diagnostics-v1', redacted: true, text: redacted }, null, 2);
  }
}
