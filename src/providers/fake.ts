/**
 * FakeProvider — a SocialProvider that logs instead of touching the network.
 *
 * Selected automatically when UNIPILE_API_KEY is unset, which means the whole
 * product (composer, suggestions, approval, the paced queue, the worker,
 * acceptance-rate movement) is exercisable end-to-end with no third-party
 * account. That is not a convenience: pacing bugs are only visible when you
 * can run the queue thousands of times, and you cannot do that against a real
 * LinkedIn account without getting the account restricted.
 *
 * It also injects failures on demand, which is how worker.ts's failure
 * classification is tested.
 */

import { ProviderError } from '../provider.js';
import type {
  AccountHealth,
  FoundPost,
  ExistingComment,
  ListEngagersInput,
  PendingInvitation,
  ListEngagersResult,
  PostCommentInput,
  PostCommentResult,
  SearchPostsInput,
  PublishPostInput,
  PublishPostResult,
  SendInviteInput,
  SendInviteResult,
  SocialProvider,
} from '../provider.js';
import type { ProviderProfile } from '../provider.js';
import type { FailureClass } from '../types.js';

export interface FakeCall {
  method: string;
  input: unknown;
  at: Date;
}

export interface FakeProviderOptions {
  /** Set to have the next call throw. Consumed on use unless `sticky`. */
  failWith?: FailureClass | null;
  sticky?: boolean;
  log?: (msg: string) => void;
  health?: AccountHealth;
  /** Provider person ids to report as existing connections. */
  connectedTo?: string[];
}

let seq = 0;

export class FakeProvider implements SocialProvider {
  readonly name = 'fake';
  readonly calls: FakeCall[] = [];

  failWith: FailureClass | null;
  sticky: boolean;
  health: AccountHealth;
  connectedTo: Set<string>;
  private readonly log: (msg: string) => void;

  constructor(options: FakeProviderOptions = {}) {
    this.failWith = options.failWith ?? null;
    this.sticky = options.sticky ?? false;
    this.health = options.health ?? { status: 'active', reason: null };
    this.connectedTo = new Set(options.connectedTo ?? []);
    this.log = options.log ?? ((msg) => console.log(`[fake-provider] ${msg}`));
  }

  private record(method: string, input: unknown): void {
    this.calls.push({ method, input, at: new Date() });
    this.log(`${method} ${JSON.stringify(input)}`);
    if (this.failWith) {
      const fc = this.failWith;
      if (!this.sticky) this.failWith = null;
      throw new ProviderError(`injected ${fc} failure`, fc, { providerCode: 'FAKE' });
    }
  }

  async publishPost(input: PublishPostInput): Promise<PublishPostResult> {
    this.record('publishPost', input);
    return { urn: `urn:fake:post:${++seq}`, publishedAt: new Date() };
  }

  async listEngagers(input: ListEngagersInput): Promise<ListEngagersResult> {
    this.record('listEngagers', input);
    const now = new Date();
    const people = [
      {
        providerPersonId: 'fake-person-1',
        name: 'Dana Okafor',
        headline: 'Head of Growth at Meridian',
        profileUrl: 'https://www.linkedin.com/in/example-dana',
      },
      {
        providerPersonId: 'fake-person-2',
        name: 'Sam Ree',
        headline: 'Founder, Tinyshop',
        profileUrl: 'https://www.linkedin.com/in/example-sam',
      },
    ];
    return {
      people,
      engagements: [
        {
          providerPersonId: 'fake-person-1',
          postUrn: input.postUrn,
          kind: 'comment',
          commentText:
            'The fold point is the thing nobody optimises for. How are you measuring it?',
          occurredAt: now,
        },
        {
          providerPersonId: 'fake-person-2',
          postUrn: input.postUrn,
          kind: 'reaction',
          commentText: null,
          occurredAt: now,
        },
      ],
    };
  }

  async sendInvite(input: SendInviteInput): Promise<SendInviteResult> {
    this.record('sendInvite', input);
    return { providerInviteId: `fake-invite-${++seq}`, sentAt: new Date() };
  }

  async getProfile(input: {
    providerAccountId: string;
    providerPersonId: string;
  }): Promise<ProviderProfile> {
    this.record('getProfile', input);
    return {
      providerPersonId: input.providerPersonId,
      name: 'Fake Person',
      headline: 'Exists only in your dev database',
      profileUrl: null,
      alreadyConnected: this.connectedTo.has(input.providerPersonId),
      isSelf: false,
    };
  }

  async getAccountHealth(input: { providerAccountId: string }): Promise<AccountHealth> {
    this.record('getAccountHealth', input);
    return this.health;
  }

  /** Invites the fake platform still considers pending. */
  pendingInvitations: string[] = [];

  async listSentInvitations(input: {
    providerAccountId: string;
    limit: number;
  }): Promise<PendingInvitation[]> {
    this.record('listSentInvitations', input);
    return this.pendingInvitations.map((providerPersonId) => ({
      providerPersonId,
      invitationId: `fake-inv-${providerPersonId}`,
      sentAt: new Date(),
    }));
  }

  async searchPosts(input: SearchPostsInput): Promise<FoundPost[]> {
    this.record('searchPosts', input);
    return [
      {
        urn: `urn:fake:post:found-${input.keyword.replace(/\s+/g, '-')}`,
        text: `A fake post about ${input.keyword} that exists only in your dev database.`,
        authorName: 'Robin Vale',
        authorHeadline: 'Building things',
        authorProviderId: 'fake-person-3',
        reactions: 42,
        comments: 7,
        postedAt: new Date(),
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:fake/',
        authorPublicIdentifier: 'example-robin',
      },
    ];
  }

  async getPostComments(input: {
    providerAccountId: string;
    postUrn: string;
    limit: number;
    commentId?: string;
  }): Promise<ExistingComment[]> {
    this.record('getPostComments', input);
    if (input.commentId) {
      // Replies to one of our comments: one stranger, one already-connected
      // person, and ourselves — so the filters have something to filter.
      return [
        {
          authorName: 'Replying Stranger',
          authorHeadline: 'Someone worth knowing',
          text: 'A reply to your comment.',
          reactions: 1,
          authorProviderId: 'fake-person-4',
          alreadyConnected: false,
        },
        {
          authorName: 'Old Friend',
          authorHeadline: 'Already connected',
          text: 'Another reply.',
          reactions: 0,
          authorProviderId: 'fake-person-5',
          alreadyConnected: true,
        },
      ];
    }
    return [
      {
        authorName: 'Existing Commenter',
        authorHeadline: 'Somebody who got there first',
        text: 'A comment that already exists on this post.',
        reactions: 3,
        authorProviderId: 'fake-person-9',
        alreadyConnected: false,
      },
    ];
  }

  async postComment(input: PostCommentInput): Promise<PostCommentResult> {
    this.record('postComment', input);
    return { providerCommentId: `fake-comment-${++seq}`, postedAt: new Date() };
  }
}
