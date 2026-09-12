/**
 * Settings: when this acts, and how much of it acts alone.
 *
 * Two things and no more. The send window is the only scheduling control a
 * person actually wants, and the mode dials are the answer to "is this on".
 * Daily cap overrides exist in the API and stay out of here deliberately —
 * they can only lower a cap, nobody has asked for one, and a control that
 * exists to be ignored is a control that makes everything near it look
 * optional.
 *
 * Locked dials show the unlock line verbatim. It is written as a distance to
 * travel, so the screen reads as a thing being worked toward rather than a
 * thing being withheld.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { AccountState, UnlockState } from './api';

interface Props {
  account: AccountState;
  onChanged: () => void;
}

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
] as const;

const hour = (h: number): string => {
  if (h === 0 || h === 24) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
};

type DialKey = 'post' | 'comment' | 'connect';

const DIALS: [DialKey, string, string][] = [
  ['post', 'Posts', 'One a day, written from what your field is discussing.'],
  ['comment', 'Comments', 'Replies on posts you would plausibly have replied to.'],
  ['connect', 'Invitations', 'Only people who engaged with you first.'],
];

export function Settings({ account, onChanged }: Props): JSX.Element {
  const [unlocks, setUnlocks] = useState<Record<string, UnlockState> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [start, setStart] = useState(account.windowStartHour);
  const [end, setEnd] = useState(account.windowEndHour);
  const [days, setDays] = useState<number[]>(account.sendDays);
  const [tz, setTz] = useState(account.timezone);

  const load = useCallback(async (): Promise<void> => {
    try {
      setUnlocks((await api.home()).autopilot);
    } catch {
      setUnlocks(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      setNote(ok);
      onChanged();
      void load();
    } catch (e) {
      setError(e instanceof ApiError ? (e.reason ?? e.message) : 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (d: number): void => {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  };

  const windowChanged =
    start !== account.windowStartHour ||
    end !== account.windowEndHour ||
    tz !== account.timezone ||
    days.join() !== account.sendDays.join();

  return (
    <div className="settings">
      {note && <div className="notice">{note}</div>}
      {error && <div className="blocked">{error}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2>When this acts</h2>
        </div>
        <p className="lede muted">
          Everything is spread across these hours with a gap between each one. Nothing
          goes out at 3am, and nothing goes out in a burst.
        </p>

        <div className="field">
          <label htmlFor="tz">Your timezone</label>
          <input
            id="tz"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="Asia/Karachi"
          />
        </div>

        <div className="field">
          <span className="field-label">Hours</span>
          <div className="hours">
            <select value={start} onChange={(e) => setStart(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hour(h)}
                </option>
              ))}
            </select>
            <span className="meta">to</span>
            <select value={end} onChange={(e) => setEnd(Number(e.target.value))}>
              {Array.from({ length: 25 }, (_, h) => (
                <option key={h} value={h}>
                  {hour(h)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <span className="field-label">Days</span>
          <div className="chips">
            {DAYS.map(([d, label]) => (
              <button
                key={d}
                className={days.includes(d) ? 'chip-btn on' : 'chip-btn'}
                onClick={() => toggleDay(d)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button
            className="primary"
            disabled={busy || !windowChanged}
            onClick={() =>
              void save(
                () =>
                  api.saveSettings(account.id, {
                    timezone: tz,
                    sendDays: days,
                    windowStartHour: start,
                    windowEndHour: end,
                  }),
                'Saved. Anything already queued keeps its slot.',
              )
            }
          >
            Save
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>What runs without you</h2>
        </div>
        <p className="lede muted">
          Autopilot is earned rather than switched on — each of these opens once there is
          enough evidence it is safe to let run.
        </p>

        <div className="dial-rows">
          {DIALS.map(([key, label, blurb]) => {
            const state = unlocks?.[key];
            const mode = account.automationModes[key];
            const locked = state ? !state.unlocked : true;

            return (
              <div key={key} className="dial-row">
                <div className="dial-row-text">
                  <span className="dial-row-name">{label}</span>
                  <span className="dial-row-blurb">{blurb}</span>
                  {locked && state?.reason && (
                    // Verbatim: written as a distance to travel.
                    <span className="dial-why">{state.reason}</span>
                  )}
                </div>

                <div className="dial-choice">
                  {(['ask', 'auto'] as const).map((m) => (
                    <button
                      key={m}
                      className={mode === m ? 'chip-btn on' : 'chip-btn'}
                      disabled={busy || (m === 'auto' && locked)}
                      title={m === 'auto' && locked ? (state?.reason ?? undefined) : undefined}
                      onClick={() =>
                        void save(
                          () => api.saveModes(account.id, { [key]: m }),
                          m === 'auto'
                            ? `${label} will go out on their own from now on.`
                            : `${label} will wait for you.`,
                        )
                      }
                    >
                      {m === 'ask' ? 'I approve each' : 'On its own'}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
