/**
 * Groq adapter. The only file that knows Groq exists.
 *
 * Groq serves an OpenAI-compatible chat-completions API, so this shape ports
 * to most other hosted-inference vendors with a base URL and model change.
 * Everything crosses the seam as src/llm.ts types; nothing above names Groq.
 *
 * DB-free. No caps — those live in policy.ts.
 */

import { LlmError } from '../llm.js';
import type {
  AuthorContext,
  CommentDraft,
  KeywordSuggestion,
  LlmProvider,
  PostDraft,
  SourcePost,
} from '../llm.js';

export interface GroqConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/* --- Wire shapes. These never escape this file. ----------------------- */

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string; code?: string };
}

/* --- Prompt material -------------------------------------------------- */

/**
 * Shared voice instructions.
 *
 * The single most important line is the one about not sounding like LinkedIn:
 * an open model asked for "a LinkedIn post" reliably produces the hook-line,
 * one-sentence-paragraph, emoji-bulleted format that reads as machine-written.
 * That style is what makes automated posting obvious, so it is ruled out
 * explicitly rather than hoped away.
 */
function voiceRules(author: AuthorContext): string {
  return [
    `You are writing as ${author.name}${author.headline ? `, ${author.headline}` : ''}.`,
    '',
    'Write the way this person actually writes. Rules:',
    '- No hook-line-then-one-word-paragraph formatting. No emoji bullets. No "Here\'s the thing:".',
    '- No hashtags unless the samples below use them.',
    '- Do not open with a rhetorical question.',
    '- Say one concrete thing. Specifics over generalities; if you have no specific, say less.',
    '- British/American spelling: match the samples.',
    '- Never claim experience, numbers, or results that are not in the material given to you.',
    author.recentPosts.length > 0
      ? `\nSamples of their own writing:\n${author.recentPosts
          .slice(0, 3)
          .map((p, i) => `--- sample ${i + 1} ---\n${p.slice(0, 800)}`)
          .join('\n')}`
      : '\n(No samples available — keep it plain and short.)',
  ].join('\n');
}

/**
 * Does `quote` actually appear in `source`?
 *
 * Deliberately lenient about punctuation, casing and whitespace — models
 * re-type quotes with smart quotes and collapsed spacing — but strict about
 * the words themselves. Requires a run of at least four consecutive words
 * from the quote to appear verbatim, which a paraphrase passes and an
 * invention does not.
 */
export function groundedIn(quote: string, source: string): boolean {
  const normalise = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[‘’“”]/g, "'")
      .replace(/[^a-z0-9' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const q = normalise(quote);
  const src = normalise(source);
  if (q.length === 0 || src.length === 0) return false;

  const words = q.split(' ');
  // A quote shorter than the window has to match outright.
  if (words.length < 4) return src.includes(q);

  for (let i = 0; i + 4 <= words.length; i++) {
    if (src.includes(words.slice(i, i + 4).join(' '))) return true;
  }
  return false;
}

function describePost(p: SourcePost): string {
  return [
    `Author: ${p.authorName}${p.authorHeadline ? ` — ${p.authorHeadline}` : ''}`,
    `Engagement: ${p.reactions} reactions, ${p.comments} comments`,
    `Matched keyword: ${p.keyword}`,
    `Post:\n${p.text.slice(0, 2000)}`,
  ].join('\n');
}

/* --- Adapter ---------------------------------------------------------- */

export class GroqLlm implements LlmProvider {
  readonly name = 'groq';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: GroqConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 45_000;
  }

  /**
   * One chat call, returning parsed JSON.
   *
   * JSON mode is requested, but the response is still parsed defensively:
   * open models occasionally wrap the object in prose or a code fence even
   * when asked not to, and a hard parse failure here would fail a draft that
   * is actually fine.
   */
  private async complete<T>(system: string, user: string, maxTokens: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.7,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new LlmError(`Network error calling model: ${(cause as Error).message}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      // 429 and 5xx are worth retrying; a 400 means our prompt or model id is
      // wrong and retrying just burns credits.
      const retryable = res.status === 429 || res.status >= 500;
      throw new LlmError(`Model returned ${res.status}: ${text.slice(0, 300)}`, {
        retryable,
        providerCode: String(res.status),
      });
    }

    let body: ChatResponse;
    try {
      body = JSON.parse(text) as ChatResponse;
    } catch {
      throw new LlmError('Model returned a non-JSON envelope', { retryable: true });
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new LlmError('Model returned an empty completion', { retryable: true });

    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new LlmError(`Model output was not JSON: ${cleaned.slice(0, 200)}`, {
        retryable: true,
      });
    }

    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      throw new LlmError(`Could not parse model JSON: ${cleaned.slice(0, 200)}`, {
        retryable: true,
      });
    }
  }

  async suggestKeywords(input: { author: AuthorContext }): Promise<KeywordSuggestion[]> {
    const result = await this.complete<{ keywords?: { term?: string; reason?: string }[] }>(
      'You help someone choose search terms for monitoring their professional field. Reply with JSON only.',
      [
        `Person: ${input.author.name}`,
        `Headline: ${input.author.headline ?? '(none)'}`,
        input.author.recentPosts.length > 0
          ? `Their recent posts:\n${input.author.recentPosts.slice(0, 5).map((p) => `- ${p.slice(0, 300)}`).join('\n')}`
          : '',
        '',
        'Propose 5-8 search terms they should monitor on LinkedIn. Terms should be',
        'specific enough to return relevant posts — "AI" is too broad, "AI code review"',
        'is useful. Prefer terms their own writing suggests they care about.',
        '',
        'JSON: {"keywords":[{"term":"...","reason":"one short sentence"}]}',
      ].join('\n'),
      1000,
    );

    return (result.keywords ?? [])
      .filter((k): k is { term: string; reason?: string } => typeof k.term === 'string')
      .map((k) => ({ term: k.term.trim(), reason: k.reason?.trim() ?? '' }))
      .filter((k) => k.term.length > 0);
  }

  async draftPost(input: {
    author: AuthorContext;
    trending: SourcePost[];
    foldCharLimit: number;
  }): Promise<PostDraft> {
    const result = await this.complete<{ text?: string; rationale?: string }>(
      `${voiceRules(input.author)}\n\nReply with JSON only.`,
      [
        'These posts are getting engagement in this person\'s field right now:',
        '',
        input.trending
          .slice(0, 5)
          .map((p, i) => `--- post ${i + 1} ---\n${describePost(p)}`)
          .join('\n\n'),
        '',
        'Write ONE original LinkedIn post from this person, taking a position on what',
        'these posts are collectively about. Do not summarise them and do not reference',
        'them directly — the reader has not seen them.',
        '',
        `The first ${input.foldCharLimit} characters are all most people will read.`,
        'Land a complete thought inside that.',
        '',
        'JSON: {"text":"the post","rationale":"one sentence on why this topic, now"}',
      ].join('\n'),
      1500,
    );

    const text = (result.text ?? '').trim();
    if (!text) throw new LlmError('Model produced an empty post', { retryable: true });
    return { text, rationale: (result.rationale ?? '').trim() };
  }

  /**
   * Draft a reply to someone else's post.
   *
   * The hard problem here is invention. Asked to "add something specific" a
   * model will happily produce a confident, falsifiable claim about a tool it
   * knows nothing about — and on a stranger's post, under the user's name,
   * a wrong claim is worse than no comment.
   *
   * So the model is restricted to three moves, must declare which one it used,
   * and must quote the text it is grounded in. `groundedIn` then checks that
   * the quote actually appears in the source material. A comment that cannot
   * point at its own basis is dropped, not published.
   */
  async draftComment(input: {
    author: AuthorContext;
    post: SourcePost;
    maxChars: number;
  }): Promise<CommentDraft> {
    const result = await this.complete<{
      worth_commenting?: boolean;
      move?: string;
      grounding?: string;
      text?: string;
      rationale?: string;
    }>(
      `${voiceRules(input.author)}\n\nReply with JSON only.`,
      [
        'Someone else posted this:',
        '',
        describePost(input.post),
        '',
        'You may ONLY make one of these three moves:',
        '  "question"  — ask about something specific the post actually says',
        '  "experience" — relate something that appears in this person\'s own writing samples',
        '  "tradeoff"  — name a tradeoff that follows logically from the post\'s own content',
        '',
        'HARD RULE: do not state any fact about a tool, product, company, version,',
        'benchmark, or person that is not written in the post above or in the samples.',
        'You do not know how these tools behave. If the comment would need such a fact,',
        'the answer is worth_commenting: false.',
        '',
        'Also answer false if the post is promotional, is outside this person\'s field,',
        'or if the only available reply is agreement. Agreement is not a comment.',
        '',
        `If yes: write under ${input.maxChars} characters. Do not compliment the post,`,
        'restate it, or pitch anything.',
        '',
        '"grounding" must be a short VERBATIM quote from the post (for question/tradeoff)',
        'or from the writing samples (for experience). It is checked against the source.',
        '',
        'JSON: {"worth_commenting":true|false,"move":"question|experience|tradeoff",',
        '"grounding":"verbatim quote","text":"the comment or empty","rationale":"one sentence"}',
      ].join('\n'),
      800,
    );

    const decline = (why: string): CommentDraft => ({
      worthCommenting: false,
      text: '',
      rationale: why,
    });

    if (result.worth_commenting !== true) {
      return decline((result.rationale ?? 'Model judged this post a poor fit.').trim());
    }

    const text = (result.text ?? '').trim().slice(0, input.maxChars);
    if (!text) return decline('Model returned an empty comment.');

    const move = (result.move ?? '').trim().toLowerCase();
    if (move !== 'question' && move !== 'experience' && move !== 'tradeoff') {
      return decline(`Dropped: unrecognised move "${move}".`);
    }

    const source =
      move === 'experience' ? input.author.recentPosts.join('\n') : input.post.text;
    if (!groundedIn(result.grounding ?? '', source)) {
      // The model could not point at where its claim came from, which is the
      // signature of an invented one.
      return decline(`Dropped: "${move}" claim not grounded in the source text.`);
    }

    return { worthCommenting: true, text, rationale: (result.rationale ?? '').trim() };
  }
}
