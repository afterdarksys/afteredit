export type Task = { command: string; args: string[]; cwd?: string; env?: Record<string, string>; dependsOn?: string[] };
export type Rule = { event: 'save' | 'manual'; pattern: string; tasks: string[] };
export type ProjectConfig = { editor: { fontSize: number; tabSize: number; wordWrap: 'on' | 'off' }; tasks: Record<string, Task>; rules: Rule[]; instructions: string };
export const defaults: ProjectConfig = { editor: { fontSize: 14, tabSize: 2, wordWrap: 'off' }, tasks: {}, rules: [], instructions: '' };
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(x => typeof x === 'string'); }
export function resolveConfig(layers: unknown[]): ProjectConfig {
  const result: ProjectConfig = { ...defaults, editor: { ...defaults.editor }, tasks: {} };
  for (const layer of layers) {
    if (!record(layer)) throw new Error('Configuration must be an object');
    if (layer.editor !== undefined) {
      if (!record(layer.editor)) throw new Error('editor must be an object');
      const e = layer.editor;
      if (e.fontSize !== undefined && (typeof e.fontSize !== 'number' || !Number.isFinite(e.fontSize) || e.fontSize < 8 || e.fontSize > 48)) throw new Error('fontSize must be 8–48');
      if (e.tabSize !== undefined && (!Number.isInteger(e.tabSize) || Number(e.tabSize) < 1 || Number(e.tabSize) > 8)) throw new Error('tabSize must be 1–8');
      if (e.wordWrap !== undefined && e.wordWrap !== 'on' && e.wordWrap !== 'off') throw new Error('wordWrap must be on or off');
      result.editor = { ...result.editor, ...e };
    }
    if (layer.tasks !== undefined) {
      if (!record(layer.tasks)) throw new Error('tasks must be an object');
      for (const [id, task] of Object.entries(layer.tasks)) {
        if (['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid task name');
        if (!record(task) || typeof task.command !== 'string' || !task.command.trim() || !strings(task.args)) throw new Error(`Task ${id} needs command and args`);
        if (task.cwd !== undefined && typeof task.cwd !== 'string') throw new Error(`Invalid cwd in ${id}`);
        if (task.dependsOn !== undefined && !strings(task.dependsOn)) throw new Error(`Invalid dependencies in ${id}`);
        if (task.env !== undefined && (!record(task.env) || !Object.values(task.env).every(v => typeof v === 'string'))) throw new Error(`Invalid environment in ${id}`);
        result.tasks[id] = task as Task;
      }
    }
    if (layer.rules !== undefined) {
      if (!Array.isArray(layer.rules) || !layer.rules.every(r => record(r) && ['save', 'manual'].includes(String(r.event)) && typeof r.pattern === 'string' && strings(r.tasks))) throw new Error('Invalid rules');
      result.rules = layer.rules as Rule[];
    }
    if (layer.instructions !== undefined) {
      if (typeof layer.instructions !== 'string') throw new Error('instructions must be text');
      result.instructions = layer.instructions;
    }
  }
  for (const id of Object.keys(result.tasks)) taskOrder(result.tasks, [id]);
  for (const rule of result.rules) taskOrder(result.tasks, rule.tasks);
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
  'Rust / Cargo': { build: { command: 'cargo', args: ['build'] }, test: { command: 'cargo', args: ['test'] } },
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
