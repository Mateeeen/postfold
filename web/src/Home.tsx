/**
 * Home. One queue, replacing Today, Review, Scheduled and Your posts.
 *
 * Every row has the same anatomy whatever it is, because the differences
 * between a post and an invitation matter to the database and not to the
 * person reading the list. What varies is the state chip and the two buttons.
 *
 * The countdown is the load-bearing element. An automated product that shows
 * you a number ticking down feels controllable; one that simply acts feels
 * like something happening to you. Everything that will leave without being
 * looked at again says so, in words, next to the time it will happen.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, HomeItem, HomePayload } from './api';
import { Avatar } from './PostCard';

interface Props {
  onOpen: (item: HomeItem) => void;
  onChanged: () => void;
}

/** "in 2h 14m". Recomputed on a timer so it actually ticks. */
function useNow(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [active]);
  return Date.now();
}

function countdown(iso: string, now: number): { label: string; soon: boolean } {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return { label: 'any moment', soon: true };
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return { label: `in ${mins}m`, soon: true };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { label: `in ${hours}h ${mins % 60}m`, soon: hours < 2 };
  return { label: `in ${Math.floor(hours / 24)}d`, soon: false };
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

const KIND_LABEL: Record<HomeItem['kind'], string> = {
  post: 'Post',
  comment: 'Comment',
  invite: 'Invitation',
  withdraw: 'Taking back',
};

function Row({
  item,
  now,
  onOpen,
}: {
  item: HomeItem;
  now: number;
  onOpen: (item: HomeItem) => void;
}): JSX.Element {
  const due = item.goesOutAt ? countdown(item.goesOutAt, now) : null;

  return (
    <button className={`row row-${item.state}`} onClick={() => onOpen(item)}>
      <span className="row-kind">{KIND_LABEL[item.kind]}</span>

      {item.person && (
        <Avatar
          who={{
            name: item.person.name,
            headline: null,
            avatarUrl: item.person.avatarUrl,
            profileUrl: null,
          }}
          size={24}
        />
      )}

      <span className="row-body">
        <span className="row-preview">{item.preview}</span>
        {item.reason && <span className="row-reason">{item.reason}</span>}
      </span>

      <span className="spacer" />

      {item.state === 'needs_you' && <span className="chip-state needs">Needs you</span>}

      {item.state === 'going_out' && due && (
        <span className={due.soon ? 'chip-state going soon' : 'chip-state going'}>
          {item.kind === 'post' ? 'Posting' : 'Sending'} {due.label}
          {/* The one thing that happens whether or not they come back. */}
          {item.unattended && <em>without you</em>}
        </span>
      )}

      {item.state === 'sent' && (
        <span className="chip-state done">
          {item.outcome}
          {item.sentAt && <em>{ago(item.sentAt)}</em>}
        </span>
      )}
    </button>
  );
}

export function Home({ onOpen, onChanged }: Props): JSX.Element {
  const [data, setData] = useState<HomePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api.home());
    } catch (e) {
      setError(e instanceof ApiError ? (e.reason ?? e.message) : 'Could not load.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = (data?.items ?? []).some((i) => i.state === 'going_out');
  const now = useNow(live);

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const { account, items, digest } = data;
  const needs = items.filter((i) => i.state === 'needs_you');

  return (
    <div className="home">
      {/* Two banners, worded differently on purpose: one is something to fix,
          the other is us waiting for somebody else. */}
      {account.providerOutageUntil && (
        <div className="banner waiting">
          <strong>Paused while LinkedIn is unreachable.</strong> Nothing is wrong with your
          account and there is nothing to do — this resumes on its own.
        </div>
      )}

      {!account.sendingEnabled && !account.providerOutageUntil && (
        <div className="banner">
          <strong>Nothing is being sent.</strong>{' '}
          {account.pausedReason ?? 'Sending is switched off.'}
        </div>
      )}

      {digest && (
        <div className="digest">
          <span>{digest.line}</span>
          <span className="spacer" />
          <button
            className="link"
            onClick={() => {
              void api.dismissDigest(digest.day).then(load);
            }}
          >
            Got it
          </button>
        </div>
      )}

      {items.length === 0 ? (
        // Invites rather than apologises. The queue being empty is the normal
        // resting state of this product, not a failure of it.
        <div className="empty-home">
          <h2>Nothing waiting.</h2>
          <p>
            Drafts appear here as they are written, and anything about to go out shows a
            countdown you can stop.
          </p>
          <button className="primary" onClick={() => onChanged()}>
            Write something now
          </button>
        </div>
      ) : (
        <>
          {needs.length > 0 && (
            <p className="home-lede">
              {needs.length} {needs.length === 1 ? 'thing needs' : 'things need'} you.
              Everything else is on its way or already gone.
            </p>
          )}

          <div className="rows">
            {items.map((i) => (
              <Row key={`${i.kind}-${i.id}`} item={i} now={now} onOpen={onOpen} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
