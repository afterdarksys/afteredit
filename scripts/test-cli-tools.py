#!/usr/bin/env python3
"""Optional macOS integration: real clangd and LLDB through the shared CLI service."""
import json, pathlib, shutil, subprocess, tempfile, time, sys
binary = pathlib.Path(__file__).resolve().parents[1] / 'src-tauri/target/debug/afteredit-cli'
fixture = pathlib.Path(tempfile.mkdtemp(prefix='ae-tools-', dir='/tmp')).resolve()
socket = fixture / 'session.sock'
server = None

def cli(*args):
    r = subprocess.run([str(binary), '--connect', str(socket), '--json', *args], capture_output=True, text=True, timeout=90)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)

def rpc(method, params={}): return cli('rpc', method, json.dumps(params))

try:
    clangd = subprocess.check_output(['xcrun', '--find', 'clangd'], text=True).strip()
    adapter = subprocess.check_output(['xcrun', '--find', 'lldb-dap'], text=True).strip()
    source = fixture / 'main.c'
    source.write_text('int main(void) {\n  volatile int value = 7;\n  value += 1;\n  return value;\n}\n')
    subprocess.run(['xcrun', 'clang', '-g', '-O0', str(source), '-o', str(fixture / 'program')], check=True)
    config = {'languageServers': {'c': {'command': clangd, 'args': []}}, 'debug': {'native': {'adapter': {'command': adapter, 'args': []}, 'request': 'launch', 'configuration': {'program': str(fixture / 'program'), 'cwd': str(fixture), 'stopOnEntry': True}}}}
    (fixture / '.afteredit.json').write_text(json.dumps(config))
    server = subprocess.Popen([str(binary), '--server', '--workspace', str(fixture), '--socket', str(socket)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for _ in range(100):
        if socket.exists():
            try: cli("status"); break
            except AssertionError: pass
        if server.poll() is not None: raise AssertionError(server.communicate()[1].decode())
        time.sleep(.05)
    cli('buffer', 'open', 'main.c')
    language = cli('language', 'c', '--approve'); assert 'capabilities' in language
    uri = source.resolve().as_uri()
    symbols = rpc('language.request', {'method': 'textDocument/documentSymbol', 'params': {'textDocument': {'uri': uri}}})
    assert symbols and symbols[0]['name'] == 'main', symbols
    started = cli('debug', 'start', 'native', '--approve'); assert 'capabilities' in started
    for _ in range(100):
        events = rpc('events')
        if any(e.get('event', {}).get('debug', {}).get('message', {}).get('event') == 'stopped' for e in events): break
        time.sleep(.05)
    threads = cli('debug', 'threads')['threads']; assert threads
    thread = threads[0]['id']
    frames = rpc('debug.request', {'command': 'stackTrace', 'arguments': {'threadId': thread}})['stackFrames']; assert frames
    points = rpc('debug.request', {'command': 'setBreakpoints', 'arguments': {'source': {'path': str(source)}, 'breakpoints': [{'line': 3}]}})
    assert points['breakpoints'][0]['verified'], points
    after = rpc('events')[-1]['sequence']
    rpc('debug.request', {'command': 'continue', 'arguments': {'threadId': thread}})
    for _ in range(100):
        events = rpc('events', {'after': after})
        stopped = [e['event']['debug']['message'] for e in events if e.get('event', {}).get('debug', {}).get('message', {}).get('event') == 'stopped']
        if stopped:
            thread = stopped[-1]['body']['threadId']; break
        time.sleep(.05)
    else: raise AssertionError(f'No breakpoint stop: {events}')
    frames = rpc('debug.request', {'command': 'stackTrace', 'arguments': {'threadId': thread}})['stackFrames']
    scopes = rpc('debug.request', {'command': 'scopes', 'arguments': {'frameId': frames[0]['id']}})['scopes']
    variables = rpc('debug.request', {'command': 'variables', 'arguments': {'variablesReference': scopes[0]['variablesReference']}})['variables']
    assert any(v['name'] == 'value' and v['value'] == '7' for v in variables), variables
    cli('debug', 'stop'); cli('stop'); server.wait(timeout=5)
    print('PASS: real clangd symbols and LLDB launch, breakpoint, threads, stack, scopes and variables through CLI service')
finally:
    if server and server.poll() is None:
        try: cli('stop', '--force'); server.wait(timeout=5)
        except Exception: server.kill(); server.wait()
    if server and sys.exc_info()[0] is not None:
        print(server.communicate()[1].decode(), file=sys.stderr)
    shutil.rmtree(fixture)
