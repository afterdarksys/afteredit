#!/usr/bin/env python3
"""Real headless clients, IPC, recovery, plain mode and pseudo-terminal smoke tests."""
import json, os, pathlib, pty, select, socket as unix_socket, subprocess, tempfile, time, shutil, sys
BINARY = pathlib.Path(__file__).resolve().parents[1] / 'src-tauri/target/debug/afteredit-cli'
if not BINARY.exists():
    raise SystemExit('Build first: npm run cli:build')
fixture = pathlib.Path(tempfile.mkdtemp(prefix='ae-cli-', dir='/tmp'))
workspace = fixture / 'workspace'; workspace.mkdir()
socket = fixture / 'session.sock'
(workspace / 'note.txt').write_text('original\n')
(workspace / '.afteredit.json').write_text(json.dumps({'tasks': {'test': {'command': '/bin/echo', 'args': ['test passed']}, 'slow': {'command': '/bin/sleep', 'args': ['30']}}}))
server = None

def start():
    global server
    server = subprocess.Popen([str(BINARY), '--server', '--workspace', str(workspace), '--socket', str(socket)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for _ in range(100):
        if socket.exists():
            try: cli('status'); return
            except (AssertionError, OSError): pass
        if server.poll() is not None: raise AssertionError(server.communicate()[1].decode())
        time.sleep(.05)
    raise AssertionError('Server did not start')

def cli(*args, ok=True, input=None):
    result = subprocess.run([str(BINARY), '--connect', str(socket), '--json', *args], input=input, text=True, capture_output=True, timeout=75)
    if not ok:
        assert result.returncode != 0, result.stdout
        return result.stderr
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

def rpc(method, params={}): return cli('rpc', method, json.dumps(params))

try:
    start()
    assert socket.stat().st_mode & 0o777 == 0o600
    assert rpc('capabilities')['protocol'] == 1
    # Accepted sockets must be blocking on macOS, even though the listener is not.
    with unix_socket.socket(unix_socket.AF_UNIX) as connection:
        connection.settimeout(5); connection.connect(str(socket))
        connection.sendall(b'{"method":"capabi'); time.sleep(.1)
        connection.sendall(b'lities","params":{}}\n')
        assert json.loads(connection.makefile().readline())['ok']
    assert cli('buffer', 'open', 'note.txt')['version'] == 1
    cli('buffer', 'set', 'note.txt', '--revision', '1', '--text', 'shared\n')
    assert cli('buffer', 'get', 'note.txt')['text'] == 'shared\n'
    assert 'Version conflict' in cli('buffer', 'set', 'note.txt', '--revision', '1', '--text', 'stale', ok=False)
    assert 'Unsaved' in cli('stop', ok=False)
    cli('stop', '--force'); server.wait(timeout=5); start()
    assert cli('buffer', 'get', 'note.txt')['version'] == 2
    cli('buffer', 'save', 'note.txt', '--revision', '2')
    assert (workspace / 'note.txt').read_text() == 'shared\n'
    (workspace / 'note.txt').write_text('external\n')
    cli('buffer', 'set', 'note.txt', '--revision', '3', '--text', 'draft\n')
    assert 'changed' in cli('buffer', 'save', 'note.txt', '--revision', '4', ok=False).lower()
    (workspace / 'note.txt').write_text('shared\n')
    cli('buffer', 'save', 'note.txt', '--revision', '4')
    run = cli('run', 'test', '--approve')
    for _ in range(100):
        records = cli('runs')
        if records[-1]['status'] != 'running': break
        time.sleep(.03)
    assert records[-1]['code'] == 0 and 'test passed' in records[-1]['output'], records
    run = cli('run', 'slow', '--approve'); cli('cancel', str(run['id']))
    for _ in range(100):
        records = cli('runs')
        if records[-1]['status'] != 'running': break
        time.sleep(.03)
    assert records[-1]['status'] == 'cancelled', records
    plain = subprocess.run([str(BINARY), '--connect', str(socket), 'note.txt', '--plain'], input='show\nreplace 1 accessible\nsave\nquit\n', text=True, capture_output=True, timeout=10)
    assert plain.returncode == 0 and '\x1b' not in plain.stdout, plain
    assert '1: draft' in plain.stdout
    assert (workspace / 'note.txt').read_text() == 'accessible\n'
    wait = subprocess.Popen([str(BINARY), '--connect', str(socket), 'edit', 'note.txt', '--wait'], stdout=subprocess.PIPE)
    time.sleep(.2)
    b = cli('buffer', 'get', 'note.txt'); cli('buffer', 'save', 'note.txt', '--revision', str(b['version']))
    assert wait.wait(timeout=5) == 0
    pid, master = pty.fork()
    if pid == 0:
        os.execv(str(BINARY), [str(BINARY), '--connect', str(socket), 'note.txt', '--tui'])
    output = b''; deadline = time.time() + 10
    while b'Ctrl-S Save' not in output and time.time() < deadline:
        ready, _, _ = select.select([master], [], [], .1)
        if ready: output += os.read(master, 65536)
    assert b'Ctrl-S Save' in output, output
    os.write(master, b'visual \x13\x11')
    deadline = time.time() + 10
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done: assert os.waitstatus_to_exitcode(status) == 0; break
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            try: output += os.read(master, 65536)
            except OSError: pass
    else: os.kill(pid, 9); raise AssertionError('TUI failed to exit')
    os.close(master)
    assert (workspace / 'note.txt').read_text() == 'visual accessible\n'
    rpc('buffer.create', {'path': 'new.txt'})
    assert (workspace / 'new.txt').exists()
    literal = cli('buffer', 'set', 'new.txt', '--revision', '1', '--text', '--server')
    assert literal['text'] == '--server'
    cli('buffer', 'save', 'new.txt', '--revision', str(literal['version']))
    cli('stop'); server.wait(timeout=5)
    # GUI service_start uses this same automatic service startup path.
    auto = subprocess.run([str(BINARY), '--workspace', str(workspace), '--socket', str(socket), 'status', '--json'], capture_output=True, text=True, timeout=10)
    assert auto.returncode == 0, auto.stderr
    assert json.loads(auto.stdout)['root'] == str(workspace.resolve())
    cli('stop')
    for _ in range(100):
        if not socket.exists(): break
        time.sleep(.02)
    assert not socket.exists(), 'Automatic service did not stop'
    print('PASS: private IPC, version conflicts, recovery, disk conflict, task execution/cancellation, plain editing, --wait, visual PTY editing, file creation, delayed IPC frames and automatic service startup')
finally:
    if server and server.poll() is None:
        server.kill(); server.wait()
    shutil.rmtree(fixture)
