# PostFold — working notes

A LinkedIn tool for solo creators. Two halves: a post composer that shows where
LinkedIn truncates a post, and a warm-connection flow that turns the people who
engaged with a post into individually-approved connection requests, sent slowly.

Actions execute through Unipile, a third-party API that drives LinkedIn on the
user's behalf. **This is not an official LinkedIn integration.** The
account-safety machinery in `src/policy.ts` is the only thing standing between
this product and its users getting their accounts restricted. Treat it as
load-bearing.

## Invariants

These are not style preferences. Each one exists because breaking it causes a
specific, hard-to-reverse harm to a real person's LinkedIn account.

1. **`src/policy.ts` is the only file containing a rate limit, cap, or
   interval.** No magic numbers anywhere else. If you need a number, import it
   from `LIMITS`. A cap duplicated in two places is a cap that will drift.

2. **`src/providers/unipile.ts` is the only file that references Unipile.**
   Nothing above the adapter imports it, names it, or knows its response
   shapes. Everything crosses the seam as `SocialProvider` types, `InboundEvent`
   values, or `ProviderError` with one of our six `FailureClass` values.

3. **Nothing enters the `actions` table except through
   `scheduler.enqueue()`.** Routes never INSERT. There is deliberately no
   `insertAction` helper in `src/db/actions.ts`. The budget check and the
   insert must be one decision, or "how much is promised today" stops being
   knowable and the daily cap becomes advisory.

4. **No connection request is ever queued without explicit per-person user
   approval.** There is no bulk-approve, no auto-approve, no "approve all", and
   no scoring threshold above which we send on the user's behalf. The engager
   pipeline produces *suggestions*; a human turns one into an action.

5. **Per-account send concurrency is exactly 1.** The queue drains one action
   at a time, paced by `scheduled_at`. A burst of sends is the single most
   reliable way to get an account flagged. This is not a performance bug to be
   optimised away later.

6. **`sending_enabled` is checked before every send** — at enqueue time *and*
   again in the worker immediately before execution. Between the two, a user
   may have paused, or a checkpoint webhook may have landed.

## Things that look wrong and are not

- **better-sqlite3 is synchronous, but every DB function is `async`.** The
  signatures are kept async so callers did not change when we moved off
  Postgres. The bodies are plain synchronous calls. Do not add fake promises.
- **The worker is single-process.** SQLite has no `FOR UPDATE SKIP LOCKED`; the
  claim uses `BEGIN IMMEDIATE` + `UPDATE ... RETURNING`. Running two workers
  against one database file is unsupported. See README "Scaling".
- **Defaults are conservative.** Warm-up starts at 5 invites/day; the hard
  ceiling is 25; the send window is Mon–Fri 09:00–17:00 local. These are
  product decisions, not placeholders.
- **A `dailyCapOverride` can only lower a cap, never raise one.** It is a
  safety valve, not a bypass.
- **A webhook never re-enables sending.** Recovering from a checkpoint requires
  a human, because the platform saying "you're fine now" is not evidence that
  whatever triggered the checkpoint has been dealt with.

## Layout

```
src/types.ts              Domain types. No vendor names. DB-free.
src/provider.ts           SocialProvider (5 methods) + InboundEvent. DB-free.
src/policy.ts             Every limit, the warm-up ladder, acceptance bands,
                          jittered pacing. Pure functions. DB-free.
src/providers/unipile.ts  The only file that knows Unipile exists. DB-free.
src/providers/fake.ts     Logs instead of calling out. Used when there is no
                          UNIPILE_API_KEY, and to inject failures in tests.
src/engagers.ts           Warm-connection pipeline.          touches DB
src/webhooks.ts           Inbound events.                    touches DB
src/queue/scheduler.ts    Budget-enforced enqueue.           touches DB
src/queue/worker.ts       Claim -> execute -> classify -> back off. touches DB
src/db/                   SQLite connection, mappers, repositories.
db/*.sql                  Migrations, applied in filename order.
web/                      Vite + React frontend. Reads fold/note limits from
                          GET /api/config rather than hardcoding them —
                          invariant 1 applies here too.
```

The composer and carousel were ported into `web/src/PostFold.tsx`; there is no
separate standalone `PostFold.jsx` to keep in sync with it.

## Testing

`policy.ts` is the highest-value test target. `nextSlot()` is swept across ten
timezones, a full week of start times, and budgets 1–25, asserting every result
lands inside the send window; two real bugs were caught this way. If you change
pacing, that sweep is what tells you whether you broke it.

Everything is demonstrable end-to-end with no Unipile account:
`npm run migrate && npm run seed && npm run dev`.
