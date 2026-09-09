/**
 * Trending on the left, yours on the right.
 *
 * The point of the split is that the two are visible at once. Writing "from"
 * a post while looking at a different screen is just writing; seeing the thing
 * that worked next to the thing you are making is what makes the comparison
 * useful — and it keeps the difference honest, because a draft that is really
 * a paraphrase is obvious when the original is six inches away.
 *
 * What crosses over is subject, not content. The generated image is drawn from
 * the same territory rather than being their picture, and the text argues its
 * own position rather than restating theirs.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, Config, DraftCard, FeedPost } from './api';
import { PostCard } from './PostCard';

interface Props {
  account: AccountState;
  config: Config;
  onChanged: () => void;
  onGo: (tab: 'drafts') => void;
}

export function Trending({ account, config, onChanged, onGo }: Props): JSX.Element {
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [picked, setPicked] = useState<FeedPost | null>(null);
  const [draft, setDraft] = useState<DraftCard | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api.feed();
      // Loudest first: the whole premise of this screen is "this one worked".
      const sorted = [...r.posts].sort(
        (a, b) => b.reactions + b.comments - (a.reactions + a.comments),
      );
      setPosts(sorted);
      setPicked((p) => p ?? sorted[0] ?? null);
    } catch {
      setPosts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const build = async (from: FeedPost): Promise<void> => {
    setBusy(true);
    setError(null);
    setDone(null);
    setDraft(null);
    try {
      const r = await api.writePostFrom(from.id);
      setDraft(r.draft);
      setText(r.draft.text);
    } catch (e) {
      setError(e instanceof ApiError ? (e.reason ?? e.message) : 'Could not write that one.');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.approveDraft(draft.id, text.trim());
      setDone('Queued. It publishes inside your send window.');
      setDraft(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? (e.reason ?? e.message) : 'Could not queue it.');
    } finally {
      setBusy(false);
    }
  };

  const me = {
    name: account.profile.name,
    headline: account.profile.headline,
    avatarUrl: account.profile.avatarUrl,
    profileUrl: account.profile.profileUrl,
  };

  const blocked = account.caps.create_post.allowed
    ? null
    : (account.caps.create_post.reason ?? 'Publishing is paused for this account.');

  if (posts === null) return <div className="empty">Loading what is landing…</div>;
  if (posts.length === 0) {
    return (
      <div className="empty">
        Nothing found yet. Go to Comments and press “Find new posts”.
      </div>
    );
  }

  return (
    <div className="versus">
      <section className="versus-col">
        <div className="versus-head">
          <h2>Working right now</h2>
          <span className="meta">{posts.length} posts</span>
        </div>

        <div className="trend-list">
          {posts.slice(0, 12).map((p) => (
            <button
              key={p.id}
              className={picked?.id === p.id ? 'trend on' : 'trend'}
              onClick={() => setPicked(p)}
            >
              <span className="trend-score">
                {(p.reactions + p.comments).toLocaleString()}
              </span>
              <span className="trend-body">
                <span className="trend-who">{p.authorName}</span>
                <span className="trend-text">{p.text.replace(/\s+/g, ' ').slice(0, 80)}…</span>
              </span>
              {p.attachments.length > 0 && <span className="trend-media">image</span>}
            </button>
          ))}
        </div>

        {picked && (
          <>
            <PostCard
              who={{
                name: picked.authorName,
                headline: picked.authorHeadline,
                avatarUrl: picked.authorAvatarUrl,
                profileUrl: picked.authorUrl,
              }}
              text={picked.text}
              postedAt={picked.postedAt}
              reactions={picked.reactions}
              comments={picked.comments}
              postUrl={picked.postUrl}
              attachments={picked.attachments}
              foldCharLimit={config.foldCharLimit}
            />
            <button
              className="primary wide"
              disabled={busy}
              onClick={() => void build(picked)}
            >
              {busy && !draft ? 'writing yours…' : 'Write mine on this subject →'}
            </button>
          </>
        )}
      </section>

      <section className="versus-col">
        <div className="versus-head">
          <h2>Yours</h2>
          {draft && <span className="meta">not published</span>}
        </div>

        {done && <div className="notice">{done}</div>}
        {error && <div className="blocked">{error}</div>}

        {!draft ? (
          <div className="empty">
            Pick a post on the left, then press <strong>Write mine</strong>. It takes the
            subject, not the words — and draws its own image rather than reusing theirs.
          </div>
        ) : (
          <>
            <PostCard
              who={me}
              text={text}
              imageUrl={draft.imageUrl}
              foldCharLimit={config.foldCharLimit}
              draft
            />

            <textarea
              className="li-input post-edit"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Your post"
              disabled={blocked !== null}
            />

            <div className="versus-foot">
              <button
                className="primary"
                disabled={busy || text.trim() === '' || blocked !== null}
                onClick={() => void approve()}
              >
                Queue this post
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => {
                  void api.dismissDraft(draft.id);
                  setDraft(null);
                  setDone('Discarded.');
                }}
              >
                Discard
              </button>
              <span className="spacer" />
              <button className="link" onClick={() => onGo('drafts')}>
                All drafts →
              </button>
            </div>

            {blocked && <div className="blocked">{blocked}</div>}
            <p className="rail-note">{draft.rationale}</p>
          </>
        )}
      </section>
    </div>
  );
}
