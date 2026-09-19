const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

export type PendingEdit = { id: string; path: string; outsideWorkspace?: boolean };

/**
 * Shown while a terminal command is blocked waiting on this tab.
 *
 * The exit code is the whole point: `git commit` proceeds on 0 and aborts on
 * anything else, and `kubectl edit` applies or discards on the same signal.
 * So the two buttons are genuinely different outcomes, not styling.
 *
 * Paths outside the project are not granted until the user opens them here.
 */
export default function EditorBridgeBanner({
  pending,
  dirty,
  opened,
  onOpenOutside,
  onFinish,
  onAbort,
}: {
  pending: PendingEdit;
  dirty: boolean;
  opened?: boolean;
  onOpenOutside?: () => void;
  onFinish: () => void;
  onAbort: () => void;
}) {
  const outside = !!pending.outsideWorkspace && !opened;
  return (
    <div className="bridge-banner" role="status">
      <span className="bridge-banner-text">
        {outside
          ? <>A terminal command wants to edit <strong>{basename(pending.path)}</strong>, which is outside the project.</>
          : <>A terminal command is waiting on <strong>{basename(pending.path)}</strong>{dirty ? ' — unsaved changes' : ''}</>}
      </span>
      {outside
        ? <button type="button" className="bridge-accept" onClick={onOpenOutside}>Open this file</button>
        : <button type="button" className="bridge-accept" onClick={onFinish}>Save &amp; continue</button>}
      <button type="button" className="bridge-abort" onClick={onAbort}>
        Abort command
      </button>
    </div>
  );
}
