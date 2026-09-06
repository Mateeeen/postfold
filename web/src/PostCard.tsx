/**
 * A post, rendered the way the platform renders it.
 *
 * This is not decoration. A draft reply is a judgement about one specific post
 * by one specific person, and the user is being asked to approve it in seconds.
 * Name, headline, face, age and engagement are the things they would use to
 * make that call if they were looking at the real thing — so they are shown
 * here, in the arrangement they already know how to read.
 *
 * The fold is real: LinkedIn truncates a post at a character count and hides
 * the rest behind "see more". The composer already tells you where that lands,
 * and it would be strange for the preview to disagree, so the same limit is
 * used here and it comes from the server rather than being written twice.
 */

import { useState } from 'react';

export interface PostIdentity {
  name: string;
  headline: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
}

interface Props {
  who: PostIdentity;
  text: string;
  /** ISO. Rendered as an age, the way a feed does. */
  postedAt?: string | null;
  reactions?: number;
  comments?: number;
  postUrl?: string | null;
  foldCharLimit: number;
  /** Marks a post that has not been published, so a preview never looks live. */
  draft?: boolean;
  footer?: React.ReactNode;
}

/** Two letters, for when there is no photo or the signed URL has expired. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** "3d", "2h", "now" — a feed shows age, not a date. */
function age(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function Avatar({
  who,
  size = 48,
}: {
  who: PostIdentity;
  size?: number;
}): JSX.Element {
  const [broken, setBroken] = useState(false);
  const showImage = who.avatarUrl !== null && !broken;

  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size / 2.6) }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={who.avatarUrl ?? undefined}
          alt=""
          // Avatar URLs are signed and expire. When one lapses we fall back to
          // initials rather than leaving a broken image in the card.
          onError={() => setBroken(true)}
        />
      ) : (
        initials(who.name)
      )}
    </span>
  );
}

export function PostCard({
  who,
  text,
  postedAt,
  reactions,
  comments,
  postUrl,
  foldCharLimit,
  draft = false,
  footer,
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const folds = text.length > foldCharLimit;
  const shown = folds && !expanded ? text.slice(0, foldCharLimit).trimEnd() : text;
  const when = age(postedAt);

  return (
    <article className={draft ? 'li-post is-draft' : 'li-post'}>
      <header className="li-head">
        <Avatar who={who} />
        <div className="li-who">
          <span className="li-name">
            {who.profileUrl ? (
              <a href={who.profileUrl} target="_blank" rel="noreferrer">
                {who.name}
              </a>
            ) : (
              who.name
            )}
          </span>
          {who.headline && <span className="li-headline">{who.headline}</span>}
          <span className="li-meta">
            {draft ? 'Draft — not published' : when ?? 'just now'}
          </span>
        </div>
      </header>

      <div className="li-body">
        {shown}
        {folds && !expanded && (
          <>
            <span className="li-ellipsis">…</span>{' '}
            <button className="li-more" onClick={() => setExpanded(true)}>
              see more
            </button>
          </>
        )}
      </div>

      {/* The fold marker only means something before it is opened. */}
      {folds && !expanded && (
        <div className="li-fold-note">
          Everything after this point is hidden until someone taps “see more”.
        </div>
      )}

      {(reactions !== undefined || comments !== undefined) && (
        <div className="li-stats">
          {reactions !== undefined && (
            <span>
              {reactions.toLocaleString()} {reactions === 1 ? 'reaction' : 'reactions'}
            </span>
          )}
          {comments !== undefined && (
            <span>
              {comments.toLocaleString()} {comments === 1 ? 'comment' : 'comments'}
            </span>
          )}
          {postUrl && (
            <a className="li-open" href={postUrl} target="_blank" rel="noreferrer">
              Open on LinkedIn ↗
            </a>
          )}
        </div>
      )}

      {footer}
    </article>
  );
}

/**
 * A comment sitting under a post.
 *
 * Indented and visually subordinate for the same reason the platform does it:
 * the post is the context and the comment is the thing being judged, and the
 * hierarchy has to say so before any of the words are read.
 */
export function CommentBlock({
  who,
  children,
}: {
  who: PostIdentity;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="li-comment">
      <Avatar who={who} size={32} />
      <div className="li-comment-body">
        <div className="li-comment-who">
          <span className="li-name">{who.name}</span>
          {who.headline && <span className="li-headline">{who.headline}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}
