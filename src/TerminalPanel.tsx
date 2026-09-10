import { useAccessibility } from './AccessibilityContext';
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm, type ITheme } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

export type OsTheme = "mac" | "win";

const THEMES: Record<OsTheme, ITheme> = {
  mac: { background: "rgba(30,30,30,0.8)", foreground: "#cccccc", cursor: "#ffffff" },
  win: { background: "#1e1e1e", foreground: "#cccccc", cursor: "#ffffff" },
};

/** Give layout this many frames to produce a non-zero size before giving up
 *  and letting the shell start at xterm's 80x24 default. */
const MAX_LAYOUT_FRAMES = 60;

/** PTY output arrives base64-encoded because a read can land mid-UTF-8-sequence.
 *  xterm reassembles the byte stream itself when handed a Uint8Array. */
function decodeChunk(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export default function TerminalPanel({ theme }: { theme: OsTheme }) {
  const accessibility = useAccessibility();
  const accessRef = useRef(accessibility); accessRef.current = accessibility;
  const [transcript,setTranscript] = useState<string | null>(null);
  const [terminalStatus,setTerminalStatus] = useState('');
  const transcriptRef = useRef<HTMLTextAreaElement>(null);
  function reviewOutput() {
    const term=termRef.current;
    if(!term) return;
    const buffer=term.buffer.active;
    const rows:string[]=[];
    for(let i=Math.max(0,buffer.length-1000);i<buffer.length;i++) rows.push(buffer.getLine(i)?.translateToString(true)??'');
    setTranscript(rows.join('\n').slice(-200000));
    setTerminalStatus('Terminal snapshot refreshed. Up to 1,000 recent lines; output will stay still until refreshed.');
    requestAnimationFrame(()=>transcriptRef.current?.focus());
  }
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Built exactly once. Theme and layout changes must not tear this down:
  // recreating the terminal would drop scrollback and re-run the PTY handshake.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: !accessRef.current.reducedMotion,
      screenReaderMode: accessRef.current.screenReader === "on",
      scrollback: 10000,
      theme: THEMES[themeRef.current],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    let disposed = false;
    let listeners: UnlistenFn[] = [];
    let observer: ResizeObserver | undefined;
    let frame = 0;

    // fit() resizes the terminal, which drives xterm's *async* render loop --
    // and that loop throws if the renderer has not finished attaching or the
    // host is still 0x0. Both are normal on the frame after open() for a flex
    // child, and a try/catch here would not help because the throw happens
    // later, off our stack. So don't fit until it is genuinely safe.
    const canFit = () =>
      !disposed && !!term.element?.isConnected && host.clientWidth > 0 && host.clientHeight > 0;

    const refit = () => {
      if (!canFit()) return false;
      try {
        fit.fit();
        return true;
      } catch {
        return false;
      }
    };

    const scheduleRefit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!refit()) return;
        void invoke("pty_resize", { rows: term.rows, cols: term.cols }).catch(() => {
          /* no session yet; the post-spawn fit sets the real size */
        });
      });
    };

    const connect = async () => {
      try {
        const [onOutput, onExit] = await Promise.all([
          listen<string>("pty:output", (event) => term.write(decodeChunk(event.payload))),
          listen<number>("pty:exit", (event) => {
            setTerminalStatus(`Shell exited with code ${event.payload}`);
            term.writeln(`\r\n\x1b[90m[shell exited with code ${event.payload}]\x1b[0m`);
          }),
        ]);
        // The effect may have been cleaned up while these were in flight.
        if (disposed) {
          onOutput();
          onExit();
          return;
        }
        listeners = [onOutput, onExit];

        const started = await invoke<boolean>("spawn_pty", { rows: term.rows, cols: term.cols });
        if (!started && !disposed) {
          term.writeln("\x1b[90m[reattached to the running shell - press Enter to redraw]\x1b[0m");
        }
      } catch (error) {
        if (!disposed) {
          setTerminalStatus(`Could not start shell: ${String(error)}`);
          term.writeln(`\r\n\x1b[31m[could not start shell: ${String(error)}]\x1b[0m`);
        }
      }
    };

    // Wait for layout, fit once at the real size so the shell's first prompt is
    // drawn correctly, and only then start watching for resizes and spawn.
    let attempts = 0;
    const startWhenLaidOut = () => {
      if (disposed) return;
      if (!refit() && attempts < MAX_LAYOUT_FRAMES) {
        attempts += 1;
        frame = requestAnimationFrame(startWhenLaidOut);
        return;
      }
      observer = new ResizeObserver(scheduleRefit);
      observer.observe(host);
      void connect();
    };
    frame = requestAnimationFrame(startWhenLaidOut);

    const input = term.onData((data) => {
      void invoke("pty_write", { data }).catch((error) => {
        term.writeln(`\r\n\x1b[31m[write failed: ${String(error)}]\x1b[0m`);
      });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      input.dispose();
      listeners.forEach((unlisten) => unlisten());
      // The original cleared the container with innerHTML = '' and left the
      // renderer, its observers and its document listeners alive.
      term.dispose();
      termRef.current = null;
      // The PTY itself is deliberately left running: it is app-scoped and gets
      // killed on RunEvent::Exit, so a remount reattaches instead of forking.
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // Same async-render hazard as fit(): defer a frame so the renderer exists.
    const id = requestAnimationFrame(() => {
      term.options.theme = accessibility.contrast === 'dark'
        ? {background:'#000000',foreground:'#ffffff',cursor:'#ffffff'}
        : accessibility.contrast === 'light' ? {background:'#ffffff',foreground:'#000000',cursor:'#000000'}
        : THEMES[theme];
      term.options.screenReaderMode = accessibility.screenReader === 'on';
      term.options.cursorBlink = !accessibility.reducedMotion;
      term.options.cursorStyle = accessibility.largeCursor ? 'block' : 'bar';
      term.options.cursorWidth = accessibility.largeCursor ? 4 : 2;
    });
    return () => cancelAnimationFrame(id);
  }, [theme, accessibility.contrast, accessibility.screenReader, accessibility.reducedMotion, accessibility.largeCursor]);

  return <>
    <div className="terminal-review-controls"><button onClick={()=>termRef.current?.focus()}>Focus shell input</button><button onClick={reviewOutput}>Review recent output</button></div>
    <div className="terminal-container" ref={hostRef} />
    {transcript!==null&&<div className="terminal-transcript"><label>Terminal output snapshot<textarea ref={transcriptRef} readOnly value={transcript} rows={6}/></label><button onClick={reviewOutput}>Refresh snapshot</button><button onClick={()=>{const node=transcriptRef.current;if(node){node.focus();node.setSelectionRange(node.value.length,node.value.length);node.scrollTop=node.scrollHeight;}}}>Go to end</button><button onClick={()=>{setTranscript(null);termRef.current?.focus();}}>Close snapshot and return to shell</button></div>}
    <span role="status">{terminalStatus}</span>
  </>;
}
