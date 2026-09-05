/**
 * Drafts — machine-written posts and comments awaiting a decision.
 *
 * The countdown is the most important thing on this screen. These drafts
 * publish themselves if ignored, so "how long have I got" must be legible at a
 * glance and must go magenta before it runs out. A user who is surprised by
 * something that went out is a user this screen failed.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, DraftCard, Keyword, LastSearch } from './api';

interface Props {
  account: AccountState;
  drafts: DraftCard[];
  keywords: Keyword[];
  commentLimit: number;
  lastSearch: LastSearch | null;
  searchPending: boolean;
  loading: boolean;
  onChanged: () => void;
}

/** Live "time left" string. Returns null when there is no deadline. */
function useCountdown(iso: string | null): { label: string; urgent: boolean } | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [iso]);

  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { label: 'publishing now', urgent: true };

  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const label =
    hours >= 1
      ? `publishes in ${hours}h ${mins % 60}m`
      : `publishes in ${mins}m`;
  // Under two hours is the point at which "I'll look later" stops being safe.
  return { label, urgent: ms < 2 * 3_600_000 };
}

function DraftItem({
  draft,
  commentLimit,
  blocked,
  onChanged,
}: {
  draft: DraftCard;
  commentLimit: number;
  blocked: string | null;
  onChanged: () => void;
}): JSX.Element {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown(draft.autoApproveAt);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.reason ?? e.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const over = draft.kind === 'comment' && text.length > commentLimit;

  return (
    <div className="card">
      <div className="card-head">
        <span className="name">{draft.kind === 'post' ? 'Post' : 'Comment'}</span>
        {draft.sourcePost && (
          <span className="headline">
            on{' '}
            {draft.sourcePost.authorUrl ? (
              <a
                href={draft.sourcePost.authorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ext"
              >
                {draft.sourcePost.authorName}
              </a>
            ) : (
              draft.sourcePost.authorName
            )}
            &rsquo;s post &middot; {draft.sourcePost.keyword}
          </span>
        )}
        <span className="spacer" />
        {countdown ? (
          <span className={countdown.urgent ? 'strip-value alert' : 'meta'}>
            {countdown.label}
          </span>
        ) : (
          <span className="meta">waits for you</span>
        )}
      </div>

      {draft.sourcePost && (
        <div className="did">
          <span className="kind">
            Replying to {draft.sourcePost.authorName}
            {draft.sourcePost.authorHeadline ? ` — ${draft.sourcePost.authorHeadline}` : ''}
            {' · '}
            {draft.sourcePost.reactions} reactions
          </span>
          {draft.sourcePost.text.slice(0, 400)}
          {draft.sourcePost.text.length > 400 ? '…' : ''}
          <div style={{ marginTop: 8 }}>
            {/* Read the real thing before replying to it. */}
            <a
              href={draft.sourcePost.postUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ext"
            >
              Open on LinkedIn ↗
            </a>
          </div>
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`Draft ${draft.kind}`}
        disabled={blocked !== null}
        style={{ minHeight: draft.kind === 'post' ? 140 : 74 }}
      />

      <div className="row" style={{ marginTop: 6 }}>
        <span className="meta">
          {draft.rationale}
          {draft.model ? ` · ${draft.model}` : ''}
        </span>
      </div>

      {blocked ? (
        <div className="blocked">{blocked}</div>
      ) : (
        <div className="card-foot">
          <button
            className="primary"
            disabled={busy || over || text.trim() === ''}
            onClick={() => void act(() => api.approveDraft(draft.id, text.trim()))}
          >
            Approve now
          </button>
          <button
            className="link"
            disabled={busy}
            onClick={() => void act(() => api.dismissDraft(draft.id))}
          >
            Dismiss
          </button>
          <span className="spacer" />
          {draft.kind === 'comment' && (
            <span className="meta" style={over ? { color: 'var(--magenta)' } : undefined}>
              {text.length}/{commentLimit}
            </span>
          )}
        </div>
      )}

      {error && <div className="blocked">{error}</div>}
    </div>
  );
}

/** Plain-English account of the last search. */
function searchSummary(s: LastSearch, pending: boolean): string {
  if (pending) return 'A search is queued and will run shortly.';
  const mins = Math.max(0, Math.round((Date.now() - new Date(s.at).getTime()) / 60_000));
  const when = mins < 1 ? 'just now' : `${mins} min ago`;
  if (s.error) return `Last search ${when} failed while drafting: ${s.error}`;
  if (s.postsFound === 0) {
    return `Last search ${when}: ${s.keywords} keyword${s.keywords === 1 ? '' : 's'}, no posts found. Try broader keywords.`;
  }
  if (s.drafted === 0) {
    return (
      `Last search ${when}: ${s.postsFound} posts found, but the model declined all ` +
      `${s.declined} candidate${s.declined === 1 ? '' : 's'} as promotional or off-topic. ` +
      `Nothing was drafted.`
    );
  }
  return (
    `Last search ${when}: ${s.postsFound} posts found, ${s.drafted} drafted` +
    (s.declined > 0 ? `, ${s.declined} declined.` : '.')
  );
}

function Keywords({
  keywords,
  lastSearch,
  searchPending,
  onChanged,
}: {
  keywords: Keyword[];
  lastSearch: LastSearch | null;
  searchPending: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; refused: boolean } | null>(null);

  // Every action here reports what happened. A button that silently does
  // nothing is worse than one that refuses out loud.
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice({ text: ok, refused: false });
      onChanged();
    } catch (e) {
      setNotice({
        text: e instanceof ApiError ? e.reason ?? e.message : 'Something went wrong.',
        refused: e instanceof ApiError && e.refused,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <h2>Keywords</h2>
      <div className="row">
        <input
          type="text"
          value={term}
          placeholder="Add a topic to watch…"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && term.trim() !== '') {
              void run(async () => {
                await api.addKeyword(term.trim());
                setTerm('');
              });
            }
          }}
          style={{ flex: 1 }}
        />
        <button
          disabled={busy || term.trim() === ''}
          onClick={() =>
            void run(async () => {
              await api.addKeyword(term.trim());
              setTerm('');
            })
          }
        >
          Add
        </button>
        <button disabled={busy} onClick={() => void run(() => api.suggestKeywords())}>
          Suggest from profile
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await api.syncTrends();
              return r;
            }, 'Searching — new drafts appear here within a few minutes.')
          }
        >
          {busy ? 'Working…' : 'Find posts now'}
        </button>
      </div>

      {lastSearch && !notice && (
        <p className="meta" style={{ marginTop: 12, marginBottom: 0 }}>
          {searchSummary(lastSearch, searchPending)}
        </p>
      )}

      {notice && (
        <div className={notice.refused ? 'blocked' : 'notice'} style={{ marginTop: 12, marginBottom: 0 }}>
          {notice.text}
        </div>
      )}

      {keywords.length === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>
          No keywords yet. Add one, or let the model propose some from your profile.
        </div>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          {keywords.map((k) => (
            <span
              key={k.id}
              className="pill"
              style={{
                opacity: k.enabled ? 1 : 0.45,
                cursor: 'pointer',
                textTransform: 'none',
                letterSpacing: 0,
              }}
              title={k.source === 'user' ? 'Added by you' : 'Proposed from your profile'}
              onClick={() => void run(() => api.toggleKeyword(k.id, !k.enabled))}
            >
              {k.term}
              {k.source === 'user' ? ' ·' : ''}
              <button
                className="link"
                style={{ padding: '0 0 0 6px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  void run(() => api.deleteKeyword(k.id));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="meta" style={{ marginTop: 10 }}>
        Click a keyword to mute it. Muted keywords stay in the list but are not searched.
      </p>
    </div>
  );
}

export function Drafts({
  account,
  drafts,
  keywords,
  commentLimit,
  lastSearch,
  searchPending,
  loading,
  onChanged,
}: Props): JSX.Element {
  const invites = account.caps.send_invite;
  // Comments share the account's health, so the same conditions that hold
  // invites hold comments. Surface the reason rather than letting an approve
  // fail at the queue.
  const blocked = account.caps.post_comment?.allowed === false
    ? account.caps.post_comment.reason
    : !account.sendingEnabled
      ? account.pausedReason ?? 'Sending is paused for this account.'
      : null;

  const autoCount = drafts.filter((d) => d.autoApproveAt !== null).length;

  if (loading) return <div className="empty">Loading…</div>;

  return (
    <>
      <Keywords
        keywords={keywords}
        lastSearch={lastSearch}
        searchPending={searchPending}
        onChanged={onChanged}
      />

      {autoCount > 0 && (
        <div className="banner">
          <strong>{autoCount} draft{autoCount === 1 ? '' : 's'} will publish on their own.</strong>{' '}
          Anything you don&rsquo;t approve or dismiss goes out at the time shown on each card.
        </div>
      )}

      {blocked && (
        <div className="banner">
          <strong>Publishing is held.</strong> {blocked}
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="empty">
          No drafts waiting. Add keywords above and press &ldquo;Find posts now&rdquo;.
          {invites.remaining === 0 && ' '}
        </div>
      ) : (
        <div className="cards">
          {drafts.map((d) => (
            <DraftItem
              key={d.id}
              draft={d}
              commentLimit={commentLimit}
              blocked={blocked}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </>
  );
}
