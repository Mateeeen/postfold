/**
 * The queue: what is scheduled, when, and what already ran.
 *
 * Showing the scheduled time is the point. The pacing is the product's main
 * safety feature and it is invisible unless the user can see that their five
 * approved invites are going out over the next four hours rather than at once.
 */

import { useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, QueueItem } from './api';

interface Props {
  account: AccountState;
  pending: QueueItem[];
  recent: QueueItem[];
  loading: boolean;
  onChanged: () => void;
}

export function formatWhen(iso: string, timezone: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay =
    d.toLocaleDateString('en-GB', { timeZone: timezone }) ===
    today.toLocaleDateString('en-GB', { timeZone: timezone });

  const time = d.toLocaleTimeString('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  if (sameDay) return `today ${time}`;
  return `${d.toLocaleDateString('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function Row({
  item,
  timezone,
  onChanged,
}: {
  item: QueueItem;
  timezone: string;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminal = item.status !== 'pending';

  const cancel = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.cancel(item.id);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.reason ?? e.message : 'Could not cancel.');
      setBusy(false);
    }
  };

  return (
    <div className={`queue-row${terminal ? ' done' : ''}`}>
      <span className="when">
        {formatWhen(item.completedAt ?? item.scheduledAt, timezone)}
      </span>
      <span className="label">
        {item.label}
        {item.note && <div className="meta">{item.note}</div>}
        {item.preview && <div className="meta">{item.preview}</div>}
        {error && <div className="meta" style={{ color: 'var(--magenta)' }}>{error}</div>}
        {item.status === 'failed' && item.lastError && (
          <div className="meta">{item.lastError}</div>
        )}
      </span>
      {item.status === 'pending' ? (
        <button className="danger" disabled={busy} onClick={() => void cancel()}>
          Cancel
        </button>
      ) : (
        <span className={`pill${item.status === 'failed' ? ' failed' : ''}`}>{item.status}</span>
      )}
    </div>
  );
}

export function Queue({ account, pending, recent, loading, onChanged }: Props): JSX.Element {
  if (loading) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="panel" style={{ marginBottom: 18 }}>
        <h2>Scheduled</h2>
        {pending.length === 0 ? (
          <div className="empty">Nothing queued.</div>
        ) : (
          <div className="cards">
            {pending.map((item) => (
              <Row key={item.id} item={item} timezone={account.timezone} onChanged={onChanged} />
            ))}
          </div>
        )}
        <p className="meta" style={{ marginTop: 10 }}>
          Anything you approve by hand goes out within a few minutes, spaced apart. Drafts
          that publish on their own wait for your send window —{' '}
          {String(account.windowStartHour).padStart(2, '0')}:00 to{' '}
          {String(account.windowEndHour).padStart(2, '0')}:00 {account.timezone}.
        </p>
      </div>

      <div className="panel">
        <h2>Recent</h2>
        {recent.length === 0 ? (
          <div className="empty">Nothing has run yet.</div>
        ) : (
          <div className="cards">
            {recent.map((item) => (
              <Row key={item.id} item={item} timezone={account.timezone} onChanged={onChanged} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
