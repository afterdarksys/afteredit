import { useState } from 'react';
import type { Challenge } from './taskRunner';

/**
 * The speed bump. Typing the context name is the point: a button you can hit
 * reflexively is not a confirmation, and the name is on screen so the work is
 * in reading it rather than recalling it.
 */
export default function ProductionConfirm({
  challenge,
  onConfirm,
  onCancel,
}: {
  challenge: Challenge;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === challenge.expected;

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Confirm production command">
      <div className="confirm-box">
        <h2>This targets production</h2>
        <p>
          <code>{challenge.action}</code> will run against <strong>{challenge.expected}</strong>.
        </p>
        <p className="confirm-reason">{challenge.reason}</p>
        <label>
          Type <code>{challenge.expected}</code> to continue
          <input
            autoFocus
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && matches) onConfirm(typed.trim()); if (e.key === 'Escape') onCancel(); }}
            aria-label="Confirmation"
          />
        </label>
        <div className="field-row">
          <button type="button" className="confirm-go" disabled={!matches} onClick={() => onConfirm(typed.trim())}>
            Run it
          </button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
