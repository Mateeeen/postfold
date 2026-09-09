/**
 * Your posts on LinkedIn, and the way to turn them into people.
 *
 * This screen exists because the warm-connection half of the product had no
 * entry point in the UI at all. Pulling engagers is the only thing that ever
 * fills People, and until now the only way to trigger it was an HTTP call by
 * hand — so that tab was permanently empty and looked broken rather than
 * unused.
 *
 * The list comes from the platform, not from our `posts` table. That table
 * only holds what was published through this tool; posts written by hand in
 * the LinkedIn app never appear in it, and those are often the ones with the
 * most engagement to harvest.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, PublishedPost } from './api';

interface Props {
  account: AccountState;
  onChanged: () => void;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

export function Published({ account, onChanged }: Props): JSX.Element {
  const [posts, setPosts] = useState<PublishedPost[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPosts((await api.publishedPosts()).posts);
    } catch {
      setPosts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pull = async (p: PublishedPost): Promise<void> => {
    setBusy(p.urn);
    setNote(null);
    try {
      await api.syncEngagers(p.urn);
      setNote(
        'Looking at who engaged. Anyone worth knowing will appear in People — ' +
          'nothing is sent to them without you approving that person.',
      );
      onChanged();
    } catch (e) {
      setNote(e instanceof ApiError ? (e.reason ?? e.message) : 'Could not read the engagers.');
    } finally {
      setBusy(null);
    }
  };

  if (posts === null) return <div className="empty">Reading your posts…</div>;

  if (posts.length === 0) {
    return (
      <div className="empty">
        No posts found on this account yet. Publish one and it will show up here, with
        who engaged with it.
      </div>
    );
  }

  return (
    <>
      <p className="lede muted" style={{ marginBottom: 14 }}>
        Your posts as LinkedIn reports them. Pulling engagers is how People fills up —
        it reads who reacted and commented, and proposes the ones worth knowing.
      </p>

      {note && <div className="notice">{note}</div>}

      <div className="published">
        {posts.map((p) => (
          <article className="pub" key={p.urn}>
            <div className="pub-body">
              <p className="pub-text">{p.text.replace(/\s+/g, ' ').slice(0, 180)}</p>
              <div className="pub-meta">
                <span>{when(p.postedAt)}</span>
                {p.isRepost && <span className="chip">repost</span>}
                <span className="spacer" />
                <span className="pub-stat">
                  <strong>{p.impressions.toLocaleString()}</strong> impressions
                </span>
                <span className="pub-stat">
                  <strong>{p.reactions.toLocaleString()}</strong> reactions
                </span>
                <span className="pub-stat">
                  <strong>{p.comments.toLocaleString()}</strong> comments
                </span>
              </div>
            </div>

            <div className="pub-actions">
              {/* A repost's engagers belong to whoever wrote it, and inviting
                  them off someone else's post is a stretch we do not make. */}
              {p.isRepost ? (
                <span className="meta">reposts are skipped</span>
              ) : (
                <button
                  className="ghost"
                  disabled={busy !== null || account.caps.sync_engagers.allowed === false}
                  title={account.caps.sync_engagers.reason ?? undefined}
                  onClick={() => void pull(p)}
                >
                  {busy === p.urn ? 'reading…' : 'Find who engaged'}
                </button>
              )}
              {p.postUrl && (
                <a className="li-open" href={p.postUrl} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
