// Bundled as a data URL by the native runner; no project file is installed.
const text = value => { try { return typeof value === 'string' ? value.slice(0, 8000) : JSON.stringify(value)?.slice(0, 8000); } catch { return String(value).slice(0, 8000); } };
export default async function* reporter(source) {
  const names = [];
  for await (const event of source) {
    const d = event.data ?? {};
    if (['test:start', 'test:pass', 'test:fail'].includes(event.type)) {
      const depth = d.nesting ?? 0;
      names.length = depth;
      names[depth] = d.name;
      const error = d.details?.error?.cause ?? d.details?.error;
      yield JSON.stringify({ afteredit: 1, kind: 'test', name: d.name, fullName: names.join(' > '), file: d.file, line: d.line,
        nesting: depth, suite: d.details?.type === 'suite', status: d.skip ? 'skipped' : d.todo ? 'todo' : event.type === 'test:pass' ? 'passed' : event.type === 'test:fail' ? 'failed' : 'running',
        durationMs: d.details?.duration_ms, message: text(error?.message), expected: text(error?.expected), actual: text(error?.actual), stack: text(error?.stack) }) + '\n';
    } else if (event.type === 'test:summary' && (d.nesting === undefined || d.nesting === 0)) {
      yield JSON.stringify({ afteredit: 1, kind: 'complete' }) + '\n';
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      yield JSON.stringify({ afteredit: 1, kind: 'output', text: text(d.message) }) + '\n';
    }
  }
  yield JSON.stringify({ afteredit: 1, kind: 'complete' }) + '\n';
}
