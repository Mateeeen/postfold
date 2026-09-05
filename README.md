# PostFold

A LinkedIn tool for solo creators.

**Content.** A composer that shows exactly where LinkedIn truncates your post —
"the fold" — flags the things that cost reach, and a builder that turns an
outline into a PDF carousel.

**Warm connections.** After you post, PostFold pulls the people who commented
or reacted, ranks them, drafts a short connection note for each, and asks you
to approve them one at a time. Approved invites enter a paced queue that sends
them slowly, over working hours, in your timezone.

## Quick start

```bash
npm install
npm run install:web
cp .env.example .env      # UNIPILE_API_KEY can stay empty
npm run migrate
npm run seed
npm run build             # builds the frontend into web/dist
npm run dev               # http://localhost:3000
```

For frontend hot reload, run `npm run dev` and `npm run dev:web` side by side
and use http://localhost:5173 — Vite proxies `/api` and `/webhooks` to the API.

With `UNIPILE_API_KEY` unset the app runs on `FakeProvider`: nothing is sent
anywhere, but the composer, carousel, suggestions, approval flow, paced queue,
worker and acceptance-rate movement all work end to end. That is intentional —
pacing bugs only show up when you can run the queue thousands of times, and you
cannot do that against a real LinkedIn account without getting it restricted.

| Script | What it does |
| --- | --- |
| `npm run dev` | HTTP API + in-process worker, serving `web/dist` |
| `npm run dev:web` | Vite dev server on :5173, proxying to the API |
| `npm run worker` | Worker only (one process — see Scaling) |
| `npm run migrate` | Apply `db/*.sql` in order. Idempotent. |
| `npm run seed` | One test account, one post, two pending suggestions |
| `npm test` | Vitest |
| `npm run build` | `tsc` + the frontend build |

## Architecture

```
routes ──► scheduler.enqueue() ──► actions table ──► worker ──► SocialProvider
              │                                         │            │
              └────────► policy.budget() ◄──────────────┘     providers/unipile.ts
                                                              providers/fake.ts
```

Five layers, and the boundaries matter more than the layers:

- **`src/types.ts`** — the domain. No vendor names, no row shapes.
- **`src/provider.ts`** — the seam. Five methods; everything PostFold does to
  the outside world goes through one of them.
- **`src/policy.ts`** — every limit, cap, interval and backoff in the product,
  as pure functions. No DB, no clock, no randomness except what you pass in.
- **`src/providers/unipile.ts`** — the only file that knows Unipile exists.
- **DB-touching modules** — `engagers`, `webhooks`, `queue/scheduler`,
  `queue/worker`.

## The safety model

This is not an official LinkedIn integration. Automation that looks like
automation gets accounts restricted, so the product's job is to look like a
person who is slightly organised.

**Warm-up ladder.** A newly connected account starts at 5 invites/day and
climbs to 25 over three weeks. Day-one volume is the most reliable way to get
flagged.

**Acceptance-rate throttle.** Acceptance rate is how LinkedIn decides an
account is spamming, so it is also how PostFold decides to slow down first.
Below 40% the cap is cut to 60%, below 25% to 30%, and below 15% invites stop
entirely. Nothing is judged until there are at least 20 settled invites — a new
account with two sent and none accepted is new, not a spammer.

**Jittered pacing.** Sends are spread across the account's send window
(default Mon–Fri, 09:00–17:00 local) with a randomised gap, a minimum gap of 8
minutes, and a guard against scheduling into the last minutes of the window.
Per-account concurrency is exactly 1.

**Explicit approval.** Every connection request is approved individually, by a
human, with an editable note. There is no bulk approve.

**Failure classification.** Every provider error becomes one of six classes.
`transient` retries with backoff; `rate_limited` cools the whole account for an
hour; `checkpoint` and `auth` stop the account and require a human; `invalid`
fails one action and leaves the account alone. Retrying into a checkpoint is
how accounts get restricted, so a checkpoint is never retried.

### Two bugs the pacing tests caught

Both were found by sweeping `nextSlot()` across timezones rather than by
reading it, which is why that sweep is the test to keep:

1. **Slots landing outside the window on DST boundaries.** Converting a local
   wall-clock time to an instant needs the offset *at that instant*, which is
   circular. A single-pass conversion put sends an hour outside the window on
   every spring-forward, and in zones whose transition happens at local
   midnight (`America/Santiago`) it moved them to the wrong day. The fix is the
   two-pass conversion in `zonedToUtc` plus a re-validation loop — the result
   is checked against the window rather than trusted.

2. **End-of-window scheduling.** At high budgets the spacing arithmetic would
   place a send at 16:58, which then retried past 17:00 and sent outside
   working hours — exactly the pattern the window exists to avoid.
   `WINDOW_TAIL_GUARD_MINUTES` closes the window early for scheduling purposes.

## Frontend

Vite + React + TypeScript in `web/`. No component library; the styling is a
single stylesheet.

Four tabs:

- **Compose** — the composer, with a live fold marker showing exactly where
  LinkedIn cuts the post, and flags for the things that cost reach. "Copy post"
  and "Add to queue" sit side by side; the queue path goes through the
  scheduler like everything else.
- **Carousel** — outline in, square slides out. Export uses the browser's own
  print-to-PDF (`window.print()` against a print stylesheet) rather than
  pulling in a PDF library.
- **Connections** — one card per suggestion: who they are, what they did (their
  comment, when they left one), and an editable note. Approve and Dismiss are
  per card. When the account cannot send, the approve buttons are replaced by
  the reason, so nobody approves into a queue that will refuse them.
- **Queue** — pending actions with their scheduled times, recent completed
  ones, and a cancel button on anything still pending.

The header strip is always visible: warm-up day, invites left today, acceptance
rate with its band, and the next scheduled send.

Magenta is reserved for the single most important signal on each screen — the
fold line in the composer, the thing blocking sends in Connections. Everything
else is muted. The fold marker stops meaning anything if it competes with a
magenta button.

The frontend does not hardcode the fold position or the note limit; it reads
them from `GET /api/config`, which serves them from `policy.ts`. Invariant 1
applies to the frontend too.

## Storage

SQLite via `better-sqlite3`, WAL mode, one file at `./data/postfold.db`.

- `PRAGMA foreign_keys = ON` on every connection. Without it every `REFERENCES`
  and `ON DELETE CASCADE` in the schema is decorative.
- `busy_timeout = 5000`.
- Every timestamp column is TEXT holding ISO-8601 UTC. Never mix epoch integers
  into these columns; the date comparisons fail silently if you do.
- Former `jsonb` columns are TEXT holding JSON, encoded and decoded in
  `src/db/index.ts` and nowhere else.
- `better-sqlite3` is synchronous. DB functions keep `async` signatures so
  callers did not change when we moved off Postgres; the bodies are
  synchronous. There are no fake promises beyond that.

### Scaling

**The worker is single-process, and horizontal scaling requires moving back to
Postgres.**

Postgres claimed work with `SELECT ... FOR UPDATE SKIP LOCKED`, which lets N
workers pull disjoint rows from one queue. SQLite has no equivalent. What
replaces it here is a single-writer model: one worker process, `BEGIN
IMMEDIATE` to take the write lock before the claim reads the row it is about to
update, and `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` (SQLite
3.35+) to claim atomically.

Running two workers against the same database file is not a supported
configuration. It will not obviously break — it will occasionally double-send,
which on this product means two connection requests to one person, which is
precisely the behaviour that gets accounts restricted.

If you need more than one worker, the change is to restore the Postgres schema
and the `FOR UPDATE SKIP LOCKED` claim. Nothing above `src/db/` and
`src/queue/` depends on which of the two is underneath.

## HTTP API

```
GET    /api/accounts/:id              status, warm-up day, effective caps,
                                      acceptance rate + band, paused reason
POST   /api/accounts/:id/pause        { reason }
POST   /api/accounts/:id/resume

POST   /api/posts                     { text } -> enqueue a post
GET    /api/posts                     published posts
POST   /api/posts/:urn/sync-engagers  pull engagers for a post

GET    /api/suggestions               ranked warm connections + drafted notes
POST   /api/suggestions/:id/approve   { note? } -> enqueue invite
POST   /api/suggestions/:id/dismiss

GET    /api/config                    fold + note limits, from policy.ts
GET    /api/queue                     pending + recent actions
DELETE /api/queue/:id                 cancel a pending action

POST   /webhooks/unipile              raw body, HMAC verified
```

When `enqueue()` refuses, the API returns **409** with the reason string from
`policy.ts`. The frontend shows that string to the user verbatim — it is
written to be read by a human, so do not reword it in a route or turn it into
an error code.
