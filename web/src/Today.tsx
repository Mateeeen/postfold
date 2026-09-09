/**
 * The dashboard.
 *
 * Two columns, because the two things it answers are different questions. The
 * main column is "what could I do next" — reach, angles worth writing, and the
 * state of the account. The rail is "what is the machine doing" — today's
 * budget and the posts it found.
 *
 * Every number here comes from the server. Reach is what the platform
 * reported, cached rather than live, and a null renders as "—" rather than 0:
 * "we never found out" and "you have none" are different facts and showing a
 * confident zero for the first is a lie.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, Config, DraftCard, FeedPost, QueueItem, SuggestionCard } from './api';
import { Avatar } from './PostCard';

interface Props {
  account: AccountState;
  config: Config;
  drafts: DraftCard[];
  suggestions: SuggestionCard[];
  pending: QueueItem[];
  onGo: (tab: 'drafts' | 'connections' | 'queue') => void;
  /** Reload the app's data. Writing a post changes it. */
  onChanged: () => void;
}

/** "in 3h 20m", or "any moment" once it is due. */
function until(iso: string | null): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'any moment';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const num = (n: number | null): string => (n === null ? '—' : n.toLocaleString());

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function Meter({
  label,
  cap,
}: {
  label: string;
  cap: { cap: number; remaining: number };
}): JSX.Element {
  const used = Math.max(0, cap.cap - cap.remaining);
  const pct = cap.cap === 0 ? 0 : Math.round((used / cap.cap) * 100);
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meta">
          {used} of {cap.cap}
        </span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Today({
  account,
  config,
  drafts,
  suggestions,
  pending,
  onGo,
  onChanged,
}: Props): JSX.Element {
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [feed, setFeed] = useState<FeedPost[]>([]);
  const [writing, setWriting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const running = account.sendingEnabled && account.status === 'active';

  const loadIdeas = useCallback(async (): Promise<void> => {
    setIdeasBusy(true);
    try {
      setIdeas((await api.ideas()).ideas);
    } catch {
      setIdeas([]);
    } finally {
      setIdeasBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadIdeas();
    void api
      .feed()
      .then((r) => setFeed(r.posts))
      .catch(() => setFeed([]));
  }, [loadIdeas]);

  const write = async (idea: string): Promise<void> => {
    setWriting(idea);
    setNotice(null);
    try {
      await api.postNow(idea);
      // Show the thing that was made. Leaving the user on this screen with a
      // line of text was the whole failure: the draft existed on the server,
      // and nothing they could see had changed - not the list, not the badge.
      onChanged();
      onGo('drafts');
    } catch (e) {
      setNotice(e instanceof ApiError ? (e.reason ?? e.message) : 'Could not write that one.');
      setWriting(null);
    }
  };

  // Drafts publish themselves when the timer runs out. That is the one thing
  // here that happens whether or not the user comes back, so it is stated as a
  // deadline rather than a count.
  const soonest =
    drafts
      .filter((d) => d.autoApproveAt !== null)
      .sort((a, b) => (a.autoApproveAt! < b.autoApproveAt! ? -1 : 1))[0]?.autoApproveAt ?? null;

  return (
    <div className="dash">
      <div className="dash-main">
        {!running && (
          <section className="panel held">
            <h2>Paused</h2>
            <p className="lede">
              Nothing is being sent. {account.pausedReason ?? 'Sending is switched off.'}
            </p>
          </section>
        )}

        <div className="stats">
          <Stat label="Followers" value={num(account.reach.followers)} />
          <Stat label="Connections" value={num(account.reach.connections)} />
          <Stat
            label="Impressions"
            value={num(account.reach.impressions7d)}
            note={
              account.reach.posts7d === null
                ? 'last 7 days'
                : `across ${account.reach.posts7d} post${account.reach.posts7d === 1 ? '' : 's'}, 7 days`
            }
          />
        </div>

        <section className="panel">
          <div className="panel-head">
            <h2>Angles worth writing</h2>
            <button className="link" onClick={() => void loadIdeas()} disabled={ideasBusy}>
              {ideasBusy ? 'thinking…' : 'new angles'}
            </button>
          </div>

          {ideas === null || ideasBusy ? (
            <p className="lede muted">Reading what your field is posting about…</p>
          ) : ideas.length === 0 ? (
            <p className="lede muted">
              Nothing to work from yet. Add keywords in Review and run a search.
            </p>
          ) : (
            <div className="ideas">
              {ideas.map((idea) => (
                <div className="idea" key={idea}>
                  <p>{idea}</p>
                  <button
                    className="link"
                    disabled={writing !== null}
                    onClick={() => void write(idea)}
                  >
                    {writing === idea ? 'writing…' : 'Write this post →'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {notice && <div className="notice">{notice}</div>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Needs you</h2>
          </div>
          {drafts.length === 0 && suggestions.length === 0 ? (
            <p className="lede muted">
              Nothing waiting. Everything written so far has been dealt with.
            </p>
          ) : (
            <div className="needs">
              {drafts.length > 0 && (
                <button className="need" onClick={() => onGo('drafts')}>
                  <span className="need-n">{drafts.length}</span>
                  <span className="need-what">
                    {drafts.length === 1 ? 'draft to review' : 'drafts to review'}
                    {soonest && <em>first publishes {until(soonest)}</em>}
                  </span>
                </button>
              )}
              {suggestions.length > 0 && (
                <button className="need" onClick={() => onGo('connections')}>
                  <span className="need-n">{suggestions.length}</span>
                  <span className="need-what">
                    {suggestions.length === 1 ? 'person to consider' : 'people to consider'}
                    <em>nothing is sent until you approve each one</em>
                  </span>
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <aside className="dash-rail">
        <section className="panel">
          <div className="panel-head">
            <h2>Today</h2>
            <span className="meta">
              {pending.length > 0 ? (
                <button className="link" onClick={() => onGo('queue')}>
                  next {until(account.nextScheduledAt)}
                </button>
              ) : (
                'nothing queued'
              )}
            </span>
          </div>

          <Meter label="Posts" cap={account.caps.create_post} />
          <Meter label="Comments" cap={account.caps.post_comment} />
          <Meter label="Invites" cap={account.caps.send_invite} />

          <dl className="facts">
            <div>
              <dt>Warm-up</dt>
              <dd>
                day {account.warmupDay} · {account.warmupCap}/day
              </dd>
            </div>
            <div>
              <dt>Notes left</dt>
              <dd>
                {account.notesRemaining} of {account.noteAllowance}
              </dd>
            </div>
            <div>
              <dt>Acceptance</dt>
              <dd>
                {account.acceptance.rated
                  ? `${Math.round((account.acceptance.rate ?? 0) * 100)}%`
                  : 'no data'}
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Posts it found</h2>
            <span className="meta">{feed.length}</span>
          </div>

          {feed.length === 0 ? (
            <p className="lede muted">
              Nothing found recently. Check your keywords in Review.
            </p>
          ) : (
            <ul className="feed">
              {feed.slice(0, 8).map((p) => (
                <li key={p.id}>
                  <Avatar
                    who={{
                      name: p.authorName,
                      headline: p.authorHeadline,
                      avatarUrl: p.authorAvatarUrl,
                      profileUrl: p.authorUrl,
                    }}
                    size={32}
                  />
                  <div className="feed-body">
                    <a href={p.postUrl} target="_blank" rel="noreferrer" className="feed-name">
                      {p.authorName}
                    </a>
                    <p className="feed-text">{p.text.replace(/\s+/g, ' ').slice(0, 90)}…</p>
                    <span className="feed-meta">
                      {p.reactions.toLocaleString()} reactions · {ago(p.postedAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="rail-note">
          Invites are never sent without you approving that specific person. Up to{' '}
          {config.weeklyInviteCap} a week, spaced out.
        </p>
      </aside>
    </div>
  );
}
