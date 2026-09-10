# Accessibility in AfterEdit

Open **Settings → Accessibility**, or search **Accessibility settings** in Commands.
These personal settings persist separately from editor/project configuration.

- Whole-app zoom: 100–200%, including menus, editor and terminal.
- Workbench contrast: default, high contrast dark, or high contrast light. Explicit
  contrast also selects the corresponding Monaco theme. System forced colors and
  reduced-motion preferences are respected; motion can also be reduced manually.
- Screen-reader support: Automatic delegates editor detection to Monaco. **On**
  explicitly enables both Monaco and xterm accessibility; Tab leaves the editor
  in this mode. Automatic does not detect a screen reader for the terminal.
- Large cursor: block cursor in the editor and terminal.
- Incoming task/debug output announcements: off by default. Logs remain focusable
  and readable; enabling this can be verbose for rapidly changing output.
- Optional sound cues: off by default, with volume and a test button. Rising tones
  mark successful workflows, descending tones mark failed workflows/app errors,
  and repeated tones mark debugger pauses. Text remains available without audio.

## Keyboard workflow

Use **F6 / Shift+F6** to cycle Workbench navigation → File explorer → Workspace →
Terminal, including from the experimental editor frame. On keyboards that reserve
function keys, use Fn as needed. Tab moves among controls within a region.
A skip link enters the workspace. Commands also exposes direct region focus.

**Cmd/Ctrl+Shift+P** opens Commands. Type to filter, Down enters results, Up/Down
moves among results, Home/End selects the first/last result, and Enter runs the
focused command (or the sole match from the search field). Tab stays within the
modal. Escape closes it and restores focus to the opener.

The standard editor toolbar offers **Go to symbol**, **Report cursor and
indentation**, **Toggle breakpoint at cursor**, and a sequential diagnostic list.
Symbol availability depends on the language provider. Reporting indentation counts
literal spaces and tabs. The experimental editor uses its own built-in commands;
it does not include this toolbar.

**Review recent output** takes a static snapshot of the terminal's active buffer,
limited to 1,000 recent rendered rows / 200,000 characters. Refresh updates it;
Go to end moves to its end; Close returns focus to shell input. This is rendered
terminal text, so full-screen programs and overwritten progress output are not
an append-only command history. Shell exit is announced; arbitrary shell command
completion is not detected.

AI edit proposals show removed text followed by added text, with buttons to jump
to each section. Approval retains the existing review and unsaved-buffer behavior.

## Verification

Run:

```sh
npm test
npm run build
npx playwright install chromium
npm run test:a11y
```

An existing Chromium executable can be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:a11y`.

Automated browser tests exercise keyboard region navigation, modal focus trapping
and restoration, settings persistence, 200% viewport sizing, editor Tab escape, terminal review with an unavailable native backend, and AI
proposal review with a deterministic mock provider.
They do not establish screen-reader or desktop-host compatibility.

Before claiming end-to-end accessibility, test the native app with blind and
low-vision developers using VoiceOver on macOS and NVDA on Windows:

1. Open a folder/file, navigate regions, edit, save, switch files, and hear saved /
   unsaved state without mouse input.
2. Open/close Commands from each region; verify focus containment and restoration.
3. Repeat with the experimental editor, then exit its frame using F6.
4. Use 200% zoom and both contrast themes at small window sizes. Reach every
   setting, diagnostic and terminal control; verify visible focus and cursor.
5. Run a build with verbose output, review its log, and hear its result. Check
   output announcements both off and on.
6. Review terminal output containing Unicode and ANSI styling, refresh the
   snapshot, return to input, and verify shell-exit announcements.
7. Navigate diagnostics and symbols, toggle a breakpoint, and inspect a debugger
   pause and variables.
8. Review and reject/approve an AI edit by keyboard, reading removed and added
   text in order. Confirm pending approval is announced and focus is usable.
9. Enable/test/mute sounds, and verify all outcomes still have text equivalents.

Native VoiceOver/NVDA, braille displays, audio playback and live PTY/AI workflows
require hands-on validation. No WCAG conformance claim is made by this change.
