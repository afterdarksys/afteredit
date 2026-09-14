import { infrastructureTasks } from './infrastructure.ts';
import { debugConfig, type DebugConfig } from './debugging.ts';
import type { ServerConfig } from './languageServices.ts';
import { editorDefaults, validateEditor, type EditorPreferences } from './preferences.ts';
export type Task = { command: string; args: string[]; cwd?: string; env?: Record<string, string>; dependsOn?: string[]; timeoutSeconds?: number; testReporter?: "node"|"go"; debugConfiguration?: string };
export type Rule = { event: 'save' | 'manual'; pattern: string; tasks: string[]; exclude?: string[]; enabled?: boolean };
export type ProjectConfig = { editor: EditorPreferences; debug: Record<string,DebugConfig>; tasks: Record<string, Task>; rules: Rule[]; languageServers: Record<string,ServerConfig>; workflows: Record<string,string[]>; instructions: string };
export const defaults: ProjectConfig = { editor: editorDefaults, debug: {}, tasks: {}, rules: [], languageServers: {}, workflows: {}, instructions: '' };
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(x => typeof x === 'string'); }
export function resolveConfig(layers: unknown[]): ProjectConfig {
  const result: ProjectConfig = { ...defaults, editor: { ...defaults.editor }, debug: {}, tasks: {}, languageServers: {}, workflows: {} };
  for (const layer of layers) {
    if (!record(layer)) throw new Error('Configuration must be an object');
    if (layer.editor !== undefined) {
      result.editor = { ...result.editor, ...validateEditor(layer.editor) };
    }
    if(layer.debug!==undefined){if(!record(layer.debug))throw new Error('debug must be an object');for(const [name,value] of Object.entries(layer.debug)){if(['__proto__','constructor','prototype'].includes(name))throw new Error('Invalid debug configuration name');result.debug[name]=debugConfig(value);}}
    if (layer.tasks !== undefined) {
      if (!record(layer.tasks)) throw new Error('tasks must be an object');
      for (const [id, task] of Object.entries(layer.tasks)) {
        if (['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid task name');
        if (!record(task) || typeof task.command !== 'string' || !task.command.trim() || !strings(task.args)) throw new Error(`Task ${id} needs command and args`);
        if (task.cwd !== undefined && typeof task.cwd !== 'string') throw new Error(`Invalid cwd in ${id}`);
        if (task.dependsOn !== undefined && !strings(task.dependsOn)) throw new Error(`Invalid dependencies in ${id}`);
        if (task.env !== undefined && (!record(task.env) || !Object.values(task.env).every(v => typeof v === 'string'))) throw new Error(`Invalid environment in ${id}`);
        if(task.timeoutSeconds!==undefined && (!Number.isInteger(task.timeoutSeconds)||Number(task.timeoutSeconds)<1||Number(task.timeoutSeconds)>3600)) throw new Error(`Invalid timeout in ${id}`);
        if(task.testReporter!==undefined && !['node','go'].includes(String(task.testReporter))) throw new Error(`Invalid test reporter in ${id}`);
        if(task.debugConfiguration!==undefined && typeof task.debugConfiguration!=='string') throw new Error(`Invalid debug configuration in ${id}`);
        result.tasks[id] = task as Task;
      }
    }
    if (layer.rules !== undefined) {
      if (!Array.isArray(layer.rules) || !layer.rules.every(r => record(r) && ['save', 'manual'].includes(String(r.event)) && typeof r.pattern === 'string' && strings(r.tasks))) throw new Error('Invalid rules');
      for(const r of layer.rules as Rule[]) {if(r.exclude!==undefined&&!strings(r.exclude))throw new Error('Rule excludes must be globs');if(r.enabled!==undefined&&typeof r.enabled!=='boolean')throw new Error('Rule enabled must be boolean');}
      result.rules = layer.rules as Rule[];
    }
    if(layer.languageServers!==undefined){if(!record(layer.languageServers))throw new Error('languageServers must be an object');for(const [language,server]of Object.entries(layer.languageServers)){if(!/^[a-z][a-z0-9_-]*$/.test(language)||!record(server)||typeof server.command!=='string'||!strings(server.args)||(server.documentLanguage!==undefined&&typeof server.documentLanguage!=='string')|| (server.env!==undefined&&(!record(server.env)||!Object.values(server.env).every(v=>typeof v==='string'))))throw new Error('Invalid language server');result.languageServers[language]=server as ServerConfig;}}
    if(layer.workflows!==undefined){if(!record(layer.workflows))throw new Error('workflows must be an object');for(const [name,ids] of Object.entries(layer.workflows)){if(['__proto__','constructor','prototype'].includes(name)||!strings(ids))throw new Error('Invalid named workflow');result.workflows[name]=ids;}}
    if (layer.instructions !== undefined) {
      if (typeof layer.instructions !== 'string') throw new Error('instructions must be text');
      result.instructions = layer.instructions;
    }
  }
  for (const id of Object.keys(result.tasks)) taskOrder(result.tasks, [id]);
  for (const rule of result.rules) taskOrder(result.tasks, rule.tasks);
  for(const ids of Object.values(result.workflows)) taskOrder(result.tasks,ids);
  return result;
}
export function taskOrder(tasks: Record<string, Task>, ids: string[]): string[] {
  const done = new Set<string>(), visiting = new Set<string>(), order: string[] = [];
  function visit(id: string) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (!Object.prototype.hasOwnProperty.call(tasks, id)) throw new Error(`Unknown task: ${id}`);
    visiting.add(id);
    for (const dep of tasks[id].dependsOn ?? []) visit(dep);
    visiting.delete(id); done.add(id); order.push(id);
  }
  ids.forEach(visit); return order;
}
export function matches(pattern: string, path: string): boolean {
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; } else expression += '.*';
    } else if (c === '*') expression += '[^/]*';
    else if (c === '?') expression += '[^/]';
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(path);
}
export const presets: Record<string, Record<string, Task>> = {
  ...infrastructureTasks,
  'Swift Package':{build:{command:'/usr/bin/xcrun',args:['swift','build']},test:{command:'/usr/bin/xcrun',args:['swift','test']}},
  'Rust / Cargo': { build: { command: 'cargo', args: ['build'] }, test: { command: 'cargo', args: ['test'] } },
  'Node structured tests': {test:{command:'node',args:['--test'],testReporter:'node'}},
  'Go structured tests': {test:{command:'go',args:['test','-json','./...'],testReporter:'go'}},
  Go: { build: { command: 'go', args: ['build', './...'] }, test: { command: 'go', args: ['test', './...'] } },
  'C / C++ / CMake': { configure: { command: 'cmake', args: ['-S', '.', '-B', 'build'] }, build: { command: 'cmake', args: ['--build', 'build'], dependsOn: ['configure'] }, test: { command: 'ctest', args: ['--test-dir', 'build'], dependsOn: ['build'] } },
  Make: { build: { command: 'make', args: [] }, test: { command: 'make', args: ['test'] } },
  'Java / Maven': { build: { command: 'mvn', args: ['package', '-DskipTests'] }, test: { command: 'mvn', args: ['test'] } },
  'Java / Groovy / Gradle': { build: { command: 'gradle', args: ['build'] }, test: { command: 'gradle', args: ['test'] } },
  'Node / HTML / CSS (npm)': { build: { command: 'npm', args: ['run', 'build'] }, test: { command: 'npm', args: ['test'] } },
  pnpm: { build: { command: 'pnpm', args: ['build'] }, test: { command: 'pnpm', args: ['test'] } },
  Yarn: { build: { command: 'yarn', args: ['build'] }, test: { command: 'yarn', args: ['test'] } },
  Bun: { build: { command: 'bun', args: ['run', 'build'] }, test: { command: 'bun', args: ['test'] } },
  'PHP / Composer': { install: { command: 'composer', args: ['install'] }, test: { command: 'composer', args: ['run-script', 'test'] } },
  Python: { build: { command: 'python3', args: ['-m', 'build'] }, test: { command: 'python3', args: ['-m', 'pytest'] } },
  'Python / uv': { build: { command: 'uv', args: ['build'] }, test: { command: 'uv', args: ['run', 'pytest'] } },
  Perl: { configure: { command: 'perl', args: ['Makefile.PL'] }, build: { command: 'make', args: [], dependsOn: ['configure'] }, test: { command: 'prove', args: ['-lr', 't'] } },
  Bash: { check: { command: 'bash', args: ['-n', 'build.sh'] }, build: { command: 'bash', args: ['build.sh'], dependsOn: ['check'] } },
};

export function matchingRules(config:ProjectConfig,event:Rule['event'],path:string):Rule[]{
 return config.rules.filter(r=>r.enabled!==false&&r.event===event&&matches(r.pattern,path)&&!(r.exclude??[]).some(pattern=>matches(pattern,path)));
}
export function expandTask(task:Task,context:{project:string;file:string}):Task {
 const values:Record<string,string>={project:context.project,file:context.file,relativeFile:context.file.slice(context.project.length+1),fileDir:context.file.replace(/[\\/][^\\/]+$/,'')};
 const expand=(text:string)=>text.replace(/\$\{([^}]+)\}/g,(_,key:string)=>{
  if(!Object.prototype.hasOwnProperty.call(values,key))throw new Error(`Unknown task variable: ${key}`);
  if(key!=='project'&&!context.file)throw new Error(`Task variable ${key} needs an active file`);
  return values[key];
 });
 return {...task,command:expand(task.command),args:task.args.map(expand),cwd:expand(task.cwd??'.'),env:task.env?Object.fromEntries(Object.entries(task.env).map(([key,value])=>[key,expand(value)])):undefined};
}
