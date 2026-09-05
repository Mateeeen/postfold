/**
 * Warm connections.
 *
 * One card per suggestion, approved individually. There is no "approve all"
 * here and there must never be one — see invariant 4. When the account cannot
 * send, the approve button is replaced by the reason rather than left enabled
 * to fail: letting someone approve into a queue that will refuse them is worse
 * than telling them up front.
 */

import { useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, SuggestionCard } from './api';

interface Props {
  account: AccountState;
  suggestions: SuggestionCard[];
  noteLimit: number;
  loading: boolean;
  onChanged: () => void;
}

/** Why sending is blocked, or null when it is not. */
export function blockingReason(account: AccountState): string | null {
  const invites = account.caps.send_invite;
  return invites.allowed ? null : invites.reason ?? 'Sending is paused for this account.';
}

function Card({
  suggestion,
  noteLimit,
  notesLeft,
  blocked,
  onChanged,
}: {
  suggestion: SuggestionCard;
  noteLimit: number;
  /** False once the monthly note allowance is spent. */
  notesLeft: boolean;
  blocked: string | null;
  onChanged: () => void;
}): JSX.Element {
  const [note, setNote] = useState(suggestion.draftNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      // A 409 reason is written for the user. Show it exactly as it arrived.
      setError(e instanceof ApiError ? e.reason ?? e.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const over = note.length > noteLimit;

  return (
    <div className="card">
      <div className="card-head">
        <span className="name">{suggestion.person.name}</span>
        {suggestion.person.headline && (
          <span className="headline">{suggestion.person.headline}</span>
        )}
        <span className="spacer" />
        <span className="meta">{suggestion.reason}</span>
      </div>

      <div className="did">
        <span className="kind">
          {suggestion.engagementKind === 'comment' ? 'Commented on your post' : 'Reacted to your post'}
        </span>
        {suggestion.commentText ?? <em>No comment — reaction only.</em>}
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label={`Connection note for ${suggestion.person.name}`}
        disabled={blocked !== null || !notesLeft}
      />

      {!notesLeft && (
        <div className="notice" style={{ marginTop: 8, marginBottom: 0 }}>
          No notes left this month — this invite will send <strong>without a note</strong>,
          which has a much higher limit.
        </div>
      )}

      {blocked ? (
        <div className="blocked">{blocked}</div>
      ) : (
        <div className="card-foot">
          <button
            className="primary"
            disabled={busy || (notesLeft && (over || note.trim() === ''))}
            onClick={() => void act(() => api.approve(suggestion.id, note.trim()))}
          >
            {notesLeft ? 'Approve invite' : 'Approve without note'}
          </button>
          <button
            className="link"
            disabled={busy}
            onClick={() => void act(() => api.dismiss(suggestion.id))}
          >
            Dismiss
          </button>
          <span className="spacer" />
          <span className="meta" style={over ? { color: 'var(--magenta)' } : undefined}>
            {note.length}/{noteLimit}
          </span>
        </div>
      )}

      {error && <div className="blocked">{error}</div>}
    </div>
  );
}

export function Connections({
  account,
  suggestions,
  noteLimit,
  loading,
  onChanged,
}: Props): JSX.Element {
  const blocked = blockingReason(account);

  if (loading) return <div className="empty">Loading…</div>;

  if (suggestions.length === 0) {
    return (
      <div className="empty">
        No warm connections waiting. Publish a post, then pull its engagers from the Posts list.
      </div>
    );
  }

  return (
    <>
      {blocked && (
        <div className="banner">
          <strong>Invites are on hold.</strong> {blocked}
        </div>
      )}
      <div className="cards">
        {suggestions.map((s) => (
          <Card
            key={s.id}
            suggestion={s}
            noteLimit={noteLimit}
            notesLeft={account.notesRemaining > 0}
            blocked={blocked}
            onChanged={onChanged}
          />
        ))}
      </div>
    </>
  );
}
