const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

export type PendingEdit = { id: string; path: string };

/**
 * Shown while a terminal command is blocked waiting on this tab.
 *
 * The exit code is the whole point: `git commit` proceeds on 0 and aborts on
 * anything else, and `kubectl edit` applies or discards on the same signal.
 * So the two buttons are genuinely different outcomes, not styling.
 */
export default function EditorBridgeBanner({
  pending,
  dirty,
  onFinish,
  onAbort,
}: {
  pending: PendingEdit;
  dirty: boolean;
  onFinish: () => void;
  onAbort: () => void;
}) {
  return (
    <div className="bridge-banner" role="status">
      <span className="bridge-banner-text">
        A terminal command is waiting on <strong>{basename(pending.path)}</strong>
        {dirty ? ' — unsaved changes' : ''}
      </span>
      <button type="button" className="bridge-accept" onClick={onFinish}>
        Save &amp; continue
      </button>
      <button type="button" className="bridge-abort" onClick={onAbort}>
        Abort command
      </button>
    </div>
  );
}
