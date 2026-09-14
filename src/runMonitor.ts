import {createTestParser, type TestReport} from './testReports';
export type TestSummary = { total: number; passed: number; failed: number; cancelled: number; skipped: number; todo: number };
export type MonitoredRun = {
  id: number; root: string; cwd: string; command: string; args: string[];
  startedAt: number; durationMs?: number; status: 'running' | 'succeeded' | 'failed' | 'error' | 'cancelled' | 'timedOut' | 'spawnError'; code?: number;
  output: string; error?: string; tests?: TestSummary; report?: TestReport; nativeId?: number; sequence?: number; taskName?: string; parentId?: number; reporter?: "node"|"go"; streamGap?:boolean;
};

// Recognize a complete Node TAP footer. Exit status remains the task outcome.
export function nodeTestSummary(output: string): TestSummary | undefined {
  const match = output.replace(/\r\n/g, '\n').match(
    /(?:^|\n)# tests (\d+)\n# suites \d+\n# pass (\d+)\n# fail (\d+)\n# cancelled (\d+)\n# skipped (\d+)\n# todo (\d+)\n# duration_ms [\d.]+\s*$/,
  );
  if (!match) return;
  const [total, passed, failed, cancelled, skipped, todo] = match.slice(1).map(Number);
  if (![total, passed, failed, cancelled, skipped, todo].every(Number.isSafeInteger)
    || total !== passed + failed + cancelled + skipped + todo) return;
  return { total, passed, failed, cancelled, skipped, todo };
}

export function createRunMonitor(limit = 20) {
  let runs: MonitoredRun[] = [];
  let nextId = 0;
  const parsers=new Map<number,ReturnType<typeof createTestParser>>();
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => runs,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start(root: string, cwd: string, command: string, args: string[], metadata: {taskName?:string;parentId?:number;reporter?:"node"|"go"} = {}) {
      const id = ++nextId;
      runs = [{ id, root, cwd, command, args: [...args], startedAt: Date.now(), status: 'running', output: '', ...metadata }, ...runs];
      if(metadata.reporter)parsers.set(id,createTestParser(metadata.reporter));
      publish();
      return id;
    },
    event(id:number,event:{runId:number;sequence:number;kind:string;text:string}) {
      runs=runs.map(run=>{
        if(run.id!==id||run.status!=='running'||event.sequence<=(run.sequence??0))return run;
        const output=['stdout','stderr'].includes(event.kind)?(run.output+event.text).slice(-200000):run.output;
        const report=event.kind==='stdout'?parsers.get(id)?.push(event.text):run.report;
        return {...run,nativeId:event.runId,sequence:event.sequence,output,report,streamGap:run.streamGap||event.sequence!==(run.sequence??0)+1};
      });publish();
    },
    finish(id: number, durationMs: number, result: { code: number; output: string; status?: MonitoredRun['status']; runId?:number; error?:string|null; sequence?:number; outputTruncated?:boolean; stdout?:string; stdoutTruncated?:boolean } | { error: string }) {
      runs = runs.map(run => run.id !== id || run.status !== 'running' ? run : {
        ...run, durationMs: Math.max(0, durationMs),
        ...('code' in result ? {
          status: result.status ?? (result.code === 0 ? 'succeeded' as const : 'failed' as const), nativeId:result.runId??run.nativeId, error:result.error??undefined,
          code: result.code, output: result.output.slice(-200000), tests: nodeTestSummary(result.output), report:(()=>{
            if(!run.reporter)return run.report;
            if(!(result.stdoutTruncated??result.outputTruncated)){const parser=createTestParser(run.reporter);parser.push(result.stdout??result.output);return parser.finish();}
            const report=parsers.get(id)?.finish()??run.report;
            if(report&&(run.streamGap||(result.sequence!==undefined&&(run.sequence??0)<result.sequence-1)))return {...report,complete:false,error:'Some live output was missed and the retained output is truncated'};
            return report;
          })(),
        } : { status: 'error' as const, error: result.error.slice(-10000) }),
      });
      parsers.delete(id);
      let retained = 0;
      runs = runs.filter(run => run.status === 'running' || retained++ < limit);
      publish();
    },
    clear(root: string) {
      runs = runs.filter(run => run.root !== root || run.status === 'running');
      publish();
    },
  };
}

// Session-only: command arguments and output are never automatically persisted.
export const runMonitor = createRunMonitor();
