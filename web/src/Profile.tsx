/**
 * Who this account is, as a person.
 *
 * The product acts under this name — it writes posts as them, comments as
 * them, and asks strangers to connect with them. Seeing the identity that is
 * being used, with the face and headline the recipients will see, is what
 * makes that concrete rather than abstract.
 *
 * Also the fastest way to notice you have connected the wrong account.
 */

import { useState } from 'react';
import { api } from './api';
import type { AccountState } from './api';
import { Avatar } from './PostCard';

export function Profile({
  account,
  onChanged,
}: {
  account: AccountState;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const p = account.profile;

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.refreshProfile(account.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="profile">
      <Avatar who={{ ...p, avatarUrl: p.avatarUrl, profileUrl: p.profileUrl }} size={64} />

      <div className="profile-text">
        <h2 className="profile-name">
          {p.profileUrl ? (
            <a href={p.profileUrl} target="_blank" rel="noreferrer">
              {p.name}
            </a>
          ) : (
            p.name
          )}
        </h2>
        {p.headline && <p className="profile-headline">{p.headline}</p>}
        <p className="profile-meta">
          {p.location && <span>{p.location}</span>}
          <span className={account.isPremium ? 'chip premium' : 'chip'}>
            {account.isPremium === null
              ? 'tier unknown'
              : account.isPremium
                ? 'Premium'
                : 'Free account'}
          </span>
          <span className="chip">
            {account.notesRemaining} of {account.noteAllowance} notes left
          </span>
          <button className="link tiny" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'refreshing…' : 'refresh'}
          </button>
        </p>
      </div>

      <div className="profile-state">
        <span className={account.sendingEnabled ? 'dot live' : 'dot held'} />
        {account.sendingEnabled ? 'Running' : 'Paused'}
      </div>
    </section>
  );
}
