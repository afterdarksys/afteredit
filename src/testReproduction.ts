import type {Task} from './workflows';
import {debugConfig,expandDebug,type DebugConfig} from './debugging';
import {sourceInProject,type TestCase} from './testReports';
export function selectTest(task:Task,test:TestCase,root:string):Task {
 if(test.suite)throw new Error('Select an individual test case');
 if(task.testReporter==='node') {
  const file=test.file&&sourceInProject(root,task.cwd??'.',test.file);
  if(!file||!task.args.includes('--test'))throw new Error('Node reproduction requires a source file and a direct --test task');
  // Filter the current task rather than replacing its runtime flags or loader.
  const args:string[]=[];
  const flagsWithValue=new Set(['--import','--require','-r','--loader','--experimental-loader','--conditions','-C']);
  for(let i=0;i<task.args.length;i++){
   const arg=task.args[i];
   if(arg.startsWith('--test-name-pattern='))continue;
   if(arg==='--test-name-pattern')throw new Error('Use --test-name-pattern=value syntax in the configured task');
   if(flagsWithValue.has(arg)){if(!task.args[i+1])throw new Error('Missing Node option value');args.push(arg,task.args[++i]);continue;}
   if(arg.startsWith('-'))args.push(arg);
   // Positional test file selectors are replaced by the selected source file.
  }
  const pattern=test.fullName.split(' > ').join(' ').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  args.splice(args.indexOf('--test')+1,0,`--test-name-pattern=^${pattern}$`);
  args.push(file);
  return {...task,args};
 }
 if(task.testReporter==='go'){
  if(task.args[0]!=='test')throw new Error('Go reproduction requires go test');
  if(task.args.some(a=>a==='-run'||a.startsWith('-run=')))throw new Error('Remove the existing Go -run filter before selecting a case');
  const pattern=test.name.split('/').map(n=>'^'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$').join('/');
  return {...task,args:['test',`-run=${pattern}`, '-count=1',...task.args.slice(1)]};
 }
 throw new Error('This runner has no test selector mapping');
}
export function failedTestDebug(task:Task,test:TestCase,configs:Record<string,DebugConfig>,root:string):DebugConfig {
 if(!task.debugConfiguration||!configs[task.debugConfiguration])throw new Error('Set task.debugConfiguration to a named project debug configuration');
 const file=test.file&&sourceInProject(root,task.cwd??'.',test.file);
 if(!file)throw new Error('A project source file is required for test debugging');
 const base=configs[task.debugConfiguration];
 if(base.request!=='launch')throw new Error('Failed-test reproduction requires a launch configuration');
 const selected=selectTest(task,test,root);
 const replace=(value:unknown):any=>{
  if(value==='${testArgs}')return selected.args.filter(a=>!a.startsWith('--test-reporter'));
  if(typeof value==='string')return value.split('${testName}').join(test.name).split('${testFile}').join(file);
  if(Array.isArray(value))return value.flatMap(item=>item==='${testArgs}'?replace(item):[replace(item)]);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));
  return value;
 };
 if(!JSON.stringify(base.configuration).includes('${test'))throw new Error('Debug configuration needs ${testArgs}, ${testName}, or ${testFile} to select the failing test');
 return debugConfig(expandDebug(replace(base),root,file));
}
