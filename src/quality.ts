/**
 * Does this read like a person wrote it?
 *
 * Pure functions over text. No model call, no network, no database — so it can
 * be swept across a corpus of thousands of posts in a second, which is the
 * only honest way to set the thresholds.
 *
 * What this measures and what it does not: it scores whether text reads as
 * human, not whether it is TRUE. A fabricated anecdote with good rhythm and
 * specific numbers scores well here, because it is well written — it is just
 * false. Fabrication is prevented on the generation side, by not letting the
 * drafter emit specifics at all. Nothing in this file catches a lie.
 *
 * Every threshold lives in policy.ts. None here.
 */

import { LIMITS } from './policy.js';

export type QualityBand = 'strong' | 'ok' | 'weak';

export interface Signal {
  /** 0..1, or null when the text cannot support the measurement. */
  score: number | null;
  /** What drove it, for tuning and for the log. */
  detail: string;
}

export interface QualityScore {
  composite: number;
  band: QualityBand;
  signals: Record<string, Signal>;
}

/* --- Text shredding ---------------------------------------------------- */

/** Hashtags are excluded everywhere: a tag block games specificity for free. */
function stripTags(text: string): string {
  return text.replace(/#[\p{L}\p{N}_]+/gu, ' ');
}

function sentences(text: string): string[] {
  return stripTags(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function words(text: string): string[] {
  return stripTags(text)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

function lines(text: string): string[] {
  return stripTags(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** Piecewise ramp: 0 below `floor`, 1 above `ceil`, `mid` scores 0.6. */
function ramp(x: number, floor: number, mid: number, ceil: number): number {
  if (x <= floor) return 0;
  if (x >= ceil) return 1;
  if (x <= mid) return (0.6 * (x - floor)) / (mid - floor);
  return 0.6 + (0.4 * (x - mid)) / (ceil - mid);
}

/* --- Signal 1: rhythm -------------------------------------------------- */

/**
 * Variance in sentence length OR in line length, whichever is higher.
 *
 * Sentence length alone fails on the platform's dominant register:
 *
 *   I shipped it.
 *   Twice.
 *   Then I learned why that was stupid.
 *
 * That is a standard deviation near 1 — indistinguishable from machine-flat by
 * that measure alone, and it is a human writing well. Line length catches it.
 * Machine output is flat on both, so taking the better of the two costs
 * nothing in discrimination.
 */
export function rhythmSignal(text: string): Signal {
  const ss = sentences(text);
  if (ss.length < LIMITS.Q_MIN_SENTENCES) {
    return { score: null, detail: `only ${ss.length} sentences — not measurable` };
  }

  const sentenceSd = stdDev(ss.map((s) => words(s).length));
  const sentenceScore = ramp(
    sentenceSd,
    LIMITS.Q_SENTENCE_SD_FLOOR,
    LIMITS.Q_SENTENCE_SD_MID,
    LIMITS.Q_SENTENCE_SD_CEIL,
  );

  const ls = lines(text);
  const lineSd = ls.length >= LIMITS.Q_MIN_SENTENCES ? stdDev(ls.map((l) => l.length)) : 0;
  const lineScore = ramp(
    lineSd,
    LIMITS.Q_LINE_SD_FLOOR,
    LIMITS.Q_LINE_SD_MID,
    LIMITS.Q_LINE_SD_CEIL,
  );

  const best = Math.max(sentenceScore, lineScore);
  return {
    score: best,
    detail: `sentence sd ${sentenceSd.toFixed(1)} (${sentenceScore.toFixed(2)}), line sd ${lineSd.toFixed(1)} (${lineScore.toFixed(2)})`,
  };
}

/* --- Signal 2: specificity --------------------------------------------- */

const SENTENCE_START = /(?:^|[.!?]\s+|\n)\s*$/;

/** Proper nouns, numbers, dates, tool-shaped tokens, per 100 words. */
export function specificitySignal(text: string): Signal {
  const ws = words(text);
  if (ws.length === 0) return { score: 0, detail: 'empty' };

  const stripped = stripTags(text);
  let hits = 0;
  let cursor = 0;

  for (const w of ws) {
    const at = stripped.indexOf(w, cursor);
    cursor = at >= 0 ? at + w.length : cursor;
    const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (bare === '') continue;

    const hasDigit = /\d/.test(bare);
    // Capitalised, but not merely because it opened a sentence.
    const atStart = SENTENCE_START.test(stripped.slice(Math.max(0, at - 3), Math.max(0, at)));
    const proper = /^[\p{Lu}]/u.test(bare) && !atStart;
    // node_modules, PostFold, gpt-4o — shapes a generic sentence does not have.
    const toolish = /[\p{Lu}].*[\p{Lu}]/u.test(bare) || /[_/]/.test(bare) || /-\d/.test(bare);

    if (hasDigit || proper || toolish) hits++;
  }

  const per100 = (hits / ws.length) * 100;
  return {
    score: ramp(per100, LIMITS.Q_SPECIFICITY_FLOOR, LIMITS.Q_SPECIFICITY_CEIL, LIMITS.Q_SPECIFICITY_CEIL),
    detail: `${hits} specific tokens, ${per100.toFixed(1)} per 100 words`,
  };
}

/* --- Signal 3: concrete first person ------------------------------------ */

const FIRST_PERSON = /\b(i|we|my|our|me|us)\b/i;
const IRREGULAR_PAST =
  /\b(was|were|had|did|got|went|made|took|saw|found|built|broke|ran|wrote|shipped|spent|lost|kept|told|thought|came|gave|left)\b/i;

export function firstPersonSignal(text: string): Signal {
  let hits = 0;
  for (const s of sentences(text)) {
    if (!FIRST_PERSON.test(s)) continue;
    const pastTense = IRREGULAR_PAST.test(s) || /\b\p{L}+ed\b/u.test(s);
    if (!pastTense) continue;
    // A concrete object: something countable, named, or numeric.
    const concrete = /\d/.test(s) || /\b[\p{Lu}][\p{L}]+\b/u.test(s.replace(/^\W*\w+/, ''));
    if (concrete) hits++;
  }

  const score = hits === 0 ? 0 : hits === 1 ? 0.7 : 1;
  return { score, detail: `${hits} concrete first-person sentence(s)` };
}

/* --- Signal 4: cliches (penalty only) ----------------------------------- */

const CLICHES: readonly RegExp[] = [
  /in today's (?:fast[- ]paced|digital|competitive)/i,
  /game[- ]?changer/i,
  /let that sink in/i,
  /needle[- ]moving|move the needle/i,
  /at the end of the day/i,
  /here's the thing/i,
  /the harsh truth|harsh reality/i,
  /i'll say it louder/i,
  /read that again/i,
  /unpopular opinion/i,
  /\bthoughts\?\s*$/i,
  /\bnot\b[^.!?]{2,60}\bbut\b/i,
];

export function clicheSignal(text: string): Signal {
  const found = CLICHES.filter((r) => r.test(text));
  const score = Math.max(0, 1 - found.length * LIMITS.Q_PENALTY_PER_HIT);
  return { score, detail: found.length === 0 ? 'none' : `${found.length} cliche(s)` };
}

/* --- Signal 5: structural tells (penalty only) -------------------------- */

/**
 * Deliberately NOT penalising short paragraphs. One thought per line is the
 * house style on this platform, not a machine tell — penalising it would mark
 * down the same writing twice, once here and once on sentence variance. If
 * anything an unbroken wall of text is the more suspicious shape.
 *
 * "not X, but Y" lives in the cliche list, not here. It was in both.
 */
export function structureSignal(text: string): Signal {
  const ws = words(text);
  const ls = lines(text);
  const tells: string[] = [];

  const emDashes = (text.match(/—/g) ?? []).length;
  if (ws.length > 0 && emDashes / ws.length > 1 / 40) tells.push('em-dash density');

  const bullets = ls.filter((l) => /^[-•*▫️✅🔹]/u.test(l)).length;
  if (ls.length >= 4 && bullets / ls.length >= 0.6) tells.push('mostly bullets');

  const score = Math.max(0, 1 - tells.length * LIMITS.Q_PENALTY_PER_HIT);
  return { score, detail: tells.length === 0 ? 'none' : tells.join(', ') };
}

/* --- Composite ---------------------------------------------------------- */

function combine(parts: { signal: Signal; weight: number }[]): number {
  // A null signal redistributes its weight rather than scoring zero. A
  // two-sentence post is short, not flat, and must not be punished for it.
  const live = parts.filter((p) => p.signal.score !== null);
  const total = live.reduce((a, p) => a + p.weight, 0);
  if (total === 0) return 0;
  return live.reduce((a, p) => a + (p.signal.score as number) * p.weight, 0) / total;
}

function bandFor(composite: number, okAt: number): QualityBand {
  if (composite >= LIMITS.Q_BAND_STRONG) return 'strong';
  return composite >= okAt ? 'ok' : 'weak';
}

/** Score a post the user would publish under their own name. */
export function scorePost(text: string): QualityScore {
  const signals = {
    rhythm: rhythmSignal(text),
    specificity: specificitySignal(text),
    firstPerson: firstPersonSignal(text),
    cliche: clicheSignal(text),
    structure: structureSignal(text),
  };

  const composite = combine([
    { signal: signals.rhythm, weight: LIMITS.Q_WEIGHT_VARIANCE },
    { signal: signals.specificity, weight: LIMITS.Q_WEIGHT_SPECIFICITY },
    { signal: signals.firstPerson, weight: LIMITS.Q_WEIGHT_FIRST_PERSON },
    { signal: signals.cliche, weight: LIMITS.Q_WEIGHT_CLICHE },
    { signal: signals.structure, weight: LIMITS.Q_WEIGHT_STRUCTURE },
  ]);

  return { composite, band: bandFor(composite, LIMITS.Q_BAND_OK), signals };
}

/* --- Comments ----------------------------------------------------------- */

const STOPWORDS = new Set(
  ('a an and are as at be been but by for from has have how i if in into is it its of on or '
    + 'that the their they this to was were what when which who will with you your we our us '
    + 'not no can could would should do does did has just more most some such than then there '
    + 'these those about after also any because been before being between both during each '
    + 'few her his him she he them my me over own same so too very s t don now')
    .split(' '),
);

/**
 * Terms that mean something specific: names, numbers, technical words. These
 * are what a comment must share with its post to be about that post.
 */
function rareTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of words(text)) {
    const bare = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (bare.length < 3) continue;
    const lower = bare.toLowerCase();
    if (STOPWORDS.has(lower)) continue;

    const interesting =
      /\d/.test(bare) || /^[\p{Lu}]/u.test(bare) || bare.length >= 8 || /[_/-]/.test(bare);
    if (interesting) out.add(lower);
  }
  return out;
}

/**
 * Is this comment about THIS post?
 *
 * The failure mode for comments is not bad writing, it is content-free
 * writing: "Great insights, thanks for sharing" is grammatical, varied enough,
 * and says nothing. It scores zero here against every post ever written, which
 * is the whole point. Measured against the parent rather than in isolation.
 */
export function relevanceSignal(comment: string, parentPost: string): Signal {
  const parent = rareTerms(parentPost);
  const mine = rareTerms(comment);
  if (parent.size === 0) return { score: null, detail: 'parent post has no rare terms' };

  const shared = [...mine].filter((t) => parent.has(t));
  const score = Math.min(1, shared.length / LIMITS.Q_COMMENT_RARE_TERMS_FOR_FULL);
  return {
    score,
    detail:
      shared.length === 0
        ? 'shares nothing specific with the post'
        : `shares ${shared.length}: ${shared.slice(0, 4).join(', ')}`,
  };
}

/** Score a reply against the post it answers. */
export function scoreComment(text: string, parentPost: string): QualityScore {
  const signals = {
    relevance: relevanceSignal(text, parentPost),
    specificity: specificitySignal(text),
  };

  const composite = combine([
    { signal: signals.relevance, weight: LIMITS.Q_COMMENT_WEIGHT_RELEVANCE },
    { signal: signals.specificity, weight: LIMITS.Q_COMMENT_WEIGHT_SPECIFICITY },
  ]);

  return { composite, band: bandFor(composite, LIMITS.Q_COMMENT_BAND_OK), signals };
}
