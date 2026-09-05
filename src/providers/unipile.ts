/**
 * Unipile adapter. This is the ONLY file in the repository that knows Unipile
 * exists. Nothing above it imports it, references its response shapes, or
 * branches on its status codes — see invariant 2 in CLAUDE.md.
 *
 * Its whole job is: speak HTTP to Unipile, and translate every possible
 * outcome into either a `SocialProvider` result or a `ProviderError` carrying
 * one of our six `FailureClass` values. The classification is the important
 * part. Getting it wrong means we retry into a checkpoint, which is how
 * accounts get restricted.
 *
 * DB-free. No limits here — pacing is policy.ts's job.
 */

import crypto from 'node:crypto';
import { ProviderError } from '../provider.js';
import type {
  AccountHealth,
  AccountOwner,
  ConnectableAccount,
  PendingInvitation,
  ExistingComment,
  FoundPost,
  InboundEvent,
  PostCommentInput,
  PostCommentResult,
  SearchPostsInput,
  ProviderProfile,
  WebhookAdapter,
  ListEngagersInput,
  ListEngagersResult,
  PublishPostInput,
  PublishPostResult,
  SendInviteInput,
  SendInviteResult,
  SocialProvider,
} from '../provider.js';
import type { Person } from '../types.js';

export interface UnipileConfig {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/* --- Wire shapes. These names never escape this file. ------------------ */

interface UnipilePostResponse {
  object?: string;
  post_id?: string;
  id?: string;
  /** The activity URN. Present on reads; absent from the create response. */
  social_id?: string;
  date?: string;
}

interface UnipileProfileResponse extends UnipileUser {
  is_relationship?: boolean;
  is_self?: boolean;
  network_distance?: string;
}

interface UnipileUser {
  provider_id?: string;
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  profile_url?: string;
  public_identifier?: string;
}

interface UnipileReaction {
  user?: UnipileUser;
  author?: UnipileUser;
  date?: string;
}

interface UnipileComment {
  user?: UnipileUser;
  author?: UnipileUser;
  text?: string;
  date?: string;
}

interface UnipileList<T> {
  items?: T[];
  cursor?: string | null;
}

interface UnipileInviteResponse {
  invitation_id?: string;
  id?: string;
}

interface UnipileAccountResponse {
  status?: string;
  sources?: { status?: string }[];
}

interface UnipileSearchItem {
  type?: string;
  id?: string;
  social_id?: string;
  share_url?: string;
  text?: string;
  reaction_counter?: number;
  comment_counter?: number;
  parsed_datetime?: string;
  author?: UnipileUser & { name?: string; headline?: string };
}

/**
 * Comment shape from the platform. Note `author` is a bare NAME STRING here,
 * not an object — unlike every other endpoint, where the author is nested.
 * Reading it as an object yields undefined and every comment looks anonymous.
 */
interface UnipileExistingComment {
  id?: string;
  text?: string;
  author?: string;
  author_details?: {
    headline?: string;
    id?: string;
    network_distance?: string;
  };
  reaction_counter?: number;
}

interface UnipileCommentResponse {
  id?: string;
  comment_id?: string;
  date?: string;
}

interface UnipileOwnProfile extends UnipileUser {
  occupation?: string;
  premium?: boolean | null;
  recruiter?: unknown;
  sales_navigator?: unknown;
}

interface UnipileSentInvitation {
  id?: string;
  invited_user_id?: string;
  parsed_datetime?: string;
  date?: string;
}

interface UnipileAccountListItem {
  id?: string;
  name?: string;
  username?: string;
  type?: string;
  status?: string;
  sources?: { status?: string }[];
}

/**
 * Normalise a LinkedIn post identifier to its activity URN.
 *
 * `POST /posts` returns a bare numeric id, but the read endpoints do not all
 * accept it: `/comments` rejects it with 400 `invalid post_id`, while
 * `/reactions` and the single-post GET happen to take either. Storing the bare
 * id therefore produces a post that publishes fine and then cannot have its
 * engagers pulled — which looks like a broken engagers endpoint rather than a
 * wrong identifier. Normalise once, here, at the seam.
 */
export function toPostUrn(id: string): string {
  return /^\d+$/.test(id.trim()) ? `urn:li:activity:${id.trim()}` : id.trim();
}

/* --- Error translation ------------------------------------------------- */

/**
 * Map an HTTP response to a FailureClass.
 *
 * The subtle cases:
 *  - 401/403 from Unipile itself is *our* API key being wrong (auth), but a
 *    403 describing the LinkedIn session is the user's session (auth too, but
 *    it needs a reconnect not a redeploy — both stop sending, so one class).
 *  - Unipile surfaces LinkedIn checkpoints as 422/`checkpoint` in the body,
 *    NOT as an HTTP status. Reading only the status code here would classify
 *    a checkpoint as `invalid`, we would fail the single action, and the next
 *    queued invite would walk straight back into it.
 *  - 429 is rate_limited. Anything 5xx is transient.
 */
function classify(status: number, bodyText: string): {
  failureClass: ProviderError['failureClass'];
  retryAfterMs: number | null;
} {
  const body = bodyText.toLowerCase();

  if (
    body.includes('checkpoint') ||
    body.includes('captcha') ||
    body.includes('verification required') ||
    body.includes('security challenge')
  ) {
    return { failureClass: 'checkpoint', retryAfterMs: null };
  }

  // The vendor's own error `type` is more informative than the status code.
  // `cannot_resend_yet` in particular arrives as a 422, which by status alone
  // would look like a permanently bad request — so the action would fail for
  // good AND the account would not be cooled down, walking the next invite
  // straight into the same limit.
  if (body.includes('cannot_resend_yet') || body.includes('temporary provider limit')) {
    return { failureClass: 'rate_limited', retryAfterMs: null };
  }
  if (body.includes('invalid_recipient') || body.includes('cannot be invited')) {
    return { failureClass: 'invalid', retryAfterMs: null };
  }
  if (body.includes('errors/unexpected_error')) {
    return { failureClass: 'transient', retryAfterMs: null };
  }

  if (status === 429) return { failureClass: 'rate_limited', retryAfterMs: null };
  if (status === 401 || status === 403) return { failureClass: 'auth', retryAfterMs: null };
  if (status === 408 || status >= 500) return { failureClass: 'transient', retryAfterMs: null };

  if (status === 422 || status === 400 || status === 404 || status === 409) {
    // "already invited", "already connected", "no such profile" — the action
    // is unrepeatable but the account is healthy.
    return { failureClass: 'invalid', retryAfterMs: null };
  }

  return { failureClass: 'permanent', retryAfterMs: null };
}

function retryAfterFromHeaders(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function personFrom(u: UnipileUser | undefined): Omit<Person, 'id' | 'accountId'> | null {
  if (!u) return null;
  const providerPersonId = u.provider_id ?? u.id;
  if (!providerPersonId) return null;
  const name =
    u.name ??
    [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ??
    'Unknown';
  return {
    providerPersonId,
    name: name || 'Unknown',
    headline: u.headline ?? null,
    profileUrl:
      u.profile_url ??
      (u.public_identifier ? `https://www.linkedin.com/in/${u.public_identifier}` : null),
  };
}

/**
 * Unipile account status -> our AccountStatus.
 *
 * The live API reports OK / CONNECTING / CREDENTIALS / STOPPED, plus the
 * checkpoint variants. Anything we do not recognise maps to `disconnected`,
 * NOT to `active`: an unknown status is not evidence that the account is
 * healthy, and defaulting to healthy means we keep sending into it.
 */
export function mapAccountStatus(raw: string): AccountHealth {
  switch (raw.toUpperCase()) {
    case 'OK':
    case 'CONNECTED':
      return { status: 'active', reason: null };

    case 'CREDENTIALS':
    case 'DISCONNECTED':
      return { status: 'disconnected', reason: 'The LinkedIn session is no longer valid.' };

    case 'CONNECTING':
      // Mid-handshake. Not an error, but not sendable either.
      return { status: 'disconnected', reason: 'This account is still connecting.' };

    case 'STOPPED':
      return {
        status: 'disconnected',
        reason: 'Syncing for this account is stopped. Re-enable it in Unipile.',
      };

    case 'CHECKPOINT':
    case 'IN_APP_VALIDATION':
    case 'CAPTCHA':
    case '2FA':
      return { status: 'checkpointed', reason: 'LinkedIn is asking you to verify this account.' };

    case 'PERMISSIONS':
    case 'BLOCKED':
      return { status: 'restricted', reason: 'LinkedIn has restricted this account.' };

    case '':
      return { status: 'disconnected', reason: 'The provider reported no status.' };

    default:
      return { status: 'disconnected', reason: `Unrecognised account status: ${raw}` };
  }
}

/* --- Adapter ----------------------------------------------------------- */

export class UnipileProvider implements SocialProvider {
  readonly name = 'unipile';

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: UnipileConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string | undefined> },
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Some endpoints take multipart/form-data rather than JSON — /posts is one,
    // because it shares a handler with attachment upload. When the caller hands
    // us a FormData we must NOT set content-type ourselves: fetch generates the
    // multipart boundary and an explicit header would clobber it.
    const isForm = init.body instanceof FormData;

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: init.method,
        headers: {
          'X-API-KEY': this.apiKey,
          accept: 'application/json',
          ...(init.body === undefined || isForm
            ? {}
            : { 'content-type': 'application/json' }),
        },
        body:
          init.body === undefined
            ? undefined
            : isForm
              ? (init.body as FormData)
              : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (cause) {
      // Network failure or timeout. Always transient — we have no evidence the
      // platform did anything, and the request may even have landed.
      throw new ProviderError(
        `Network error calling provider: ${(cause as Error).message}`,
        'transient',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();

    if (!res.ok) {
      const { failureClass } = classify(res.status, text);
      throw new ProviderError(
        `Provider returned ${res.status}: ${text.slice(0, 500)}`,
        failureClass,
        {
          providerCode: String(res.status),
          retryAfterMs: retryAfterFromHeaders(res.headers),
        },
      );
    }

    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError('Provider returned a non-JSON body', 'transient');
    }
  }

  async publishPost(input: PublishPostInput): Promise<PublishPostResult> {
    // multipart/form-data, not JSON. Sending JSON here returns a 400 whose
    // body describes an attachment-upload schema, which reads like a bug in
    // our payload rather than the wrong content type.
    const form = new FormData();
    form.append('account_id', input.providerAccountId);
    form.append('text', input.text);

    const res = await this.request<UnipilePostResponse>('/api/v1/posts', {
      method: 'POST',
      body: form,
    });
    const rawId = res.social_id ?? res.post_id ?? res.id;
    if (!rawId) {
      throw new ProviderError('Provider accepted the post but returned no id', 'transient');
    }
    return {
      urn: toPostUrn(rawId),
      publishedAt: res.date ? new Date(res.date) : new Date(),
    };
  }

  async listEngagers(input: ListEngagersInput): Promise<ListEngagersResult> {
    // Rows written before the identifier fix hold a bare numeric id.
    const postUrn = toPostUrn(input.postUrn);

    const [reactions, comments] = await Promise.all([
      this.request<UnipileList<UnipileReaction>>(
        `/api/v1/posts/${encodeURIComponent(postUrn)}/reactions`,
        { method: 'GET', query: { account_id: input.providerAccountId, limit: '100' } },
      ),
      this.request<UnipileList<UnipileComment>>(
        `/api/v1/posts/${encodeURIComponent(postUrn)}/comments`,
        { method: 'GET', query: { account_id: input.providerAccountId, limit: '100' } },
      ),
    ]);

    const people = new Map<string, Omit<Person, 'id' | 'accountId'>>();
    const engagements: ListEngagersResult['engagements'] = [];

    for (const r of reactions.items ?? []) {
      const p = personFrom(r.user ?? r.author);
      if (!p) continue;
      people.set(p.providerPersonId, p);
      engagements.push({
        providerPersonId: p.providerPersonId,
        postUrn,
        kind: 'reaction',
        commentText: null,
        occurredAt: r.date ? new Date(r.date) : new Date(),
      });
    }

    for (const c of comments.items ?? []) {
      const p = personFrom(c.user ?? c.author);
      if (!p) continue;
      people.set(p.providerPersonId, p);
      engagements.push({
        providerPersonId: p.providerPersonId,
        postUrn,
        kind: 'comment',
        commentText: c.text ?? null,
        occurredAt: c.date ? new Date(c.date) : new Date(),
      });
    }

    return { people: [...people.values()], engagements };
  }

  async sendInvite(input: SendInviteInput): Promise<SendInviteResult> {
    const res = await this.request<UnipileInviteResponse>('/api/v1/users/invite', {
      method: 'POST',
      body: {
        account_id: input.providerAccountId,
        provider_id: input.providerPersonId,
        ...(input.note ? { message: input.note } : {}),
      },
    });
    return {
      providerInviteId: res.invitation_id ?? res.id ?? 'unknown',
      sentAt: new Date(),
    };
  }

  async getProfile(input: {
    providerAccountId: string;
    providerPersonId: string;
  }): Promise<ProviderProfile> {
    const res = await this.request<UnipileProfileResponse>(
      `/api/v1/users/${encodeURIComponent(input.providerPersonId)}`,
      { method: 'GET', query: { account_id: input.providerAccountId } },
    );
    const person = personFrom({ ...res, provider_id: res.provider_id ?? input.providerPersonId });
    if (!person) throw new ProviderError('Profile not found', 'invalid');

    return {
      ...person,
      // Either signal is enough. `network_distance` is the one LinkedIn's own
      // UI uses; `is_relationship` is Unipile's boolean over the same fact.
      alreadyConnected:
        res.is_relationship === true ||
        (res.network_distance ?? '').toUpperCase() === 'FIRST_DEGREE',
      isSelf: res.is_self === true,
    };
  }

  async getAccountHealth(input: { providerAccountId: string }): Promise<AccountHealth> {
    const res = await this.request<UnipileAccountResponse>(
      `/api/v1/accounts/${encodeURIComponent(input.providerAccountId)}`,
      { method: 'GET' },
    );
    return mapAccountStatus(res.sources?.[0]?.status ?? res.status ?? '');
  }

  /**
   * Keyword search over other people's posts.
   *
   * `date_posted` accepts only past_day / past_week / past_month — there is no
   * precise cutoff — and `sort_by: relevance` beats `date`, which returns a
   * firehose of low-engagement posts.
   */
  async searchPosts(input: SearchPostsInput): Promise<FoundPost[]> {
    const res = await this.request<UnipileList<UnipileSearchItem>>(
      '/api/v1/linkedin/search',
      {
        method: 'POST',
        query: { account_id: input.providerAccountId, limit: String(input.limit) },
        body: {
          api: 'classic',
          category: 'posts',
          keywords: input.keyword,
          sort_by: 'relevance',
          date_posted: `past_${input.window}`,
        },
      },
    );

    const out: FoundPost[] = [];
    for (const item of res.items ?? []) {
      // Search returns ugcPost URNs; publishing returns activity URNs. Both
      // are normalised so the rest of the product sees one shape.
      const urn = item.social_id ?? (item.id ? toPostUrn(item.id) : null);
      if (!urn || !item.text) continue;
      const a = item.author ?? {};
      out.push({
        urn,
        text: item.text,
        authorName: a.name ?? 'Unknown',
        authorHeadline: a.headline ?? null,
        authorProviderId: a.provider_id ?? a.id ?? null,
        reactions: item.reaction_counter ?? 0,
        comments: item.comment_counter ?? 0,
        postedAt: item.parsed_datetime ? new Date(item.parsed_datetime) : null,
        postUrl: item.share_url ?? `https://www.linkedin.com/feed/update/${urn}/`,
        authorPublicIdentifier: a.public_identifier ?? null,
      });
    }
    return out;
  }

  async getPostComments(input: {
    providerAccountId: string;
    postUrn: string;
    limit: number;
    commentId?: string;
  }): Promise<ExistingComment[]> {
    // Passing comment_id switches this from "top-level comments on the post"
    // to "replies to that one comment".
    const res = await this.request<UnipileList<UnipileExistingComment>>(
      `/api/v1/posts/${encodeURIComponent(toPostUrn(input.postUrn))}/comments`,
      {
        method: 'GET',
        query: {
          account_id: input.providerAccountId,
          limit: String(input.limit),
          ...(input.commentId ? { comment_id: input.commentId } : {}),
        },
      },
    );
    return (res.items ?? [])
      .filter((c) => (c.text ?? '').trim() !== '')
      .map((c) => ({
        authorName: c.author ?? 'Unknown',
        authorHeadline: c.author_details?.headline ?? null,
        text: (c.text ?? '').trim(),
        reactions: c.reaction_counter ?? 0,
        authorProviderId: c.author_details?.id ?? null,
        // DISTANCE_1 / FIRST_DEGREE both appear depending on endpoint.
        alreadyConnected: /FIRST_DEGREE|DISTANCE_1/i.test(
          c.author_details?.network_distance ?? '',
        ),
      }));
  }

  async postComment(input: PostCommentInput): Promise<PostCommentResult> {
    // Documented as multipart/form-data, with `account_id` in the BODY — not
    // the query string, unlike the GET on the same path. JSON happens to be
    // accepted too, but we send what the contract says.
    //
    // `comment_id` turns this into a reply to an existing comment rather than
    // a new top-level comment on the post.
    const form = new FormData();
    form.append('account_id', input.providerAccountId);
    form.append('text', input.text);
    if (input.replyToCommentId) form.append('comment_id', input.replyToCommentId);

    const res = await this.request<UnipileCommentResponse>(
      `/api/v1/posts/${encodeURIComponent(toPostUrn(input.postUrn))}/comments`,
      { method: 'POST', body: form },
    );
    return {
      providerCommentId: res.comment_id ?? res.id ?? 'unknown',
      postedAt: res.date ? new Date(res.date) : new Date(),
    };
  }

  /**
   * Who this connected account belongs to. Setup-time only; the running
   * product never asks. Kept off the SocialProvider interface so the runtime
   * seam stays at five methods.
   */
  async getAccountOwner(providerAccountId: string): Promise<AccountOwner> {
    const res = await this.request<UnipileOwnProfile>('/api/v1/users/me', {
      method: 'GET',
      query: { account_id: providerAccountId },
    });
    const person = personFrom(res);
    if (!person) throw new ProviderError('Could not read the account owner', 'invalid');
    return {
      ...person,
      // `occupation` is what the platform calls the headline on your own
      // profile; every other endpoint calls it `headline`.
      headline: res.occupation ?? person.headline,
      isPremium: typeof res.premium === 'boolean' ? res.premium : null,
    };
  }

  async listSentInvitations(input: {
    providerAccountId: string;
    limit: number;
  }): Promise<PendingInvitation[]> {
    const res = await this.request<UnipileList<UnipileSentInvitation>>(
      '/api/v1/users/invite/sent',
      {
        method: 'GET',
        query: {
          account_id: input.providerAccountId,
          // The platform caps this at 100 and rejects anything larger.
          limit: String(Math.min(100, Math.max(1, input.limit))),
        },
      },
    );
    return (res.items ?? [])
      .filter((i) => typeof i.invited_user_id === 'string')
      .map((i) => ({
        providerPersonId: i.invited_user_id as string,
        invitationId: i.id ?? null,
        sentAt: i.parsed_datetime ? new Date(i.parsed_datetime) : null,
      }));
  }

  /**
   * Every account this API key can act on. Setup-time only — used by the
   * connect script to find a freshly linked account. Returns our own shape so
   * the script never sees a Unipile response.
   */
  async listConnectableAccounts(): Promise<ConnectableAccount[]> {
    const res = await this.request<UnipileList<UnipileAccountListItem>>('/api/v1/accounts', {
      method: 'GET',
    });
    return (res.items ?? []).map((item) => ({
      providerAccountId: item.id ?? '',
      displayName: item.name ?? item.username ?? 'LinkedIn account',
      network: (item.type ?? 'UNKNOWN').toUpperCase(),
      health: mapAccountStatus(item.sources?.[0]?.status ?? item.status ?? ''),
    }));
  }
}


/* --- Webhooks ---------------------------------------------------------- *
 * Inbound events. Same rule as everything else here: the vendor's JSON is
 * translated into our InboundEvent union and never escapes this file.
 * -------------------------------------------------------------------- */

interface UnipileWebhookBody {
  event?: string;
  type?: string;
  event_id?: string;
  account_id?: string;
  status?: string;
  message?: string;
  date?: string;
  user_provider_id?: string;
  user?: UnipileUser;
  post_id?: string;
}

export const unipileWebhooks: WebhookAdapter = {
  /**
   * HMAC-SHA256 over the raw body. It must be the RAW bytes: re-serialising
   * parsed JSON reorders keys and changes whitespace, and the signature stops
   * matching for reasons that look like a key problem and are not.
   */
  verify(rawBody, signatureHeader, secret) {
    if (!signatureHeader) return false;
    const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const provided = signatureHeader.replace(/^sha256=/i, '').trim();

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    // timingSafeEqual throws on length mismatch, so check length first — and
    // return false rather than letting the throw become a 500.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  },

  parse(rawBody): InboundEvent {
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    let body: UnipileWebhookBody;
    try {
      body = JSON.parse(text) as UnipileWebhookBody;
    } catch {
      return { type: 'unknown', name: 'unparseable', eventId: null };
    }

    const name = (body.event ?? body.type ?? '').toLowerCase();
    const eventId = body.event_id ?? null;
    const providerAccountId = body.account_id ?? '';
    const occurredAt = body.date ? new Date(body.date) : new Date();

    if (name.includes('relation') || name.includes('invitation_accepted') || name.includes('new_relation')) {
      const providerPersonId = body.user_provider_id ?? body.user?.provider_id ?? body.user?.id;
      if (!providerAccountId || !providerPersonId) {
        return { type: 'unknown', name, eventId };
      }
      return { type: 'invite_accepted', providerAccountId, providerPersonId, occurredAt, eventId };
    }

    if (name.includes('account_status') || name.includes('credentials') || name.includes('checkpoint')) {
      const raw = (body.status ?? '').toUpperCase();
      const status =
        raw === 'OK' || raw === 'CONNECTED'
          ? 'active'
          : raw === 'CHECKPOINT' || raw === 'IN_APP_VALIDATION' || raw === 'CAPTCHA' || raw === '2FA'
            ? 'checkpointed'
            : raw === 'BLOCKED' || raw === 'PERMISSIONS'
              ? 'restricted'
              : 'disconnected';
      return {
        type: 'account_status',
        providerAccountId,
        status,
        reason: body.message ?? null,
        eventId,
      };
    }

    if (name.includes('post') && body.post_id) {
      return { type: 'post_published', providerAccountId, urn: body.post_id, eventId };
    }

    return { type: 'unknown', name, eventId };
  },
};
