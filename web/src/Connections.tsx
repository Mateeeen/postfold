/**
 * Warm connections — one person at a time.
 *
 * This is a card stack rather than a list, and that is a safety decision
 * before it is a design one. Invariant 4 says no connection request is ever
 * queued without explicit per-person approval, and a list is an invitation to
 * build select-all on top of it — first as a convenience, then as a default.
 * A stack has nowhere to put one. The constraint is enforced by the shape of
 * the screen instead of by a warning nobody reads.
 *
 * Keyboard: J/K move, A approves, X dismisses, E edits the note. Approving is
 * the only action that sends anything, and it is the only one that cannot be
 * reached by holding a key down — it commits the note as typed, and the next
 * card starts from a fresh decision.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, SuggestionCard } from './api';
import { Avatar } from './PostCard';

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
  return invites.allowed ? null : (invites.reason ?? 'Sending is paused for this account.');
}

export function Connections({
  account,
  suggestions,
  noteLimit,
  loading,
  onChanged,
}: Props): JSX.Element {
  const blocked = blockingReason(account);
  const notesLeft = account.notesRemaining > 0;

  const [index, setIndex] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const current = suggestions[Math.min(index, Math.max(0, suggestions.length - 1))];

  // A new card is a new decision: the note resets to what was drafted for
  // *this* person, never carries over from the last one.
  useEffect(() => {
    setNote(current?.draftNote ?? '');
    setEditing(false);
    setError(null);
  }, [current?.id]);

  const act = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
        // Stay on the same index: the list shortens under us, so this lands on
        // the next person rather than skipping one.
        onChanged();
      } catch (e) {
        setError(e instanceof ApiError ? (e.reason ?? e.message) : 'Something went wrong.');
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged],
  );

  const over = note.length > noteLimit;
  const canApprove =
    !busy && blocked === null && (!notesLeft || (!over && note.trim() !== ''));

  const approve = useCallback(() => {
    if (!current || !canApprove) return;
    void act(() => api.approve(current.id, note.trim()));
  }, [current, canApprove, act, note]);

  const dismiss = useCallback(() => {
    if (!current || busy) return;
    void act(() => api.dismiss(current.id));
  }, [current, busy, act]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Never steal a keystroke from the note being written.
      if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;

      const k = e.key.toLowerCase();
      if (k === 'j') {
        setIndex((i) => Math.min(i + 1, suggestions.length - 1));
      } else if (k === 'k') {
        setIndex((i) => Math.max(i - 1, 0));
      } else if (k === 'a') {
        e.preventDefault();
        approve();
      } else if (k === 'x') {
        e.preventDefault();
        dismiss();
      } else if (k === 'e') {
        e.preventDefault();
        setEditing(true);
        setTimeout(() => noteRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approve, dismiss, editing, suggestions.length]);

  if (loading) return <div className="empty">Loading…</div>;

  if (suggestions.length === 0 || !current) {
    return (
      <div className="empty">
        Nobody waiting. When someone engages with your posts or replies to your comments,
        they show up here — one at a time.
      </div>
    );
  }

  return (
    <div className="stack">
      {blocked && (
        <div className="banner">
          <strong>Invites are on hold.</strong> {blocked}
        </div>
      )}

      <div className="stack-head">
        <span className="stack-count">
          {index + 1} <span className="muted">of {suggestions.length}</span>
        </span>
        <span className="spacer" />
        <span className="stack-keys">
          <kbd>J</kbd>
          <kbd>K</kbd> move · <kbd>A</kbd> approve · <kbd>X</kbd> skip · <kbd>E</kbd> edit
        </span>
      </div>

      <article className="person">
        <div className="person-head">
          <Avatar
            who={{
              name: current.person.name,
              headline: current.person.headline,
              avatarUrl: current.person.avatarUrl,
              profileUrl: current.person.profileUrl,
            }}
            size={56}
          />
          <div className="person-who">
            <h2 className="person-name">
              {current.person.profileUrl ? (
                <a href={current.person.profileUrl} target="_blank" rel="noreferrer">
                  {current.person.name}
                </a>
              ) : (
                current.person.name
              )}
            </h2>
            {current.person.headline && (
              <p className="person-headline">{current.person.headline}</p>
            )}
          </div>
        </div>

        {/* What they actually did. The whole reason this person is here. */}
        <div className="person-did">
          <span className="did-label">
            {current.engagementKind === 'comment'
              ? 'Commented on your post'
              : 'Reacted to your post'}
          </span>
          {current.commentText ? (
            <blockquote>{current.commentText}</blockquote>
          ) : (
            <p className="muted">No comment — a reaction only.</p>
          )}
        </div>

        <div className="person-note">
          <div className="note-head">
            <span>{notesLeft ? 'Your note' : 'Sending without a note'}</span>
            <span className="spacer" />
            {notesLeft && (
              <span className={over ? 'counter over' : 'counter'}>
                {note.length}/{noteLimit}
              </span>
            )}
          </div>

          {notesLeft ? (
            <textarea
              ref={noteRef}
              className="li-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onFocus={() => setEditing(true)}
              onBlur={() => setEditing(false)}
              aria-label={`Connection note for ${current.person.name}`}
              disabled={blocked !== null}
            />
          ) : (
            <p className="muted">
              The {account.noteAllowance} note-bearing invites for this month are used up.
              This sends without one, which has a far higher limit.
            </p>
          )}
        </div>

        <div className="person-foot">
          <button className="primary" disabled={!canApprove} onClick={approve}>
            {notesLeft ? 'Approve invite' : 'Approve without note'}
          </button>
          <button className="ghost" disabled={busy} onClick={dismiss}>
            Skip
          </button>
          <span className="spacer" />
          <span className="meta">{current.reason}</span>
        </div>

        {error && <div className="blocked">{error}</div>}
      </article>

      <p className="stack-foot muted">
        One person at a time, on purpose. There is no approve-all here and there will not
        be one — every invite goes out because you looked at this specific person and said
        yes.
      </p>
    </div>
  );
}
