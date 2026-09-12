/**
 * The right rail: what the current screen needs beside it, never below it.
 *
 * Standing facts were living under the Home list, which reads as a footer, and
 * a footer is where things go to be ignored. They are not items and never
 * belonged in the queue; they belong alongside it.
 *
 * One rail, different contents. Home answers "is it on and what turns it on",
 * Compose shows the thing being written against, Review says how far through
 * you are. Settings has nothing to say here, and an empty rail is a better
 * answer than a filler panel.
 */

import type { AccountState, HomePayload, UnlockState } from './api';

type DialKey = 'post' | 'comment' | 'connect';

const DIALS: [DialKey, string, string][] = [
  ['post', 'Posts', '1 a day'],
  ['comment', 'Comments', '2 a day'],
  ['connect', 'Invitations', 'paced'],
];

/** "in 2h", "tomorrow". Enough to know whether to wait around. */
function shortWhen(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return hours < 48 ? 'tomorrow' : `in ${Math.floor(hours / 24)}d`;
}

function Dial({
  label,
  rate,
  mode,
  state,
  pausedReason,
}: {
  label: string;
  rate: string;
  mode: 'draft' | 'ask' | 'auto';
  state: UnlockState | undefined;
  pausedReason: string | null;
}): JSX.Element {
  const on = mode === 'auto' && state?.unlocked === true;

  return (
    <div className={on ? 'rail-dial on' : 'rail-dial'}>
      <span className="rail-dial-name">{label}</span>
      {/* The state, not the policy. Three dials all reading "you approve each
          one" said the same sentence three times and nothing about what is
          different between them. */}
      <span className="rail-dial-state">
        {on ? `On · ${rate}` : 'Off · you approve each one'}
      </span>
      {/* The reason it is off sits with the dial it applies to, not in a
          paragraph doing three jobs at once. */}
      {!on && pausedReason && <span className="rail-dial-why">{pausedReason}</span>}
      {!on && state?.reason && <span className="rail-dial-why">{state.reason}</span>}
    </div>
  );
}

export function HomeRail({
  account,
  data,
}: {
  account: AccountState;
  data: HomePayload;
}): JSX.Element {
  const { autopilot, standing } = data;

  return (
    <>
      <section className="rail-block">
        <h2>Running on its own</h2>
        <div className="rail-dials">
          {DIALS.map(([key, label, rate]) => (
            <Dial
              key={key}
              label={label}
              rate={rate}
              mode={account.automationModes[key]}
              state={autopilot[key]}
              // Only the invite dial can be switched off by acceptance
              // dropping, so only it carries that sentence.
              pausedReason={key === 'connect' ? standing.evidenceNeeded : null}
            />
          ))}
        </div>
      </section>

      <section className="rail-block">
        <h2>Next out</h2>
        <p className="rail-figure">
          {account.nextScheduledAt ? shortWhen(account.nextScheduledAt) : 'nothing queued'}
        </p>
      </section>

      <section className="rail-block">
        <h2>Your writing</h2>
        {/* A number, not a paragraph. What it means is one line under it. */}
        <p className="rail-figure">{standing.evidenceDocuments}</p>
        <p className="rail-note">
          pieces this can quote from
          {standing.voiceDocuments > 0 && (
            <>
              {' '}
              · {standing.voiceDocuments} more shape the style but cannot be quoted
            </>
          )}
        </p>
      </section>
    </>
  );
}

export function ReviewRail({
  index,
  total,
}: {
  index: number;
  total: number;
}): JSX.Element {
  return (
    <section className="rail-block">
      <h2>Progress</h2>
      {/* Finite, so it feels like something that ends. */}
      <p className="rail-figure">
        {Math.min(index + 1, total)} <span className="rail-of">of {total}</span>
      </p>
      <p className="rail-note">One person at a time. There is no approve-all.</p>
    </section>
  );
}
