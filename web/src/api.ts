/**
 * Thin API client.
 *
 * The only thing worth knowing here: a 409 carries a reason string from
 * policy.ts, written to be read by a human. It is shown verbatim. Do not
 * rewrite it, do not map it to a friendlier message, do not turn it into a
 * code — the whole point is that the user finds out why their account is being
 * held back.
 */

export class ApiError extends Error {
  readonly status: number;
  /** Present on 409. The queue refused, and this is why. */
  readonly reason: string | null;

  constructor(status: number, message: string, reason: string | null) {
    super(message);
    this.status = status;
    this.reason = reason;
  }

  get refused(): boolean {
    return this.status === 409;
  }
}

/**
 * Where the API lives. Empty when the API serves this bundle itself (local
 * `npm run dev`); an absolute URL when the frontend is hosted separately —
 * Vercel serving the UI, Railway running the API and the worker.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

const TOKEN_KEY = 'postfold.token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing; the token simply will not persist */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const record = (body ?? {}) as { error?: string; reason?: string };
    throw new ApiError(
      res.status,
      record.error ?? `Request failed (${res.status})`,
      record.reason ?? null,
    );
  }
  return body as T;
}

/* --- Shapes ----------------------------------------------------------- */

export type ActionKind =
  | 'send_invite'
  | 'create_post'
  | 'sync_engagers'
  | 'post_comment'
  | 'sync_trends';

export interface CapView {
  cap: number;
  remaining: number;
  allowed: boolean;
  reason: string | null;
}

export interface AccountState {
  id: string;
  displayName: string;
  status: 'active' | 'paused' | 'checkpointed' | 'restricted' | 'disconnected';
  sendingEnabled: boolean;
  pausedReason: string | null;
  timezone: string;
  windowStartHour: number;
  windowEndHour: number;
  warmupDay: number;
  warmupCap: number;
  caps: Record<ActionKind, CapView>;
  acceptance: {
    rate: number | null;
    accepted: number;
    sample: number;
    band: 'unrated' | 'healthy' | 'watch' | 'throttled' | 'critical';
    rated: boolean;
  };
  isPremium: boolean | null;
  /** Note-bearing invites left this month. At 0, invites send without a note. */
  notesRemaining: number;
  noteAllowance: number;
  nextScheduledAt: string | null;
  checkpointUntil: string | null;
}

export interface SuggestionCard {
  id: string;
  score: number;
  reason: string;
  draftNote: string;
  engagementKind: 'comment' | 'reaction';
  commentText: string | null;
  person: { id: string; name: string; headline: string | null; profileUrl: string | null };
}

export interface QueueItem {
  id: string;
  kind: ActionKind;
  status: 'pending' | 'in_flight' | 'done' | 'failed' | 'cancelled';
  scheduledAt: string;
  completedAt: string | null;
  attempts: number;
  lastError: string | null;
  label: string;
  note?: string;
  preview?: string;
  person?: { name: string; headline: string | null } | null;
}

export interface DraftSourcePost {
  urn: string;
  text: string;
  authorName: string;
  authorHeadline: string | null;
  reactions: number;
  comments: number;
  keyword: string;
  /** Canonical link to the real post. Always present. */
  postUrl: string;
  authorUrl: string | null;
}

export interface DraftCard {
  id: string;
  kind: 'post' | 'comment';
  text: string;
  rationale: string;
  model: string | null;
  createdAt: string;
  /** When this publishes itself. Null means it waits for a human. */
  autoApproveAt: string | null;
  sourcePost: DraftSourcePost | null;
}

export interface LastSearch {
  at: string;
  keywords: number;
  postsFound: number;
  drafted: number;
  declined: number;
  error: string | null;
}

export interface Keyword {
  id: string;
  term: string;
  source: 'user' | 'derived';
  enabled: boolean;
}

export interface PostRow {
  id: string;
  urn: string | null;
  text: string;
  status: string;
  publishedAt: string | null;
}

/* --- Calls ------------------------------------------------------------ */

export const api = {
  config: () =>
    request<{
      foldCharLimit: number;
      foldLineLimit: number;
      noteLimit: number;
      hardDailyInviteCap: number;
    }>('/api/config'),

  account: () => request<AccountState>('/api/accounts/default'),

  pause: (id: string, reason: string) =>
    request<AccountState>(`/api/accounts/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  resume: (id: string) =>
    request<AccountState>(`/api/accounts/${id}/resume`, { method: 'POST' }),

  posts: () => request<PostRow[]>('/api/posts'),

  createPost: (text: string) =>
    request<{ post: PostRow }>('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  syncEngagers: (urn: string) =>
    request<unknown>(`/api/posts/${encodeURIComponent(urn)}/sync-engagers`, { method: 'POST' }),

  suggestions: () =>
    request<{ account: AccountState; suggestions: SuggestionCard[]; noteLimit: number }>(
      '/api/suggestions',
    ),

  approve: (id: string, note: string) =>
    request<{
      action: { id: string; scheduledAt: string };
      withNote: boolean;
      account: AccountState;
    }>(`/api/suggestions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  dismiss: (id: string) =>
    request<{ ok: true }>(`/api/suggestions/${id}/dismiss`, { method: 'POST' }),

  queue: () =>
    request<{ account: AccountState; pending: QueueItem[]; recent: QueueItem[] }>('/api/queue'),

  cancel: (id: string) => request<{ ok: true }>(`/api/queue/${id}`, { method: 'DELETE' }),

  drafts: () =>
    request<{
      account: AccountState;
      drafts: DraftCard[];
      commentLimit: number;
      foldCharLimit: number;
      lastSearch: LastSearch | null;
      searchPending: boolean;
    }>('/api/drafts'),

  approveDraft: (id: string, text: string) =>
    request<{ action: { id: string; scheduledAt: string } }>(`/api/drafts/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  dismissDraft: (id: string) =>
    request<{ ok: true }>(`/api/drafts/${id}/dismiss`, { method: 'POST' }),

  keywords: () =>
    request<{ keywords: Keyword[]; pendingDrafts: number }>('/api/keywords'),

  addKeyword: (term: string) =>
    request<{ keywords: Keyword[] }>('/api/keywords', {
      method: 'POST',
      body: JSON.stringify({ term }),
    }),

  suggestKeywords: () =>
    request<{ added: string[]; keywords: Keyword[] }>('/api/keywords/suggest', {
      method: 'POST',
    }),

  toggleKeyword: (id: string, enabled: boolean) =>
    request<{ keywords: Keyword[] }>(`/api/keywords/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  deleteKeyword: (id: string) =>
    request<{ keywords: Keyword[] }>(`/api/keywords/${id}`, { method: 'DELETE' }),

  syncTrends: () =>
    request<{ action: { id: string; scheduledAt: string } }>('/api/trends/sync', {
      method: 'POST',
    }),
};
