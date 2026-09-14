export type TestCase = { id: string; name: string; fullName: string; file?: string; line?: number; suite?: boolean; status: 'running'|'passed'|'failed'|'skipped'|'todo'; durationMs?: number; message?: string; expected?: string; actual?: string; stack?: string };
export type TestReport = { cases: TestCase[]; complete: boolean; error?: string };
const bounded = (v: unknown) => typeof v === 'string' ? v.slice(0, 8000) : undefined;
export function createTestParser(format?: 'node'|'go') {
  let pending = '', dropping = false;
  let report: TestReport = { cases: [], complete: false };
  const cases = new Map<string, TestCase>();
  let retainedBytes=0;
  const packages = new Set<string>(), finished = new Set<string>();
  const upsert = (item: TestCase) => {
    if (!cases.has(item.id) && cases.size >= 5000) { report.error = 'Report exceeds 5,000 cases'; return; }
    const next={ ...cases.get(item.id), ...Object.fromEntries(Object.entries(item).filter(([,v]) => v !== undefined)) } as TestCase;
    const size=JSON.stringify(next).length,previous=cases.has(item.id)?JSON.stringify(cases.get(item.id)).length:0;
    if(retainedBytes+size-previous>2*1024*1024){report.error='Report exceeds 2 MiB';return;}
    retainedBytes+=size-previous;cases.set(item.id,next);
  };
  function line(text: string) {
    if (!format || !text.trim()) return;
    let d: any;
    try { d = JSON.parse(text); } catch { report.error = 'Unrecognized or incomplete structured test output'; return; }
    if(!d||typeof d!=='object'||Array.isArray(d)){report.error='Invalid reporter record';return;}
    if (format === 'node') {
      if (d.afteredit !== 1) { report.error = 'Unexpected Node reporter record'; return; }
      if (d.kind === 'complete') { report.complete = true; return; }
      if (d.kind !== 'test') return;
      report.complete = false;
      if (typeof d.name !== 'string' || !['running','passed','failed','skipped','todo'].includes(d.status)) { report.error = 'Invalid test record'; return; }
      const file = bounded(d.file), name = bounded(d.name)!, fullName = bounded(d.fullName) ?? name;
      // File + location + name survives final suite events and parallel file execution.
      const id = JSON.stringify([file, d.line, name, d.nesting]);
      upsert({ id, name, fullName, file, line: Number.isInteger(d.line) && d.line > 0 ? d.line : undefined, suite: d.suite === true, status: d.status,
        durationMs: typeof d.durationMs === 'number' && d.durationMs >= 0 ? d.durationMs : undefined,
        message: bounded(d.message), expected: bounded(d.expected), actual: bounded(d.actual), stack: bounded(d.stack) });
    } else {
      if (typeof d.Package !== 'string' || typeof d.Action !== 'string') { report.error = 'Invalid Go test event'; return; }
      packages.add(d.Package);
      if (!d.Test) { if (['pass','fail','skip'].includes(d.Action)) finished.add(d.Package); report.complete = packages.size > 0 && packages.size === finished.size; return; }
      const id = JSON.stringify([d.Package, d.Test]);
      const status = ({run:'running',pass:'passed',fail:'failed',skip:'skipped'} as const)[d.Action as 'run'];
      if (status) upsert({id,name:String(d.Test),fullName:`${d.Package} > ${d.Test}`,status,durationMs:typeof d.Elapsed==='number'?d.Elapsed*1000:undefined});
      if (d.Action==='output' && cases.has(id)) { const item=cases.get(id)!; upsert({...item,message:((item.message??'')+String(d.Output??'')).slice(-8000)}); }
    }
  }
  return {
    push(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!dropping) pending += part;
        if (pending.length > 65536) { report.error = 'Test reporter line exceeds 64 KiB'; dropping = true; pending = ''; }
        if (part.endsWith('\n')) { if (!dropping) line(pending.trimEnd()); pending=''; dropping=false; }
      }
      report = {...report, cases:[...cases.values()]};
      return report;
    },
    finish() { if (pending.trim() || dropping) report.error='Incomplete test reporter line'; return {...report,cases:[...cases.values()],complete:report.complete&&!report.error&&!pending.trim()&&!dropping&&!([...cases.values()].some(c=>c.status==='running'))}; },
  };
}
export function importJUnit(xml: string): TestReport {
  if (xml.length > 2*1024*1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Report exceeds 2 MiB or contains unsupported XML declarations');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || !['testsuites','testsuite'].includes(doc.documentElement.tagName)) throw new Error('Invalid JUnit report');
  const nodes=[...doc.querySelectorAll('testcase')];
  if (nodes.length > 5000) throw new Error('Report exceeds 5,000 cases');
  return {complete:true,cases:nodes.map((node,i)=>{
    const failure=node.querySelector('failure,error'), skipped=node.querySelector('skipped');
    const name=node.getAttribute('name')??`Test ${i+1}`, file=node.getAttribute('file')??undefined, line=Number(node.getAttribute('line'));
    return {id:String(i),name,fullName:[node.getAttribute('classname'),name].filter(Boolean).join(' > '),file,line:line>0?line:undefined,status:failure?'failed':skipped?'skipped':'passed',durationMs:Math.max(0,Number(node.getAttribute('time'))||0)*1000,message:bounded(failure?.textContent),stack:bounded(failure?.getAttribute('message'))};
  })};
}
export function sourceInProject(root: string, cwd: string, file: string): string | undefined {
  const slash = (p: string) => p.replace(/\\/g,'/');
  root=slash(root).replace(/\/$/,''); file=slash(file); cwd=slash(cwd);
  if (!root || /\0|^[a-z]+:\/\//i.test(file)) return;
  const absolute=/^(\/|[a-z]:\/)/i.test(file) ? file : `${root}/${cwd}/${file}`;
  const parts: string[]=[];
  for (const part of absolute.split('/')) {if(part==='..')parts.pop();else if(part!=='.'&&part!=='')parts.push(part);}
  const normalized=(absolute.startsWith('/')?'/':'')+parts.join('/');
  return normalized.startsWith(root+'/')?normalized:undefined;
}
