export type PlanStep = {id:string;text:string;done:boolean;evidence?:string};
export type Finding = {path:string;line:number;summary:string};
const stepId = /^[a-z][a-z0-9-]{0,40}$/;
const worktreeId = /^[a-z][a-z0-9-]{0,40}$/;

function step(id:string,text:string):PlanStep{
 if(!stepId.test(id)||!text||text.length>240)throw new Error('Each plan step needs a short id and text');
 return {id,text,done:false};
}
export function parsePlanSteps(input:unknown):PlanStep[]{
 if(!Array.isArray(input)||input.length<1||input.length>12)throw new Error('A plan needs 1 to 12 steps');
 const steps=input.map(item=>{
  if(!item||typeof item!=='object')throw new Error('Each plan step needs a short id and text');
  const row=item as {id?:unknown;text?:unknown};
  if(typeof row.id!=='string'||typeof row.text!=='string')throw new Error('Each plan step needs a short id and text');
  return step(row.id,row.text.trim());
 });
 if(new Set(steps.map(item=>item.id)).size!==steps.length)throw new Error('Plan step ids must be unique');
 return steps;
}
export function planFromLines(text:string):PlanStep[]{
 const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
 return parsePlanSteps(lines.map(line=>{
  const cut=line.indexOf(':');
  if(cut<1)throw new Error('Each plan step is id: text');
  return {id:line.slice(0,cut).trim(),text:line.slice(cut+1).trim()};
 }));
}
export function formatPlan(steps:Array<{id:string;text:string}>):string{return steps.map(item=>`${item.id}: ${item.text}`).join('\n');}
export function applyPlanEvidence(steps:PlanStep[],id:string,evidence:string):PlanStep[]{
 const text=evidence.trim();
 if(!text||text.length>500)throw new Error('Plan evidence must be a short note from this run');
 if(!steps.some(item=>item.id===id))throw new Error('That plan step is not in this run');
 return steps.map(item=>item.id===id?{...item,done:true,evidence:text}:item);
}
export function unfinished(steps:PlanStep[]):string[]{return steps.filter(item=>!item.done).map(item=>item.id);}
export function parseFindings(input:unknown):Finding[]{
 if(!Array.isArray(input)||input.length<1||input.length>20)throw new Error('A review needs 1 to 20 findings');
 return input.map(item=>{
  if(!item||typeof item!=='object')throw new Error('Each finding needs a path, line, and summary');
  const row=item as {path?:unknown;line?:unknown;summary?:unknown};
  if(typeof row.path!=='string'||typeof row.summary!=='string'||!Number.isInteger(row.line)||(row.line as number)<1)throw new Error('Each finding needs a path, line, and summary');
  const summary=row.summary.trim();
  if(!summary||summary.length>300)throw new Error('Each finding needs a short summary');
  return {path:projectPath(row.path),line:row.line as number,summary};
 });
}
export function localPage(url:string):string{
 if(url.length>2000||url.includes('@')||url.includes('\\')||/\s|[\u0000-\u001f]/.test(url)||!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::[1-9][0-9]{0,4})?(?:\/.*)?$/.test(url))throw new Error('Capture only http://127.0.0.1, http://localhost, or http://[::1]');
 const port=url.match(/:(\d+)/);
 if(port&&Number(port[1])>65535)throw new Error('Capture only http://127.0.0.1, http://localhost, or http://[::1]');
 return url;
}
function projectPath(path:string):string{
 const normalized=path.replace(/\\/g,'/');
 if(!normalized||normalized.startsWith('/')||normalized.includes(':')||normalized.includes('\0')||normalized.split('/').some(part=>part==='..'||part===''))throw new Error('Agent paths must be relative files inside this project');
 return normalized;
}
export function worktreeName(name:string):string{
 if(!worktreeId.test(name))throw new Error('Worktree name must be a short lowercase identifier');
 return name;
}
