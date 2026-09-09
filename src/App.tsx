import { useEffect } from "react";
import {
  Code, Terminal, GitBranch, LayoutPanelLeft, Search, Bug, Files, ChevronRight, Zap, Settings, Wrench,
} from "lucide-react";
import Editor from "@monaco-editor/react";
import TerminalPanel, { type OsTheme } from "./TerminalPanel";
import { usePersistedState } from "./usePersistedState";
import { languageForFilename } from "./languages";
import { SAMPLE_FILES } from "./sampleFiles";
import ToolsPanel from "./ToolsPanel";
import "./App.css";

type Layout = "stacked" | "side-by-side";
type Panel = "explorer" | "search" | "git" | "debug";

const LLM_ENGINES = ["Claude Opus 5", "Claude Sonnet 5", "Claude Haiku 4.5"] as const;

function App() {
  // Session state: where you left off.
  const [activeFile, setActiveFile] = usePersistedState<string>("ui.activeFile", "main.tf");
  const [activePanel, setActivePanel] = usePersistedState<Panel>("ui.activePanel", "explorer");
  const [showCommandPalette, setShowCommandPalette] = usePersistedState<boolean>("ui.palette", false);

  // Preferences: mirrored to localStorage so they survive a restart.
  const [layout, setLayout] = usePersistedState<Layout>("pref.layout", "side-by-side");
  const [osTheme, setOsTheme] = usePersistedState<OsTheme>("pref.osTheme", "mac");
  const [pairProgrammingOn, setPairProgrammingOn] = usePersistedState<boolean>("pref.pairProgramming", true);
  const [llmEngine, setLlmEngine] = usePersistedState<string>("pref.llmEngine", LLM_ENGINES[2]);

  const [buffers, setBuffers] = usePersistedState<Record<string, string>>("buffers", SAMPLE_FILES);

  const fileNames = Object.keys(buffers);
  // A persisted activeFile can name a buffer that no longer exists.
  const currentFile =
    activeFile === "Settings" || activeFile === "Tools" || fileNames.includes(activeFile)
      ? activeFile
      : (fileNames[0] ?? "Settings");

  // The buffer the Tools panel reads and writes: the last real file opened.
  const toolTarget = fileNames.includes(activeFile) ? activeFile : (fileNames[0] ?? "");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
      } else if (e.key === "Escape") {
        setShowCommandPalette(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setShowCommandPalette]);

  // Theming only. This used to share an effect with terminal construction,
  // which meant every theme change rebuilt the terminal. Also uses classList
  // rather than assigning className, which clobbered anything else on <body>.
  useEffect(() => {
    document.body.classList.toggle("theme-mac", osTheme === "mac");
    document.body.classList.toggle("theme-win", osTheme === "win");
  }, [osTheme]);

  const renderEditorContent = () => {
    if (currentFile === "Tools") {
      return (
        <ToolsPanel
          fileName={toolTarget}
          buffer={buffers[toolTarget] ?? ""}
          onApplyToBuffer={(next) => setBuffers({ ...buffers, [toolTarget]: next })}
        />
      );
    }

    if (currentFile === "Settings") {
      return (
        <div className="preferences-ui">
          <div className="pref-header">Settings</div>
          <input className="pref-search" placeholder="Search settings (e.g. 'font size', 'theme')..." />

          <div className="pref-section">
            <h3>App (UI)</h3>
            <div className="pref-row">
              <div>
                <div className="pref-label">Color Theme</div>
                <div className="pref-desc">Specifies the OS Look and Feel theme.</div>
              </div>
              <select
                className="pref-select"
                value={osTheme}
                onChange={(e) => setOsTheme(e.target.value as OsTheme)}
              >
                <option value="mac">macOS Translucent</option>
                <option value="win">Windows / Linux Solid</option>
              </select>
            </div>
            <div className="pref-row">
              <div>
                <div className="pref-label">Layout Architecture</div>
                <div className="pref-desc">Control where the terminal and editor panels split.</div>
              </div>
              <select
                className="pref-select"
                value={layout}
                onChange={(e) => setLayout(e.target.value as Layout)}
              >
                <option value="side-by-side">Side-by-Side (Vertical Split)</option>
                <option value="stacked">Stacked (Horizontal Split)</option>
              </select>
            </div>
          </div>

          <div className="pref-section">
            <h3>AI &amp; Developer Tools</h3>
            <div className="pref-row">
              <div>
                <div className="pref-label">Code With Me: LLM Engine</div>
                <div className="pref-desc">Model to use for real-time pair programming ghost comments.</div>
              </div>
              <select
                className="pref-select"
                value={llmEngine}
                onChange={(e) => setLlmEngine(e.target.value)}
              >
                {LLM_ENGINES.map((engine) => (
                  <option key={engine} value={engine}>{engine}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      );
    }

    return (
      <Editor
        height="100%"
        theme="vs-dark"
        path={currentFile}
        language={languageForFilename(currentFile)}
        value={buffers[currentFile] ?? ""}
        onChange={(v) => setBuffers({ ...buffers, [currentFile]: v ?? "" })}
      />
    );
  };

  return (
    <div className="app-container">
      {showCommandPalette && (
        <div className="command-palette-overlay" onClick={() => setShowCommandPalette(false)}>
          <div className="command-palette" onClick={(e) => e.stopPropagation()}>
            <input className="cp-input" placeholder="Type a command..." autoFocus />
            <div className="cp-list">
              <div className="cp-item" onClick={() => { setActiveFile("Settings"); setShowCommandPalette(false); }}>
                <span>Preferences: Open Settings (UI)</span> <span className="cp-shortcut">⌘,</span>
              </div>
              <div className="cp-item" onClick={() => { setShowCommandPalette(false); }}>
                <span>Preferences: Open Settings (JSON)</span>
              </div>
              <div className="cp-item" onClick={() => { setShowCommandPalette(false); }}>
                <span>Preferences: Open Keyboard Shortcuts</span> <span className="cp-shortcut">⌘K ⌘S</span>
              </div>
              <div className="cp-item" onClick={() => { setActiveFile("Tools"); setShowCommandPalette(false); }}>
                <span>Developer: Open Tools (regex, base64, subnet, timestamps)</span>
              </div>
              <div className="cp-item" onClick={() => { setPairProgrammingOn(!pairProgrammingOn); setShowCommandPalette(false); }}>
                <span>AI: Toggle Code With Me (Pair Programming)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div data-tauri-drag-region className="titlebar">
        <div className="window-controls">
          {osTheme === "mac" && (<><div className="mac-btn close"></div><div className="mac-btn min"></div><div className="mac-btn max"></div></>)}
        </div>
        <span>AfterEdit IDE</span>
        <div className="theme-toggles">
          <button onClick={() => setOsTheme("mac")} className={osTheme === "mac" ? "active" : ""}>Mac</button>
          <button onClick={() => setOsTheme("win")} className={osTheme === "win" ? "active" : ""}>Win/Lin</button>
        </div>
      </div>

      <div className="main-content">
        <div className="activity-bar">
          <Files className={`activity-icon ${activePanel === "explorer" ? "active" : ""}`} onClick={() => setActivePanel("explorer")} />
          <Search className={`activity-icon ${activePanel === "search" ? "active" : ""}`} onClick={() => setActivePanel("search")} />
          <GitBranch className={`activity-icon ${activePanel === "git" ? "active" : ""}`} onClick={() => setActivePanel("git")} />
          <Bug className={`activity-icon ${activePanel === "debug" ? "active" : ""}`} onClick={() => setActivePanel("debug")} />

          <Wrench
            className={`activity-icon ${currentFile === "Tools" ? "active" : ""}`}
            onClick={() => setActiveFile("Tools")}
          />

          <div className="activity-bottom">
            <Settings className="activity-icon" onClick={() => setActiveFile("Settings")} />
          </div>
        </div>

        <div className="sidebar">
          <div className="sidebar-header">
            {activePanel.toUpperCase()}
            <LayoutPanelLeft size={14} style={{ cursor: "pointer" }} onClick={() => setLayout(layout === "stacked" ? "side-by-side" : "stacked")} />
          </div>
          <div className="sidebar-content">
            {activePanel === "explorer" && (
              <div className="file-tree">
                {fileNames.map((name) => (
                  <div
                    key={name}
                    className={`file-item ${currentFile === name ? "active" : ""}`}
                    onClick={() => setActiveFile(name)}
                  >
                    <Code /> {name}
                  </div>
                ))}
                <div
                  className={`file-item ${currentFile === "Tools" ? "active" : ""}`}
                  onClick={() => setActiveFile("Tools")}
                >
                  <Wrench /> Tools
                </div>
                <div
                  className={`file-item ${currentFile === "Settings" ? "active" : ""}`}
                  onClick={() => setActiveFile("Settings")}
                >
                  <Settings /> Settings
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={`center-area layout-${layout}`}>
          <div className="editor-area">
            <div className="editor-tabs">
              <div className="editor-tab active">{currentFile}</div>
            </div>
            <div className="breadcrumbs">
              afteredit <ChevronRight size={12} style={{ margin: "0 4px" }} /> src <ChevronRight size={12} style={{ margin: "0 4px" }} /> <span style={{ color: "#dcdcaa" }}>{currentFile}</span>
            </div>

            <div className="editor-container">
              {renderEditorContent()}
            </div>
          </div>

          <div className="terminal-panel">
            <div className="terminal-header"><Terminal size={12} style={{ marginRight: "5px" }} /> PTY Session</div>
            <TerminalPanel theme={osTheme} />
          </div>
        </div>
      </div>

      <div className="status-bar">
        <div className="status-left">
          <div className="status-item"><GitBranch size={12} /> main</div>
          <div className="status-item">0 errors, 0 warnings</div>
        </div>
        <div className="status-right">
          <div className="status-item" onClick={() => setPairProgrammingOn(!pairProgrammingOn)} style={{ color: pairProgrammingOn ? "#00FF7F" : "#ccc" }}>
            <Zap size={12} /> {pairProgrammingOn ? "Code With Me: Active" : "Code With Me: Paused"}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
