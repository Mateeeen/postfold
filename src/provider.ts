/**
 * The seam between PostFold and whatever actually drives the social account.
 *
 * Ten methods. Everything the product does to the outside world goes through
 * one of them. (It was five before comments and trend discovery; the seam grew
 * with the product, but the rule that nothing crosses it except these types
 * did not.) Nothing above this file knows the name of the vendor, its
 * response shapes, its error codes, or its auth scheme.
 *
 * DB-free, vendor-free. Adapters live in src/providers/.
 */

import type {
  AccountStatus,
  Engagement,
  FailureClass,
  Person,
} from './types.js';

export interface PublishPostInput {
  providerAccountId: string;
  text: string;
}

export interface PublishPostResult {
  /** Provider-side post identifier. Opaque to us. */
  urn: string;
  publishedAt: Date;
}

export interface ListEngagersInput {
  providerAccountId: string;
  postUrn: string;
}

export interface ListEngagersResult {
  people: Omit<Person, 'id' | 'accountId'>[];
  /** Engagements reference people by `providerPersonId`, not our row ids. */
  engagements: (Omit<Engagement, 'personId'> & { providerPersonId: string })[];
}

export interface SendInviteInput {
  providerAccountId: string;
  providerPersonId: string;
  /** Empty string means "send without a note". */
  note: string;
}

export interface SendInviteResult {
  providerInviteId: string;
  sentAt: Date;
}

/** An invitation we sent that the platform still considers pending. */
export interface PendingInvitation {
  providerPersonId: string;
  /** Provider's own id for the invitation, needed to withdraw it. */
  invitationId: string | null;
  sentAt: Date | null;
}

export interface SearchPostsInput {
  providerAccountId: string;
  keyword: string;
  /** Only posts newer than this. The platform offers coarse buckets, not a
   *  timestamp, so this is a hint rather than a precise cutoff. */
  window: 'day' | 'week' | 'month';
  limit: number;
}

/** Somebody else's post, as returned by search. Vendor-neutral. */
export interface FoundPost {
  urn: string;
  text: string;
  authorName: string;
  authorHeadline: string | null;
  authorProviderId: string | null;
  reactions: number;
  comments: number;
  postedAt: Date | null;
  /** Canonical link to the post, as given by the platform. */
  postUrl: string | null;
  /** Vanity handle, for linking to the author's profile. */
  authorPublicIdentifier: string | null;
}

/** An existing comment on someone else's post. */
export interface ExistingComment {
  authorName: string;
  authorHeadline: string | null;
  text: string;
  reactions: number;
  /** Null when the platform did not identify the author. */
  authorProviderId: string | null;
  /** True when this person is already a first-degree connection. */
  alreadyConnected: boolean;
}

export interface PostCommentInput {
  providerAccountId: string;
  postUrn: string;
  text: string;
  /** Set to reply to an existing comment rather than the post itself. */
  replyToCommentId?: string;
}

export interface PostCommentResult {
  providerCommentId: string;
  postedAt: Date;
}

export interface AccountHealth {
  status: AccountStatus;
  /** Provider-visible reason the account is not usable, if any. */
  reason: string | null;
}

export interface SocialProvider {
  readonly name: string;

  publishPost(input: PublishPostInput): Promise<PublishPostResult>;

  listEngagers(input: ListEngagersInput): Promise<ListEngagersResult>;

  sendInvite(input: SendInviteInput): Promise<SendInviteResult>;

  getProfile(input: {
    providerAccountId: string;
    providerPersonId: string;
  }): Promise<ProviderProfile>;

  getAccountHealth(input: {
    providerAccountId: string;
  }): Promise<AccountHealth>;

  /** Find other people's posts by keyword. Read-only at the platform. */
  searchPosts(input: SearchPostsInput): Promise<FoundPost[]>;

  /** Read the comments already on a post. Read-only. */
  getPostComments(input: {
    providerAccountId: string;
    postUrn: string;
    limit: number;
    /** Set to read replies to one comment instead of top-level comments. */
    commentId?: string;
  }): Promise<ExistingComment[]>;

  /** Reply to someone else's post. */
  postComment(input: PostCommentInput): Promise<PostCommentResult>;

  /**
   * Invitations we have sent that are still pending.
   *
   * One call answers "which invites are still outstanding", where the
   * alternative is a profile lookup per person — and the platform's own
   * guidance caps profile retrieval at ~100/day, a budget acceptance polling
   * would otherwise consume entirely.
   */
  listSentInvitations(input: {
    providerAccountId: string;
    limit: number;
  }): Promise<PendingInvitation[]>;
}

/* --- Inbound events ---------------------------------------------------- *
 * The provider pushes events at us as well as answering calls. These are the
 * normalised shapes; the vendor's own JSON never gets past its adapter.
 * ---------------------------------------------------------------------- */

export type InboundEvent =
  | {
      type: 'invite_accepted';
      providerAccountId: string;
      providerPersonId: string;
      occurredAt: Date;
      eventId: string | null;
    }
  | {
      type: 'account_status';
      providerAccountId: string;
      status: AccountStatus;
      reason: string | null;
      eventId: string | null;
    }
  | {
      type: 'post_published';
      providerAccountId: string;
      urn: string;
      eventId: string | null;
    }
  | { type: 'unknown'; name: string; eventId: string | null };

/**
 * An account the provider can act on, as seen at setup time. Used only by the
 * connect flow — the running product addresses accounts by our own row id.
 */
export interface ConnectableAccount {
  providerAccountId: string;
  displayName: string;
  /** Which social network, e.g. 'LINKEDIN'. Vendor-neutral string. */
  network: string;
  health: AccountHealth;
}

/**
 * A profile, with the two facts that decide whether an invite is even legal:
 * whether we are already connected, and whether this is the account owner.
 * Sending to an existing connection is not an error at the API level — it
 * returns 200 — it just silently does nothing, which would leave us recording
 * an invite that can never be accepted.
 */
export interface ProviderProfile {
  providerPersonId: string;
  name: string;
  headline: string | null;
  profileUrl: string | null;
  /** First-degree already. An invite would be a no-op. */
  alreadyConnected: boolean;
  isSelf: boolean;
}

/** Who a connected account belongs to, as the provider sees it. */
export interface AccountOwner {
  providerPersonId: string;
  name: string;
  headline: string | null;
  profileUrl: string | null;
  /**
   * Paid tier. This decides the invite ceiling more than anything else we
   * track: a FREE account attaching a note gets roughly five invitations a
   * month, against ~150/week without one. Null when the provider didn't say.
   */
  isPremium: boolean | null;
}

export interface WebhookAdapter {
  /** Constant-time signature check over the RAW request body. */
  verify(rawBody: Buffer | string, signatureHeader: string | null, secret: string): boolean;
  parse(rawBody: Buffer | string): InboundEvent;
}

/**
 * The only error type allowed to cross the seam. An adapter that throws
 * anything else has leaked its vendor into the caller — the worker classifies
 * unknown errors as `transient`, which is the safe reading but hides the bug.
 */
export class ProviderError extends Error {
  readonly failureClass: FailureClass;
  /** Provider's own status/code, kept for logs only. Never branched on above. */
  readonly providerCode: string | null;
  /** Honour a provider-supplied cooldown when it gives us one. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    failureClass: FailureClass,
    options: { providerCode?: string | null; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.failureClass = failureClass;
    this.providerCode = options.providerCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
