/**
 * The reply, under the post it replies to.
 *
 * Pre-filled with what the model wrote and fully editable, because approving
 * something you cannot change is not approval. The deadline is stated on the
 * control rather than in a footnote: this comment posts itself when the timer
 * runs out, and a user surprised by that is a user this screen failed.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { FeedPost, PostIdentity } from './api';
import { Avatar } from './PostCard';

/** "in 3h", "in 12m", or "any moment" once it is due. */
function countdown(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'any moment';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.floor(hours / 24)}d`;
}

export function CommentBox({
  post,
  me,
  limit,
  blocked,
  onChanged,
}: {
  post: FeedPost;
  me: PostIdentity;
  limit: number;
  blocked: string | null;
  onChanged: () => void;
}): JSX.Element {
  const [text, setText] = useState(post.draft?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // A refreshed feed can bring a draft that did not exist a moment ago.
  useEffect(() => {
    if (post.draft && text === '') setText(post.draft.text);
  }, [post.draft?.id]);

  const run = async (fn: () => Promise<unknown>, after: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDone(after);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? (e.reason ?? e.message) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const over = text.length > limit;
  const due = countdown(post.draft?.autoApproveAt ?? null);

  if (done) return <div className="reply done">{done}</div>;

  return (
    <div className="reply">
      <Avatar who={me} size={32} />

      <div className="reply-body">
        <textarea
          className="li-input"
          value={text}
          placeholder={
            post.draft ? 'Write your reply…' : 'No comment written for this one yet.'
          }
          onChange={(e) => setText(e.target.value)}
          disabled={blocked !== null}
          aria-label={`Comment on ${post.authorName}'s post`}
        />

        <div className="reply-foot">
          {post.draft ? (
            <>
              <button
                className="primary"
                disabled={busy || over || text.trim() === '' || blocked !== null}
                onClick={() =>
                  void run(
                    () => api.approveDraft(post.draft!.id, text.trim()),
                    'Approved. It goes out in about five minutes.',
                  )
                }
              >
                Approve
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() => api.dismissDraft(post.draft!.id), 'Skipped. Nothing was sent.')
                }
              >
                Skip
              </button>
            </>
          ) : (
            <button
              className="ghost"
              disabled={busy || blocked !== null}
              onClick={() =>
                void run(() => api.draftCommentFor(post.id), 'Written — reopening…')
              }
            >
              {busy ? 'writing…' : 'Write a comment'}
            </button>
          )}

          <span className="spacer" />

          {/* The one thing that happens without the user. Said plainly. */}
          {due && (
            <span className="reply-due">
              posts itself <strong>{due}</strong>
            </span>
          )}
          <span className={over ? 'counter over' : 'counter'}>
            {text.length}/{limit}
          </span>
        </div>

        {blocked && <div className="blocked">{blocked}</div>}
        {error && <div className="blocked">{error}</div>}
      </div>
    </div>
  );
}
