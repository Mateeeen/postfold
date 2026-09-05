/**
 * The seam between PostFold and whatever model writes text.
 *
 * Same shape as provider.ts, for the same reason: nothing above this file
 * names a model vendor, knows its request format, or branches on its errors.
 * Today that adapter is Grok; swapping it for Claude, or running both, is one
 * file in src/llm/ and one line in src/llm/index.ts.
 *
 * DB-free, vendor-free. No limits — caps live in policy.ts.
 */

/** Everything the drafter knows about the person it is writing as. */
export interface AuthorContext {
  name: string;
  headline: string | null;
  /** A few of the user's own recent posts, so drafts sound like them and not
   *  like a language model doing "LinkedIn voice". */
  recentPosts: string[];
}

export interface KeywordSuggestion {
  term: string;
  /** Why this term was proposed, shown to the user before they keep it. */
  reason: string;
}

export interface PostDraft {
  text: string;
  /** What in the source material prompted this. Shown with the draft. */
  rationale: string;
}

export interface CommentDraft {
  text: string;
  rationale: string;
  /** False when the model judges the post a bad fit — the pipeline drops it
   *  rather than forcing a comment. A model that must always produce something
   *  produces "Great post!", which is worse than silence. */
  worthCommenting: boolean;
}

/** A comment already sitting under the post. */
export interface PriorComment {
  authorName: string;
  authorHeadline: string | null;
  text: string;
  reactions: number;
}

/** A post found by keyword search, as the drafter sees it. */
export interface SourcePost {
  text: string;
  authorName: string;
  authorHeadline: string | null;
  reactions: number;
  comments: number;
  keyword: string;
  /**
   * What people have already said here. Two jobs: stop the model repeating a
   * point that has been made, and show it the register of the thread — a post
   * whose comments are all one-liners is not a place for three paragraphs.
   */
  priorComments: PriorComment[];
}

export interface LlmProvider {
  readonly name: string;
  /** The concrete model, recorded on every draft so a bad batch is traceable. */
  readonly model: string;

  /** Propose topics to watch, from the user's own profile and posts. */
  suggestKeywords(input: { author: AuthorContext }): Promise<KeywordSuggestion[]>;

  /** Write a post riffing on what is currently landing in the user's niche. */
  draftPost(input: {
    author: AuthorContext;
    trending: SourcePost[];
    foldCharLimit: number;
  }): Promise<PostDraft>;

  /** Write a reply to one specific post. */
  draftComment(input: {
    author: AuthorContext;
    post: SourcePost;
    maxChars: number;
  }): Promise<CommentDraft>;
}

/**
 * The only error type allowed to cross the seam. Mirrors ProviderError so the
 * worker can classify LLM failures with the same taxonomy it already uses.
 */
export class LlmError extends Error {
  readonly retryable: boolean;
  readonly providerCode: string | null;

  constructor(
    message: string,
    options: { retryable?: boolean; providerCode?: string | null } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.retryable = options.retryable ?? true;
    this.providerCode = options.providerCode ?? null;
  }
}

export function isLlmError(e: unknown): e is LlmError {
  return e instanceof LlmError;
}
