import type { Task } from './workflows.ts';
import type { InfrastructureDiagnostic } from './infrastructure.ts';
import type { DebugConfig } from './debugging.ts';
import type { ServerConfig } from './languageServices.ts';

export type UnixKind = 'cmake' | 'make' | 'meson' | 'autotools' | 'kernel';
export type UnixMakefile = { path: string; targets: string[] };
export type UnixProject = {
  cmake: string[];
  makefiles: UnixMakefile[];
  meson: string[];
  autotools: string[];
  kernel: string[];
  compileCommands: string[];
};
export type UnixShape = { id: string; kind: UnixKind; label: string; source: string; targets: string[]; makefile?: string };
export type UnixBuildOptions = {
  source: string;
  build?: string;
  target?: string;
  targets?: string[];
  makefile?: string;
  action: 'build' | 'test';
};

const INTERACTIVE_KERNEL = new Set(['menuconfig', 'nconfig', 'gconfig', 'xconfig']);
export const autotoolsNote = 'configure is a project script. Reviewed tasks start installed tools such as make, not ./configure. Run ./configure in the terminal, then prepare a make target.';
export const kernelNote = 'This page does not set ARCH or CROSS_COMPILE and does not run menuconfig. Cross settings belong in a command you review. Kernel-shaped means a Makefile, Kconfig, and an arch directory. It is not a claim that the tree is Linux.';

/** `.` is the opened project. Longer paths stay inside it and cannot climb out. */
export function unixPath(path: string): string {
  if (path === '.') return path;
  if (!path || path.startsWith('/') || path.startsWith('-') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\0\r\n]/.test(path)) {
    throw new Error('Use a relative path inside the project.');
  }
  return path;
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '.' : file.slice(0, slash);
}

export function unixShapes(project: UnixProject): UnixShape[] {
  const shapes: UnixShape[] = [];
  for (const dir of project.cmake) shapes.push({ id: 'cmake:' + dir, kind: 'cmake', label: 'CMake · ' + dir, source: dir, targets: [] });
  for (const file of project.makefiles) shapes.push({ id: 'make:' + file.path, kind: 'make', label: 'Make · ' + file.path, source: directoryOf(file.path), targets: file.targets, makefile: file.path.split('/').pop() });
  for (const dir of project.meson) shapes.push({ id: 'meson:' + dir, kind: 'meson', label: 'Meson · ' + dir, source: dir, targets: [] });
  for (const dir of project.autotools) shapes.push({ id: 'autotools:' + dir, kind: 'autotools', label: 'Autotools · ' + dir, source: dir, targets: [] });
  for (const dir of project.kernel) {
    const makefile = project.makefiles.find(file => directoryOf(file.path) === dir && file.path.endsWith('Makefile') && !file.path.endsWith('GNUmakefile'));
    const targets = (makefile?.targets ?? []).filter(target => !INTERACTIVE_KERNEL.has(target));
    shapes.push({ id: 'kernel:' + dir, kind: 'kernel', label: 'Kernel-shaped · ' + dir, source: dir, targets });
  }
  return shapes;
}

function makeTask(source: string, target: string | undefined, targets: string[] | undefined, makefile?: string): Task {
  const dir = unixPath(source);
  if (!target || target.startsWith('-') || /\s/.test(target) || /[\0\r\n]/.test(target) || !targets?.includes(target)) {
    throw new Error('Choose a make target read from the makefile.');
  }
  if (makefile && !['Makefile', 'GNUmakefile', 'BSDmakefile'].includes(makefile)) throw new Error('Choose a discovered makefile.');
  return { command: 'make', args: ['-C', dir, ...(makefile ? ['-f', makefile] : []), target], cwd: '.', timeoutSeconds: 1800 };
}

export function unixBuild(kind: UnixKind, options: UnixBuildOptions): { tasks: Task[]; note?: string } {
  if (kind === 'autotools') {
    unixPath(options.source);
    return { tasks: [], note: autotoolsNote };
  }
  if (kind === 'make' || kind === 'kernel') {
    if (kind === 'kernel' && options.target && INTERACTIVE_KERNEL.has(options.target)) {
      throw new Error('This page does not run menuconfig. Choose a build target read from the makefile.');
    }
    const task = makeTask(options.source, options.target, options.targets, options.makefile);
    return kind === 'kernel' ? { tasks: [task], note: kernelNote } : { tasks: [task] };
  }
  const source = unixPath(options.source);
  const build = unixPath(options.build || 'build');
  if (kind === 'cmake') {
    const tasks: Task[] = [
      { command: 'cmake', args: ['-S', source, '-B', build, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'], cwd: '.', timeoutSeconds: 1800 },
      { command: 'cmake', args: ['--build', build], cwd: '.', timeoutSeconds: 1800 },
    ];
    if (options.action === 'test') tasks.push({ command: 'ctest', args: ['--test-dir', build, '--output-on-failure'], cwd: '.', timeoutSeconds: 1800 });
    return { tasks };
  }
  if (kind === 'meson') {
    const tasks: Task[] = [
      { command: 'meson', args: ['setup', build], cwd: source, timeoutSeconds: 1800 },
      { command: 'meson', args: ['compile', '-C', build], cwd: source, timeoutSeconds: 1800 },
    ];
    if (options.action === 'test') tasks.push({ command: 'meson', args: ['test', '-C', build], cwd: source, timeoutSeconds: 1800 });
    return { tasks };
  }
  throw new Error('Choose a project shape.');
}

export function unixDiagnostics(text: string, root: string, cwd = '.'): InfrastructureDiagnostic[] {
  const diagnostics: InfrastructureDiagnostic[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^(.+?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.+)$/);
    if (!match) continue;
    let path = match[1];
    if (path.split('/').includes('..')) continue;
    if (!path.startsWith('/')) path = root + '/' + (cwd === '.' ? '' : cwd.replace(/\/$/, '') + '/') + path;
    if (!path.startsWith(root.replace(/\/$/, '') + '/')) continue;
    diagnostics.push({ path, line: Number(match[2]), column: Number(match[3] ?? 1), message: match[5], severity: match[4] === 'note' ? 'info' : match[4] as 'error' | 'warning', source: 'Unix' });
  }
  return diagnostics;
}

export function compileCommandsDir(path: string): string {
  const clean = unixPath(path);
  if (clean !== 'compile_commands.json' && !clean.endsWith('/compile_commands.json')) throw new Error('Choose a compile_commands.json file.');
  return clean.slice(0, -'compile_commands.json'.length).replace(/\/$/, '') || '.';
}

export function clangdDraft(compileCommands?: string): ServerConfig {
  return { command: 'clangd', args: compileCommands ? ['--compile-commands-dir=' + compileCommandsDir(compileCommands), '--background-index'] : ['--background-index'] };
}

const pageName = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,63}$/;
export function manRequest(page: string, section: string): { page: string; section: string } {
  const name = page.trim();
  const chosen = section.trim();
  if (!pageName.test(name) || name.includes('..')) throw new Error('Choose a manual page name.');
  if (chosen !== '' && !/^[1-9]$/.test(chosen)) throw new Error('Choose a manual section from 1 to 9, or leave it empty.');
  return { page: name, section: chosen };
}

export function pkgRequest(name: string): string {
  const value = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(value) || value.includes('..') || value.includes(':') || value.includes('@')) {
    throw new Error('Choose one pkg-config package name.');
  }
  return value;
}

export function unixDebug(root: string, relativeBinary: string): DebugConfig {
  const relative = unixPath(relativeBinary);
  return { adapter: { command: 'lldb-dap', args: [] }, request: 'launch', configuration: { program: root + '/' + relative, cwd: root, stopOnEntry: true } };
}
