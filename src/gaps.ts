/**
 * Gaps: the specifics the drafter is not permitted to invent.
 *
 * The drafter emits a frame with holes — `In the last ⟨how long?⟩ I watched a
 * ⟨how big?⟩ pull request` — and a hole cannot be a fabrication, because
 * nothing was produced that could be wrong. This is the difference between a
 * prompt rule and an invariant: a rule survives until a retry, a model swap or
 * an odd input; a hole survives all three.
 *
 * Exactly two things may fill a gap:
 *
 *   1. The user types it.
 *   2. It is retrieved verbatim from material they already wrote.
 *
 * Nothing else. A gap neither source can fill stays open, and a draft with an
 * open gap can never publish itself. That is the whole fabrication guarantee,
 * and it holds without a human in the loop — which matters, because autopilot
 * has no human in the loop by definition.
 *
 * Retrieval is verified, not trusted: the model must return a span that
 * actually appears in the source material, checked here. Asking a model to
 * "only use real material" is the same kind of request as asking it not to
 * invent, and gets the same reliability.
 */

import { newId } from './db/index.js';
import type { Gap } from './types.js';

/**
 * Gap markers.
 *
 * ASCII double brackets, deliberately. The first version used ⟨angle
 * brackets⟩ and the model reliably mangled the closing one - emitting
 * `⟨timeframe�>` - so nothing parsed, the draft reported zero gaps, and
 * text with broken markers in it became eligible to publish. A delimiter that
 * has to survive a model, a JSON round-trip and an encoding is not the place
 * for exotic characters.
 *
 * The angle forms are still recognised, because a model that has seen a
 * million of them will occasionally produce one anyway.
 */
const GAP_PATTERN = /\[\[([^\]\n]{1,80})\]\]|⟨([^⟩>\n]{1,80})[⟩>]/gu;

/**
 * Residue: something that was meant to be a gap and did not parse.
 *
 * Treated as an open gap by callers rather than ignored. A marker the parser
 * missed is the dangerous case - it means the draft believes it has no gaps
 * while carrying visible brackets into a real post.
 */
export function hasGapResidue(frame: string): boolean {
  return /[⟨⟩]|\[\[|\]\]|�/u.test(frame.replace(GAP_PATTERN, ''));
}

/* --- Numeral provenance ------------------------------------------------ *
 * A gap catches a specific the model chose to mark. It does not catch one it
 * asserted confidently in prose - "1.7x more likely to introduce defects" was
 * invented, ungapped, and read as fact.
 *
 * The rule is provenance, not absence. Refusing every numeral would throw away
 * legitimate ones from retrieved fills and from ordinary prose. A numeral is
 * allowed when it can be traced: it already sits inside a gap, or it appears
 * in the author's own material. Anything else becomes a gap, because the
 * remedy for an unsourced specific is to ask for it, not to discard the draft.
 * ---------------------------------------------------------------------- */

/** Digits, percentages, multipliers. Written numbers are out of scope. */
const NUMERAL = /\b\d[\d.,]*\s*(?:%|×|[xX](?=\s))?/gu;

function gapPromptForNumeral(numeral: string): string {
  if (numeral.includes('%')) return 'what percentage?';
  if (/[x×]/i.test(numeral)) return 'how many times?';
  return 'how many?';
}

/**
 * Replace every unsourced numeral in a frame with a gap.
 *
 * Runs on the frame rather than the rendered text, because at that point the
 * markers are still present: any numeral outside one was produced by the
 * model. Numerals already inside a gap prompt are left alone.
 */
export function proveNumerals(
  frame: string,
  material: string,
): { frame: string; converted: string[] } {
  const converted: string[] = [];

  // Blank out the gap markers so their contents are not scanned, keeping
  // offsets identical so replacement stays aligned.
  const masked = frame.replace(GAP_PATTERN, (m) => ' '.repeat(m.length));

  const hits: { start: number; end: number; text: string }[] = [];
  for (const m of masked.matchAll(NUMERAL)) {
    const text = m[0];
    const start = m.index ?? 0;
    // Hashtags carry numbers that are part of a name, not a claim.
    const before = frame.slice(Math.max(0, start - 24), start);
    if (/#[\p{L}\p{N}_]*$/u.test(before)) continue;
    if (appearsIn(text, material)) continue;
    hits.push({ start, end: start + text.length, text });
  }

  let out = '';
  let cursor = 0;
  for (const h of hits) {
    out += frame.slice(cursor, h.start) + `[[${gapPromptForNumeral(h.text)}]]`;
    cursor = h.end;
    converted.push(h.text.trim());
  }
  out += frame.slice(cursor);

  return { frame: out, converted };
}

/* --- Type hints --------------------------------------------------------- *
 * Verification answers "did they write this". It does not answer "does this
 * belong here": [[tool name]] was filled with "vibecoded", genuinely theirs
 * and grammatically wrong in the sentence.
 *
 * A light check only. A wrong-but-real fill is visible and embarrassing, not
 * dangerous, and catching it is what review is for.
 * ---------------------------------------------------------------------- */

export type GapType = 'tool' | 'duration' | 'quantity' | 'text';

export function gapType(prompt: string): GapType {
  const p = prompt.toLowerCase();
  if (/tool|library|framework|stack|language|product|service|platform/.test(p)) return 'tool';
  if (/how long|timeframe|time frame|duration|how often|when/.test(p)) return 'duration';
  if (/how many|how much|percentage|number|size|count|times/.test(p)) return 'quantity';
  return 'text';
}

export function fitsType(value: string, type: GapType): boolean {
  const v = value.trim();
  if (v === '') return false;

  switch (type) {
    case 'tool':
      // Named things look named: capitalised, versioned, or punctuated.
      // "vibecoded" is none of those.
      return /^[\p{Lu}]/u.test(v) || /\d/.test(v) || /[./_-]/.test(v);
    case 'duration':
      return /\d/.test(v) || /\b(day|week|month|year|hour|minute|sprint|quarter)/i.test(v);
    case 'quantity':
      return /\d/.test(v);
    case 'text':
      return true;
  }
}

/** Pull the holes out of a frame. Order is document order. */
export function parseGaps(frame: string): Gap[] {
  const out: Gap[] = [];
  for (const m of frame.matchAll(GAP_PATTERN)) {
    const prompt = (m[1] ?? m[2] ?? '').trim();
    if (prompt === '') continue;
    out.push({ id: newId(), prompt, value: null, source: null, evidence: null });
  }
  return out;
}

/**
 * The text as it would publish.
 *
 * Unfilled gaps render as their prompt still bracketed, so a half-finished
 * draft reads as obviously half-finished rather than as a sentence with a
 * strange phrase in it. Callers that must not show brackets should be checking
 * `hasOpenGaps` first, not stripping them.
 */
export function renderGaps(frame: string, gaps: Gap[]): string {
  let i = 0;
  return frame.replace(GAP_PATTERN, (whole) => {
    const gap = gaps[i++];
    return gap?.value ?? whole;
  });
}

export function hasOpenGaps(gaps: Gap[], frame?: string): boolean {
  if (gaps.some((g) => g.value === null)) return true;
  // Unparsed residue counts as open. Publishing text with stray brackets is
  // worse than holding a draft that turned out to be fine.
  return frame !== undefined && hasGapResidue(frame);
}

/**
 * Was every gap filled from material that already existed?
 *
 * The condition for letting a post go out unattended. A user-typed fill is a
 * human deciding, which autopilot does not have; a retrieved fill is a quote
 * from something they already wrote, which it does. A post with no gaps at all
 * is not grounded either — it simply never claimed anything specific, and
 * publishing generic text unattended is the other failure this product has.
 */
export function isGrounded(gaps: Gap[]): boolean {
  return gaps.length > 0 && gaps.every((g) => g.value !== null && g.source === 'retrieved');
}

/**
 * Does this span actually appear in the material?
 *
 * Deliberately lenient about punctuation, casing and whitespace — models
 * re-type quotes with smart quotes and collapsed spacing — and strict about
 * the words. Mirrors `groundedIn` in the comment path, for the same reason.
 */
export function appearsIn(span: string, material: string): boolean {
  const normalise = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[‘’“”]/g, "'")
      .replace(/[^a-z0-9' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const needle = normalise(span);
  const hay = normalise(material);
  if (needle.length === 0 || hay.length === 0) return false;

  // A short fill ("three weeks", "47") is a phrase, not a quote: require it
  // outright. Longer spans get the four-word-run treatment, since a model
  // will paraphrase around the edges of anything it retypes.
  const needleWords = needle.split(' ');
  if (needleWords.length <= 4) return hay.includes(needle);

  for (let i = 0; i + 4 <= needleWords.length; i++) {
    if (hay.includes(needleWords.slice(i, i + 4).join(' '))) return true;
  }
  return false;
}

/**
 * Apply retrieved fills, keeping only those the material actually supports.
 *
 * Returns a new array; the caller decides what to persist. A proposal whose
 * evidence does not appear in the material is discarded silently and the gap
 * stays open, which is the correct outcome and not an error.
 */
export function applyRetrieved(
  gaps: Gap[],
  proposals: { id: string; value: string; evidence: string }[],
  material: string,
): Gap[] {
  const byId = new Map(proposals.map((p) => [p.id, p]));

  return gaps.map((gap) => {
    if (gap.value !== null) return gap;
    const p = byId.get(gap.id);
    if (!p || p.value.trim() === '') return gap;

    // Both must hold: the evidence has to be real, and the value has to be
    // drawn from it rather than decorated onto it.
    if (!appearsIn(p.evidence, material)) return gap;
    if (!appearsIn(p.value, p.evidence) && !appearsIn(p.value, material)) return gap;
    // Real, but does it belong in this sentence?
    if (!fitsType(p.value, gapType(gap.prompt))) return gap;

    return {
      ...gap,
      value: p.value.trim(),
      source: 'retrieved' as const,
      evidence: p.evidence.trim(),
    };
  });
}

/** Apply a fill the user typed. Always accepted — it is their claim to make. */
export function applyUserFill(gaps: Gap[], id: string, value: string): Gap[] {
  return gaps.map((g) =>
    g.id === id
      ? { ...g, value: value.trim() === '' ? null : value.trim(), source: 'user' as const, evidence: null }
      : g,
  );
}
