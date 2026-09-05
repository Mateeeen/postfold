/**
 * The grounding check is the guardrail between "model wrote something
 * specific" and "model invented a fact and published it under the user's
 * name". It has to reject inventions without rejecting honest paraphrase.
 */

import { describe, expect, it } from 'vitest';
import { GroqLlm, groundedIn } from '../src/llm/groq.js';
import { FakeLlm } from '../src/llm/fake.js';

const POST =
  'Someone just open-sourced a UI/UX skill with 124K GitHub stars. It gives ' +
  'Claude Code, Cursor and other AI tools a real design system to work from ' +
  'instead of guessing at spacing and colour.';

describe('groundedIn', () => {
  it('accepts a verbatim quote', () => {
    expect(groundedIn('instead of guessing at spacing and colour', POST)).toBe(true);
  });

  it('accepts a quote the model re-typed with different punctuation', () => {
    // Models routinely swap in smart quotes and collapse whitespace.
    expect(groundedIn('“a real design system  to work from”', POST)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(groundedIn('OPEN-SOURCED A UI/UX SKILL', POST)).toBe(true);
  });

  it('rejects an invented claim', () => {
    // The exact hallucination this guardrail was written for.
    expect(
      groundedIn("the model currently can't resolve hierarchical references", POST),
    ).toBe(false);
  });

  it('rejects a quote that borrows only scattered words', () => {
    expect(groundedIn('design tools spacing benchmark latency', POST)).toBe(false);
  });

  it('rejects empty input on either side', () => {
    expect(groundedIn('', POST)).toBe(false);
    expect(groundedIn('anything', '')).toBe(false);
  });

  it('requires a short quote to match outright', () => {
    expect(groundedIn('design system', POST)).toBe(true);
    expect(groundedIn('kubernetes', POST)).toBe(false);
  });

  it('matches a four-word run anywhere in a longer quote', () => {
    expect(
      groundedIn('as the author notes it gives Claude Code Cursor and other tools power', POST),
    ).toBe(true);
  });
});

describe('FakeLlm', () => {
  const author = { name: 'Test User', headline: 'Engineer | Node | React', recentPosts: [] };
  const post = {
    text: 'A post.',
    authorName: 'Someone Else',
    authorHeadline: null,
    reactions: 1,
    comments: 0,
    keyword: 'testing',
    priorComments: [],
  };
  const silent = { log: () => {} };

  it('drafts without a network call', async () => {
    const llm = new FakeLlm(silent);
    const c = await llm.draftComment({ author, post, maxChars: 200 });
    expect(c.worthCommenting).toBe(true);
    expect(c.text.length).toBeGreaterThan(0);
    expect(llm.calls.map((x) => x.method)).toEqual(['draftComment']);
  });

  it('can decline, so the skip path is testable', async () => {
    const llm = new FakeLlm({ ...silent, declineComments: true });
    const c = await llm.draftComment({ author, post, maxChars: 200 });
    expect(c.worthCommenting).toBe(false);
    expect(c.text).toBe('');
  });

  it('respects the comment length cap', async () => {
    const llm = new FakeLlm(silent);
    const c = await llm.draftComment({ author, post, maxChars: 12 });
    expect(c.text.length).toBeLessThanOrEqual(12);
  });

  it('derives keywords from the headline', async () => {
    const llm = new FakeLlm(silent);
    const k = await llm.suggestKeywords({ author });
    expect(k.map((x) => x.term)).toContain('Node');
  });
});

/* ================================================================== *
 * Prompt contents
 *
 * The comments already under a post were fetched, passed through
 * toSourcePost, and then never rendered into the prompt - so the drafter
 * had no idea what the thread had already said. These assert on the bytes
 * actually sent, because that is the only place the bug was visible.
 * ================================================================== */

describe('draftComment prompt', () => {
  function capturing(): { llm: GroqLlm; sent: () => string } {
    let body = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '');
      const envelope = JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                worth_commenting: false,
                rationale: 'not under test',
              }),
            },
          },
        ],
      });
      return {
        ok: true,
        status: 200,
        // The client reads the body as text and parses it itself, so a json()
        // stub alone is never called.
        async text() {
          return envelope;
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    return {
      llm: new GroqLlm({
        baseUrl: 'https://example.invalid',
        apiKey: 'k',
        model: 'test-model',
        fetchImpl,
      }),
      sent: () => body,
    };
  }

  const author = { name: 'Test Creator', headline: 'Engineer', recentPosts: [] };
  const basePost = {
    text: 'We rewrote the scheduler and latency went down.',
    authorName: 'Someone Else',
    authorHeadline: null,
    reactions: 10,
    comments: 2,
    keyword: 'scheduling',
  };

  it('includes the comments already under the post', async () => {
    const { llm, sent } = capturing();
    await llm.draftComment({
      author,
      post: {
        ...basePost,
        priorComments: [
          {
            authorName: 'Prior Person',
            authorHeadline: 'SRE',
            text: 'Did you measure tail latency or just the mean?',
            reactions: 3,
          },
        ],
      },
      maxChars: 400,
    });

    const body = sent();
    expect(body).toContain('Prior Person');
    expect(body).toContain('Did you measure tail latency');
    expect(body).toContain('Do not repeat a point made above');
  });

  it('says nothing about a thread when there are no comments', async () => {
    const { llm, sent } = capturing();
    await llm.draftComment({
      author,
      post: { ...basePost, priorComments: [] },
      maxChars: 400,
    });

    expect(sent()).not.toContain('Already said under this post');
  });
});
