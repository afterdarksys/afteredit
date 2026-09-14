import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {importJUnit,sourceInProject,type TestCase,type TestReport} from './testReports';
import type {MonitoredRun} from './runMonitor';
import DiagnosticExport from './DiagnosticExport';
export default function TestResultsPanel({run,onSelect}:{run:MonitoredRun;onSelect?:(run:MonitoredRun,test:TestCase,debug:boolean)=>void}){
 const [imported,setImported]=useState<TestReport>(),[error,setError]=useState('');
 const report=imported??run.report;
 return <details open={!!report}><summary>Test explorer</summary>
 {!report&&<p>Configure testReporter: node or go for live cases, or import a JUnit report.</p>}
 <label>Import JUnit XML<input type="file" accept=".xml" onChange={async e=>{try{const file=e.target.files?.[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('Report exceeds 2 MiB');setImported(importJUnit(await file.text()));setError('');}catch(e){setError(String(e));}}}/></label>
 {report&&<><p>{imported?'Imported report · ':''}{report.complete?'Report complete':'Report incomplete / running'} · {report.cases.filter(t=>!t.suite&&t.status==='passed').length} passed · {report.cases.filter(t=>!t.suite&&t.status==='failed').length} failed · {report.cases.filter(t=>!t.suite&&['skipped','todo'].includes(t.status)).length} skipped / todo</p>{report.error&&<p>{report.error}</p>}
 {report.cases.map(test=>{const path=test.file&&sourceInProject(run.root,run.cwd,test.file);return <details key={test.id}><summary>{test.fullName} · {test.suite?'suite · ':''}{test.status}{test.durationMs!==undefined?` · ${test.durationMs.toFixed(1)}ms`:''}</summary>{path&&<button onClick={()=>void invoke('read_file',{path}).then(()=>window.dispatchEvent(new CustomEvent('afteredit:open-test-source',{detail:{path,line:test.line??1}}))).catch(e=>setError(String(e)))}>{test.file}:{test.line??1}</button>}<pre>{test.message}</pre>{(test.expected!==undefined||test.actual!==undefined)&&<><h4>Expected</h4><pre>{test.expected??'Not reported'}</pre><h4>Actual</h4><pre>{test.actual??'Not reported'}</pre></>}<pre>{test.stack}</pre>{test.status==='failed'&&!test.suite&&!imported&&onSelect&&<><button disabled={run.status==='running'} onClick={()=>onSelect(run,test,false)}>Review test rerun</button><button disabled={run.status==='running'} onClick={()=>onSelect(run,test,true)}>Review test debug launch</button></>}</details>;})}</>}
 <p role="alert">{error}</p><DiagnosticExport sections={{run:{command:run.command,args:run.args,cwd:run.cwd,status:run.status,code:run.code},tests:report,output:run.output}}/>
 </details>;
}
