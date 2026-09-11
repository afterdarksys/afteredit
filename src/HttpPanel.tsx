import { useMemo, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseHttpFile, resolveRequest, redactHeader, type HttpRequest } from './httpFile';

type HttpResponse = {
  status: number; status_text: string; headers: Array<[string, string]>;
  body: string; elapsed_ms: number; bytes: number; truncated: boolean;
  content_type: string | null;
};

function prettyIfJson(body: string, contentType: string | null): string {
  if (!contentType?.includes('json')) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body; // Malformed JSON is worth seeing exactly as it arrived.
  }
}

/** Run the requests in the open `.http` buffer. */
export default function HttpPanel({
  fileName,
  buffer,
  onOpenLine,
}: {
  fileName: string;
  buffer: string;
  onOpenLine: (line: number) => void;
}) {
  const parsed = useMemo(() => parseHttpFile(buffer), [buffer]);
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(request: HttpRequest) {
    const { resolved, missing } = resolveRequest(request, parsed.variables);
    if (missing.length) {
      setStatus(`Undefined variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
      return;
    }
    setBusy(true);
    setStatus(`${resolved.method} ${resolved.url}`);
    try {
      setResponse(await invoke<HttpResponse>('http_send', { request: resolved }));
      setStatus('');
    } catch (e) {
      setResponse(null);
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  const isHttpFile = /\.(http|rest)$/i.test(fileName);

  return (
    <section className="http-panel" aria-label="HTTP requests">
      <h2>HTTP</h2>
      {!isHttpFile && (
        <p className="http-hint">
          Open a <code>.http</code> or <code>.rest</code> file. Requests are separated
          by <code>###</code>, and <code>@name = value</code> defines a variable.
        </p>
      )}

      {parsed.problems.length > 0 && (
        <ul className="http-problems">
          {parsed.problems.map(problem => <li key={problem}>{problem}</li>)}
        </ul>
      )}

      <ul className="http-requests">
        {parsed.requests.map(request => (
          <li key={`${request.line}-${request.name}`}>
            <button type="button" className="http-run" disabled={busy || !isTauri()} onClick={() => void run(request)}>
              <span className={`http-method http-${request.method.toLowerCase()}`}>{request.method}</span>
              <span className="http-name">{request.name}</span>
            </button>
            <button type="button" className="http-jump" onClick={() => onOpenLine(request.line)}>:{request.line}</button>
          </li>
        ))}
      </ul>

      {Object.keys(parsed.variables).length > 0 && (
        <details className="http-variables">
          <summary>{Object.keys(parsed.variables).length} variables</summary>
          {Object.entries(parsed.variables).map(([name, value]) => (
            <div key={name}><code>{name}</code> = {redactHeader(name, value)}</div>
          ))}
        </details>
      )}

      <p role="status">{busy ? 'Sending…' : status}</p>

      {response && (
        <div className="http-response">
          <div className="http-status-row">
            <span className={response.status < 400 ? 'http-ok' : 'http-bad'}>
              {response.status} {response.status_text}
            </span>
            <span>{response.elapsed_ms} ms</span>
            <span>{response.bytes} bytes{response.truncated ? ' (truncated)' : ''}</span>
          </div>
          <details>
            <summary>{response.headers.length} response headers</summary>
            {response.headers.map(([name, value]) => (
              // Set-Cookie is a credential; show that it exists, not its value.
              <div key={name}><code>{name}</code>: {redactHeader(name, value)}</div>
            ))}
          </details>
          <pre className="http-body">{prettyIfJson(response.body, response.content_type)}</pre>
        </div>
      )}
    </section>
  );
}
