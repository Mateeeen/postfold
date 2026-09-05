/**
 * Domain types for PostFold.
 *
 * Rules for this file:
 *  - No vendor names. Nothing here may hint at which API executes an action.
 *  - No database concerns. No row shapes, no SQL types, no nullable-because-
 *    the-column-is-nullable. If a field is optional it is optional in the
 *    domain.
 *  - No limits, caps or intervals. Those live in policy.ts, always.
 */

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

/**
 * Lifecycle of a connected social account.
 *
 * `checkpointed` means the platform has interrupted the session and is asking
 * the human to prove something (captcha, SMS, "was this you"). It is not an
 * error we retry through — it is a hard stop until a human clears it.
 *
 * `restricted` means the platform has taken action against the account. We
 * never resume from this automatically.
 */
export type AccountStatus =
  | 'active'
  | 'paused'
  | 'checkpointed'
  | 'restricted'
  | 'disconnected';

export interface Account {
  id: string;
  userId: string;
  /** Opaque handle the provider uses for this account. Format is not ours. */
  providerAccountId: string;
  displayName: string;
  status: AccountStatus;
  /**
   * Master switch, independent of `status`. Checked before every send.
   * A user pausing sends flips this; a provider incident flips `status`.
   */
  sendingEnabled: boolean;
  pausedReason: string | null;
  /** When the account was first connected. Anchors the warm-up ladder. */
  connectedAt: Date;
  /** IANA zone. All send-window arithmetic is done in this zone. */
  timezone: string;
  /** Days sends are allowed. 0 = Sunday .. 6 = Saturday. */
  sendDays: number[];
  /** Local hour the send window opens / closes. Half-open: [start, end). */
  windowStartHour: number;
  windowEndHour: number;
  /** Per-kind manual ceiling. Never raises a cap above policy's own ceiling. */
  dailyCapOverride: Partial<Record<ActionKind, number>> | null;
  /** Set when the provider reports a checkpoint; no sends until it passes. */
  checkpointUntil: Date | null;
  /**
   * The owner's own identity at the provider. Used to keep the owner out of
   * their own engager list — otherwise reacting to your own post makes you a
   * connection suggestion for yourself. Null for accounts connected before we
   * started recording it.
   */
  ownerPersonId: string | null;
  /**
   * Whether the platform account is on a paid tier. Null when unknown.
   *
   * Load-bearing: on a FREE account, an invitation carrying a note is limited
   * to roughly five per MONTH by the platform itself, against ~150/week
   * without a note. No cap we choose matters next to that one.
   */
  isPremium: boolean | null;
  /** The owner's own headline, used to give the drafter their voice. */
  headline: string | null;
}

/* ------------------------------------------------------------------ *
 * People and engagement
 * ------------------------------------------------------------------ */

export interface Person {
  id: string;
  accountId: string;
  providerPersonId: string;
  name: string;
  headline: string | null;
  profileUrl: string | null;
}

export type EngagementKind = 'reaction' | 'comment';

export interface Engagement {
  personId: string;
  postUrn: string;
  kind: EngagementKind;
  /** Present only for comments. This is what we show the user for context. */
  commentText: string | null;
  occurredAt: Date;
}

/* ------------------------------------------------------------------ *
 * Posts
 * ------------------------------------------------------------------ */

export type PostStatus = 'draft' | 'queued' | 'published' | 'failed';

export interface Post {
  id: string;
  accountId: string;
  /** Provider-side identifier. Null until published. */
  urn: string | null;
  text: string;
  status: PostStatus;
  publishedAt: Date | null;
  /** Last time we pulled engagers for this post. */
  engagersSyncedAt: Date | null;
}

/* ------------------------------------------------------------------ *
 * Warm-connection suggestions
 * ------------------------------------------------------------------ */

export type SuggestionStatus = 'pending' | 'approved' | 'queued' | 'dismissed';

/**
 * A ranked candidate for a connection request. A suggestion is *only* a
 * proposal — it becomes an action when, and only when, the user approves this
 * specific person. See invariant 4 in CLAUDE.md.
 */
export interface Suggestion {
  id: string;
  accountId: string;
  personId: string;
  postId: string;
  score: number;
  /** Human-readable justification shown in the UI. */
  reason: string;
  /** Pre-drafted note. The user may edit it before approving. */
  draftNote: string;
  status: SuggestionStatus;
  createdAt: Date;
  decidedAt: Date | null;
}

/* ------------------------------------------------------------------ *
 * Queue
 * ------------------------------------------------------------------ */

export type ActionKind =
  | 'create_post'
  | 'send_invite'
  | 'sync_engagers'
  /** Reply to someone else's post. */
  | 'post_comment'
  /** Pull posts matching the account's keywords. Read-only at the platform. */
  | 'sync_trends'
  /** Read replies to comments we left. Read-only. */
  | 'sync_replies'
  /** Check whether sent invites have been accepted. Read-only. */
  | 'poll_acceptance';

export type ActionStatus =
  | 'pending'
  | 'in_flight'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CreatePostPayload {
  postId: string;
  text: string;
}

export interface SendInvitePayload {
  suggestionId: string;
  personId: string;
  providerPersonId: string;
  note: string;
}

export interface SyncEngagersPayload {
  postId: string;
  postUrn: string;
}

export interface PostCommentPayload {
  draftId: string;
  /** The post being replied to. */
  postUrn: string;
  text: string;
}

export interface SyncTrendsPayload {
  /** Empty means "every enabled keyword". */
  terms: string[];
}

export interface SyncRepliesPayload {
  /** Empty means "every comment we have posted recently". */
  draftIds: string[];
}

export interface PollAcceptancePayload {
  /** Empty means "every invite still marked sent". */
  inviteIds: string[];
}

export type ActionPayload =
  | ({ kind: 'create_post' } & CreatePostPayload)
  | ({ kind: 'send_invite' } & SendInvitePayload)
  | ({ kind: 'sync_engagers' } & SyncEngagersPayload)
  | ({ kind: 'post_comment' } & PostCommentPayload)
  | ({ kind: 'sync_trends' } & SyncTrendsPayload)
  | ({ kind: 'sync_replies' } & SyncRepliesPayload)
  | ({ kind: 'poll_acceptance' } & PollAcceptancePayload);

export interface Action {
  id: string;
  accountId: string;
  kind: ActionKind;
  status: ActionStatus;
  payload: ActionPayload;
  /** When the worker is allowed to pick this up. Always in the future at insert. */
  scheduledAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  attempts: number;
  lastError: string | null;
  lastFailureClass: FailureClass | null;
  /**
   * Natural key for the work this action represents. Two enqueues with the
   * same key produce one action. This is what makes enqueue idempotent.
   */
  dedupeKey: string;
  createdAt: Date;
}

/* ------------------------------------------------------------------ *
 * Invites (the acceptance-rate signal)
 * ------------------------------------------------------------------ */

export type InviteStatus = 'sent' | 'accepted' | 'withdrawn' | 'expired';

export interface Invite {
  id: string;
  accountId: string;
  personId: string;
  actionId: string;
  status: InviteStatus;
  sentAt: Date;
  acceptedAt: Date | null;
}

/* ------------------------------------------------------------------ *
 * Drafts
 * ------------------------------------------------------------------ */

export type DraftKind = 'post' | 'comment';

export type DraftStatus = 'pending' | 'approved' | 'queued' | 'dismissed' | 'expired';

/**
 * Machine-written text awaiting a decision.
 *
 * `autoApproveAt` is the entire risk surface of this feature: when set, an
 * untouched draft publishes at that time under the user's name. Null means it
 * waits indefinitely, which is the default for anything the user has not
 * explicitly opted into.
 */
export interface Draft {
  id: string;
  accountId: string;
  kind: DraftKind;
  status: DraftStatus;
  text: string;
  /** Why this draft exists — shown to the user before they decide. */
  rationale: string;
  /** For comments: the post being replied to. */
  discoveredPostId: string | null;
  /** Which model wrote it, so a bad batch is traceable to a model. */
  model: string | null;
  autoApproveAt: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: 'user' | 'timer' | null;
}

/** Somebody else's post, found by keyword search. */
export interface DiscoveredPost {
  id: string;
  accountId: string;
  urn: string;
  keyword: string;
  text: string;
  authorName: string;
  authorHeadline: string | null;
  authorProviderId: string | null;
  reactions: number;
  comments: number;
  postedAt: Date | null;
  discoveredAt: Date;
  /** Where to read the real thing before approving a reply to it. */
  postUrl: string | null;
  authorPublicIdentifier: string | null;
}

export interface Keyword {
  id: string;
  accountId: string;
  term: string;
  /** 'derived' came from the profile; 'user' was typed by hand and outranks it. */
  source: 'user' | 'derived';
  enabled: boolean;
}

/* ------------------------------------------------------------------ *
 * Failure taxonomy
 * ------------------------------------------------------------------ */

/**
 * How a failed action should be treated. The adapter classifies; the worker
 * acts on the classification; policy.ts decides what "acts on" means.
 *
 *  transient    — network blip, 5xx. Retry with backoff.
 *  rate_limited — the platform said slow down. Retry, and cool the account.
 *  checkpoint   — human verification required. Stop the account entirely.
 *  auth         — credentials/session dead. Stop the account, needs reconnect.
 *  invalid      — this specific request is bad (already connected, no such
 *                 person). Fail the action, leave the account alone.
 *  permanent    — the platform refused in a way retrying cannot fix.
 */
export type FailureClass =
  | 'transient'
  | 'rate_limited'
  | 'checkpoint'
  | 'auth'
  | 'invalid'
  | 'permanent';

/** Health band derived from trailing acceptance rate. Drives throttling. */
export type AcceptanceBand =
  | 'unrated'
  | 'healthy'
  | 'watch'
  | 'throttled'
  | 'critical';
