import type { InfrastructureDiagnostic } from './infrastructure';

export type PolicyFinding = {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  resource: string | null;
  path: string | null;
  line: number | null;
  column: number | null;
};

export type PolicyReport = {
  findings: PolicyFinding[];
  engine: string;
  policies: string;
  input: string;
  unlocated: number;
};

export type PolicySources = {
  policy_dirs: string[];
  inputs: string[];
  opa: string | null;
};

/**
 * Findings that resolved to a source line become editor markers. The rest are
 * still worth showing in the panel -- a policy about a whole cluster has no
 * line to point at -- they just cannot be squiggles.
 */
export function policyDiagnostics(findings: PolicyFinding[]): InfrastructureDiagnostic[] {
  return findings
    .filter((finding): finding is PolicyFinding & { path: string; line: number } =>
      typeof finding.path === 'string' && typeof finding.line === 'number' && finding.line > 0)
    .map(finding => ({
      path: finding.path,
      line: finding.line,
      column: finding.column && finding.column > 0 ? finding.column : 1,
      message: `${finding.message} (${finding.rule})`,
      severity: finding.severity,
      source: 'policy',
    }));
}

/** One-line summary for the panel header. */
export function summarize(report: PolicyReport): string {
  const errors = report.findings.filter(f => f.severity === 'error').length;
  const warnings = report.findings.filter(f => f.severity === 'warning').length;
  if (!report.findings.length) return 'No policy violations';
  const parts = [];
  if (errors) parts.push(`${errors} violation${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  const rest = report.findings.length - errors - warnings;
  if (rest) parts.push(`${rest} note${rest === 1 ? '' : 's'}`);
  const tail = report.unlocated ? `, ${report.unlocated} without a source line` : '';
  return parts.join(', ') + tail;
}

/** A possible credential. Carries a location and a rule id -- never the value. */
export type SecretFinding = {
  rule: string;
  description: string;
  file: string;
  start_line: number;
  fingerprint: string | null;
  detector: 'gitleaks' | 'builtin';
};
