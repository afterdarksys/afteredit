import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presets } from './workflows.ts';
import { unixBuild, unixDiagnostics, unixDebug, unixPath, unixShapes, clangdDraft, compileCommandsDir, manRequest, pkgRequest } from './unixDevelopment.ts';

test('CMake plans export a compilation database and the workflow preset does too', () => {
  const plan = unixBuild('cmake', { source: '.', action: 'build' });
  assert.ok(plan.tasks[0].args.includes('-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'));
  assert.deepEqual(plan.tasks[1].args, ['--build', 'build']);
  assert.equal(plan.tasks[0].cwd, '.');
  assert.equal(plan.tasks[0].network, undefined);
  const tested = unixBuild('cmake', { source: 'src', build: 'out', action: 'test' });
  assert.equal(tested.tasks[2].command, 'ctest');
  assert.deepEqual(tested.tasks[2].args, ['--test-dir', 'out', '--output-on-failure']);
  assert.ok(presets['C / C++ / CMake'].configure.args.includes('-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'));
});

test('Make targets must be names read from the makefile', () => {
  assert.deepEqual(unixBuild('make', { source: 'sub', action: 'build', targets: ['all', 'install'], target: 'install' }).tasks[0].args, ['-C', 'sub', 'install']);
  assert.throws(() => unixBuild('make', { source: '.', action: 'build', targets: ['all'], target: 'install' }), /makefile/);
  assert.throws(() => unixBuild('make', { source: '.', action: 'build', targets: ['-print', 'all'], target: '-print' }), /makefile/);
  assert.throws(() => unixBuild('make', { source: '.', action: 'build', targets: [], target: 'all' }), /makefile/);
  assert.equal(unixPath('.'), '.');
  assert.throws(() => unixPath('a/../b'), /relative/);
});

test('Autotools and kernel plans do not launch configure, menuconfig, or ARCH', () => {
  const autotools = unixBuild('autotools', { source: 'src', action: 'build' });
  assert.deepEqual(autotools.tasks, []);
  assert.equal(JSON.stringify(autotools.tasks).includes('./configure'), false);
  assert.match(autotools.note ?? '', /configure/);
  const kernel = unixBuild('kernel', { source: '.', action: 'build', targets: ['all', 'menuconfig'], target: 'all' });
  assert.deepEqual(kernel.tasks[0].args, ['-C', '.', 'all']);
  assert.equal(JSON.stringify(kernel.tasks).includes('menuconfig'), false);
  assert.equal(JSON.stringify(kernel.tasks).includes('ARCH='), false);
  assert.equal(kernel.tasks[0].env, undefined);
  assert.throws(() => unixBuild('kernel', { source: '.', action: 'build', targets: ['menuconfig'], target: 'menuconfig' }), /menuconfig/);
  const shapes = unixShapes({ cmake: [], makefiles: [{ path: 'Makefile', targets: ['all', 'menuconfig'] }], meson: [], autotools: [], kernel: ['.'], compileCommands: [] });
  assert.deepEqual(shapes.find(shape => shape.kind === 'kernel')?.targets, ['all']);
});

test('Unix diagnostics keep project paths and name their source', () => {
  const result = unixDiagnostics('/repo/My File.c:3:7: error: Broken\n/repo/Test.c:9: warning: Soft\n/outside/a.c:1:1: error: Wrong\n../etc/passwd:1:1: error: No\n', '/repo');
  assert.equal(result.length, 2);
  assert.equal(result[0].source, 'Unix');
  assert.equal(result[0].column, 7);
  assert.equal(result[0].path, '/repo/My File.c');
  assert.equal(result[1].column, 1);
});

test('clangd and LLDB are drafts, not running sessions', () => {
  assert.deepEqual(clangdDraft('build/compile_commands.json').args, ['--compile-commands-dir=build', '--background-index']);
  assert.deepEqual(clangdDraft().args, ['--background-index']);
  assert.equal(compileCommandsDir('compile_commands.json'), '.');
  const config = unixDebug('/repo', 'build/program');
  assert.equal(config.adapter.command, 'lldb-dap');
  assert.deepEqual(config.adapter.args, []);
  assert.equal(config.request, 'launch');
  assert.equal(config.configuration.program, '/repo/build/program');
  assert.equal(config.configuration.cwd, '/repo');
  assert.equal(config.configuration.stopOnEntry, true);
});

test('manual and pkg-config names reject escapes', () => {
  assert.deepEqual(manRequest('printf', '3'), { page: 'printf', section: '3' });
  assert.equal(manRequest('printf', '').section, '');
  assert.throws(() => manRequest('../etc/passwd', ''), /manual/);
  assert.throws(() => manRequest('a..b', '3'), /manual/);
  assert.throws(() => manRequest('printf', '0'), /section/);
  assert.throws(() => manRequest('printf', '10'), /section/);
  assert.equal(pkgRequest('libcurl'), 'libcurl');
  assert.throws(() => pkgRequest('../lib'), /pkg-config/);
  assert.throws(() => pkgRequest('lib:curl'), /pkg-config/);
});

test('Meson setup runs in the source directory', () => {
  const plan = unixBuild('meson', { source: 'lib', build: 'build', action: 'test' });
  assert.equal(plan.tasks[0].cwd, 'lib');
  assert.deepEqual(plan.tasks[0].args, ['setup', 'build']);
  assert.deepEqual(plan.tasks[1].args, ['compile', '-C', 'build']);
  assert.equal(plan.tasks[2].command, 'meson');
  assert.throws(() => unixBuild('meson', { source: 'lib', build: '../build', action: 'build' }), /relative/);
});


test('Make plans use the selected makefile even when another makefile has priority', () => {
  const shapes = unixShapes({ cmake: [], makefiles: [{ path: 'sub/BSDmakefile', targets: ['all'] }, { path: 'sub/GNUmakefile', targets: ['other'] }], meson: [], autotools: [], kernel: [], compileCommands: [] });
  const shape = shapes[0];
  const plan = unixBuild('make', { source: shape.source, makefile: shape.makefile, targets: shape.targets, target: 'all', action: 'build' });
  assert.deepEqual(plan.tasks[0].args, ['-C', 'sub', '-f', 'BSDmakefile', 'all']);
  assert.throws(() => unixBuild('make', { source: '.', makefile: '../other', targets: ['all'], target: 'all', action: 'build' }), /makefile/);
});
