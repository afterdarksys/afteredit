import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { InfrastructureDiagnostic } from './infrastructure';
import { policyDiagnostics, summarize, type PolicyReport, type PolicySources } from './policy';

/**
 * Runs the repository's own Rego against a plan or manifest and turns each
 * violation into a marker on the resource that caused it -- the CI failure,
 * before the push.
 */
export default function PolicySection({
  root,
  onDiagnostics,
  onOpen,
}: {
  root: string;
  onDiagnostics: (rows: InfrastructureDiagnostic[]) => void;
  onOpen: (path: string, line: number) => void;
}) {
  const [sources, setSources] = useState<PolicySources | null>(null);
  const [policies, setPolicies] = useState('');
  const [input, setInput] = useState('');
  const [report, setReport] = useState<PolicyReport | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSources(null); setReport(null); setStatus(''); setPolicies(''); setInput('');
    if (!root || !isTauri()) return;
    let stale = false;
    void invoke<PolicySources>('policy_discover', { root })
      .then(found => {
        if (stale) return;
        setSources(found);
        setPolicies(found.policy_dirs[0] ?? '');
        setInput(found.inputs[0] ?? '');
      })
      .catch(e => { if (!stale) setStatus(String(e)); });
    return () => { stale = true; };
  }, [root]);

  async function evaluate() {
    setBusy(true); setStatus('Evaluating…');
    try {
      const result = await invoke<PolicyReport>('policy_evaluate', { root, policies, input });
      setReport(result);
      onDiagnostics(policyDiagnostics(result.findings));
      setStatus(summarize(result));
    } catch (e) {
      setReport(null);
      onDiagnostics([]);
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  const relative = (path: string) => (root && path.startsWith(root) ? path.slice(root.length + 1) : path);

  return (
    <details className="policy-section" open>
      <summary>Policy (OPA / Rego)</summary>

      {sources && !sources.opa && (
        <p role="status" className="policy-missing">
          OPA is not installed. <code>brew install opa</code> to evaluate policies here.
        </p>
      )}
      {sources && !sources.policy_dirs.length && (
        <p role="status">No .rego files found under this project.</p>
      )}

      <label>Policies
        <select value={policies} onChange={e => setPolicies(e.target.value)} disabled={busy}>
          {(sources?.policy_dirs ?? []).map(dir => <option key={dir} value={dir}>{relative(dir)}</option>)}
        </select>
      </label>

      <label>Input
        <select value={input} onChange={e => setInput(e.target.value)} disabled={busy}>
          {(sources?.inputs ?? []).map(file => <option key={file} value={file}>{relative(file)}</option>)}
        </select>
      </label>
      {sources && !sources.inputs.length && (
        <p className="policy-hint">
          No plan or manifest found. Generate one with{' '}
          <code>terraform show -json tfplan &gt; plan.json</code>.
        </p>
      )}

      <div className="field-row">
        <button type="button" disabled={busy || !policies || !input || !sources?.opa} onClick={() => void evaluate()}>
          {busy ? 'Evaluating…' : 'Evaluate policies'}
        </button>
        <button type="button" disabled={busy || !report} onClick={() => { setReport(null); onDiagnostics([]); setStatus(''); }}>
          Clear
        </button>
      </div>

      <p role="status">{status}</p>

      {report && report.findings.length > 0 && (
        <ul className="policy-findings">
          {report.findings.map((finding, index) => (
            <li key={`${finding.rule}-${index}`} className={`policy-${finding.severity}`}>
              <span className="policy-rule">{finding.rule}</span>
              <span className="policy-message">{finding.message}</span>
              {finding.path && finding.line ? (
                <button type="button" className="policy-jump" onClick={() => onOpen(finding.path!, finding.line!)}>
                  {relative(finding.path)}:{finding.line}
                </button>
              ) : (
                <span className="policy-nowhere">no source line</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
