/**
 * The engagement feed.
 *
 * Posts other people wrote, shown as the platform shows them — face, headline,
 * age, the picture — because judging whether a reply is worth making is a
 * judgement about the actual post, and stripping it to 90 characters of text
 * makes that impossible. A post whose point was carried by its image reads as
 * a non-sequitur without it.
 *
 * Filter chips are the account's own keywords. They are the thing that decides
 * what the engine looks at, so they belong on the screen showing what it
 * found, not buried three panels down another tab.
 *
 * Commenting still routes through drafting: the model writes, the user
 * approves. Nothing here posts on click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, Config, FeedPost, Keyword } from './api';
import { PostCard } from './PostCard';

interface Props {
  account: AccountState;
  config: Config;
  keywords: Keyword[];
  onChanged: () => void;
  onGo: (tab: 'drafts') => void;
}

export function Comments({ account, config, keywords, onChanged, onGo }: Props): JSX.Element {
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPosts((await api.feed()).posts);
    } catch {
      setPosts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (posts ?? []).filter((p) => active === null || p.keyword === active),
    [posts, active],
  );

  // Which keywords actually returned something. A chip for a keyword that
  // found nothing is a dead control that says nothing about why.
  const found = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of posts ?? []) counts.set(p.keyword, (counts.get(p.keyword) ?? 0) + 1);
    return counts;
  }, [posts]);

  const search = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await api.syncTrends();
      setNote('Searching. New posts and drafts appear here within a few minutes.');
      onChanged();
    } catch (e) {
      setNote(e instanceof ApiError ? (e.reason ?? e.message) : 'Could not start a search.');
    } finally {
      setBusy(false);
    }
  };

  const comments = account.caps.post_comment;
  const usedToday = Math.max(0, comments.cap - comments.remaining);

  return (
    <div className="engage">
      <div className="engage-head">
        <div className="chips">
          <button
            className={active === null ? 'chip-btn on' : 'chip-btn'}
            onClick={() => setActive(null)}
          >
            Everything
          </button>
          {keywords
            .filter((k) => k.enabled)
            .map((k) => (
              <button
                key={k.id}
                className={active === k.term ? 'chip-btn on' : 'chip-btn'}
                onClick={() => setActive(active === k.term ? null : k.term)}
                disabled={(found.get(k.term) ?? 0) === 0}
                title={
                  (found.get(k.term) ?? 0) === 0 ? 'Nothing found for this one yet' : undefined
                }
              >
                {k.term}
                {(found.get(k.term) ?? 0) > 0 && (
                  <span className="chip-n">{found.get(k.term)}</span>
                )}
              </button>
            ))}
        </div>

        <button className="ghost" onClick={() => void search()} disabled={busy}>
          {busy ? 'searching…' : 'Find new posts'}
        </button>
      </div>

      <div className="progress-card">
        <div className="progress-head">
          <span>Comments today</span>
          <span className="meta">
            {usedToday} of {comments.cap} · {config.dailyCommentCap}/day
          </span>
        </div>
        <div className="meter-track">
          <div
            className="meter-fill"
            style={{ width: `${comments.cap === 0 ? 0 : (usedToday / comments.cap) * 100}%` }}
          />
        </div>
        {!comments.allowed && comments.reason && (
          <p className="progress-note">{comments.reason}</p>
        )}
      </div>

      {note && <div className="notice">{note}</div>}

      {posts === null ? (
        <div className="empty">Loading the feed…</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          {(posts ?? []).length === 0
            ? 'Nothing found recently. Press “Find new posts”, or add keywords.'
            : 'Nothing under that keyword. Pick another chip.'}
        </div>
      ) : (
        <div className="engage-feed">
          {shown.map((p) => (
            <PostCard
              key={p.id}
              who={{
                name: p.authorName,
                headline: p.authorHeadline,
                avatarUrl: p.authorAvatarUrl,
                profileUrl: p.authorUrl,
              }}
              text={p.text}
              postedAt={p.postedAt}
              reactions={p.reactions}
              comments={p.comments}
              postUrl={p.postUrl}
              attachments={p.attachments}
              foldCharLimit={config.foldCharLimit}
              footer={
                <div className="engage-foot">
                  <span className="chip">{p.keyword}</span>
                  <span className="spacer" />
                  <button className="link" onClick={() => onGo('drafts')}>
                    See drafted comments →
                  </button>
                </div>
              }
            />
          ))}
        </div>
      )}

      <p className="rail-note" style={{ marginTop: 6 }}>
        Comments are written by the model and wait for you in Review. Nothing on this screen
        posts anything.
      </p>
    </div>
  );
}
