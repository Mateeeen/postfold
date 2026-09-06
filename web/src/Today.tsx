/**
 * The home view.
 *
 * Once the engine runs itself, the user's job stops being "operate this" and
 * becomes "check what it did and what it wants". This screen answers three
 * questions in that order, because that is the order they are asked:
 *
 *   1. Is it running, and what is it doing on my behalf?
 *   2. Does anything need me right now?
 *   3. What has it used up today, and what is next?
 *
 * Every number here is served from /api/config or the account state. None are
 * written into this file - invariant 1 reaches the frontend too, and a cap
 * hardcoded here would eventually disagree with the one being enforced.
 */

import type { AccountState, Config, DraftCard, QueueItem, SuggestionCard } from './api';

interface Props {
  account: AccountState;
  config: Config;
  drafts: DraftCard[];
  suggestions: SuggestionCard[];
  pending: QueueItem[];
  onGo: (tab: 'drafts' | 'connections' | 'queue') => void;
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

function Used({ label, cap }: { label: string; cap: { cap: number; remaining: number } }): JSX.Element {
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

export function Today({ account, config, drafts, suggestions, pending, onGo }: Props): JSX.Element {
  const running = account.sendingEnabled && account.status === 'active';

  // Drafts publish themselves when the timer runs out. That is the one thing
  // on this screen that happens whether or not the user comes back, so it is
  // stated as a deadline rather than a count.
  const timed = drafts
    .filter((d) => d.autoApproveAt !== null)
    .sort((a, b) => (a.autoApproveAt! < b.autoApproveAt! ? -1 : 1));
  const soonest = timed[0]?.autoApproveAt ?? null;

  return (
    <div className="today">
      <section className={running ? 'panel live' : 'panel held'}>
        <div className="panel-head">
          <h2>{running ? 'Running' : 'Paused'}</h2>
          <span className="meta">{account.timezone}</span>
        </div>

        {running ? (
          <p className="lede">
            Every day this writes <strong>{config.dailyPostCap} post</strong> and up to{' '}
            <strong>{config.dailyCommentCap} comments</strong>, and looks for people worth
            connecting with. Drafts wait <strong>{config.autoApproveHours} hours</strong> for you
            before they publish themselves.
          </p>
        ) : (
          <p className="lede">
            Nothing is being sent. {account.pausedReason ?? 'Sending is switched off.'}
          </p>
        )}

        <p className="lede muted">
          Connection invites are the exception: they are never sent without you approving that
          specific person. Up to {config.weeklyInviteCap} a week, spaced out, and{' '}
          {account.noteAllowance} of them a month may carry a note
          {account.isPremium === false ? ' on a free account' : ''}.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Needs you</h2>
        </div>

        {drafts.length === 0 && suggestions.length === 0 ? (
          <p className="lede muted">Nothing waiting. Everything written so far has been dealt with.</p>
        ) : (
          <div className="needs">
            {drafts.length > 0 && (
              <button className="need" onClick={() => onGo('drafts')}>
                <span className="need-n">{drafts.length}</span>
                <span className="need-what">
                  {drafts.length === 1 ? 'draft to review' : 'drafts to review'}
                  {soonest && <em> · first publishes {until(soonest)}</em>}
                </span>
              </button>
            )}
            {suggestions.length > 0 && (
              <button className="need" onClick={() => onGo('connections')}>
                <span className="need-n">{suggestions.length}</span>
                <span className="need-what">
                  {suggestions.length === 1 ? 'person to consider' : 'people to consider'}
                  <em> · nothing is sent until you approve each one</em>
                </span>
              </button>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Today</h2>
          <span className="meta">
            {pending.length > 0 ? (
              <button className="link" onClick={() => onGo('queue')}>
                next {until(account.nextScheduledAt)}
              </button>
            ) : (
              'nothing scheduled'
            )}
          </span>
        </div>

        <Used label="Posts" cap={account.caps.create_post} />
        <Used label="Comments" cap={account.caps.post_comment} />
        <Used label="Invites" cap={account.caps.send_invite} />

        <p className="lede muted">
          Day {account.warmupDay} since connecting. New accounts start slow on purpose — the
          invite allowance climbs to {config.hardDailyInviteCap} a day as the account settles.
        </p>
      </section>
    </div>
  );
}
