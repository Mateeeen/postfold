/**
 * Gaps are the fabrication guarantee, so these tests are the guarantee's
 * proof. Each one corresponds to a way the drafter has actually failed:
 * inventing an anecdote, asserting a statistic in prose, mangling a delimiter,
 * and filling a slot with something real but wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  appearsIn,
  applyRetrieved,
  applyUserFill,
  fitsType,
  gapType,
  hasGapResidue,
  hasOpenGaps,
  isGrounded,
  parseGaps,
  proveNumerals,
  renderGaps,
} from '../src/gaps.js';

const MATERIAL =
  'Production App vibecoded. AI-assisted coding can make an app look 100% complete ' +
  'until you actually start testing it. I spent three weeks on the review pipeline.';

describe('parsing', () => {
  it('reads double-bracket gaps', () => {
    const gaps = parseGaps('In the last [[how long?]] I shipped [[what?]].');
    expect(gaps.map((g) => g.prompt)).toEqual(['how long?', 'what?']);
  });

  it('still reads angle gaps a model produces out of habit', () => {
    expect(parseGaps('spent ⟨how long?⟩ on it')).toHaveLength(1);
  });

  it('does not treat a mangled marker as clean text', () => {
    // The delimiter that actually broke: the model emitted a bad closing
    // bracket, nothing parsed, and the draft believed it had no gaps and was
    // therefore free to publish. The invariant is only that such text can
    // never be mistaken for finished - whether the tolerant pattern catches
    // it or the residue check does is an implementation detail.
    const mangled = 'In the last ⟨timeframe�> my team spent effort';
    const caught = parseGaps(mangled).length > 0 || hasGapResidue(mangled);
    expect(caught).toBe(true);
    expect(hasOpenGaps(parseGaps(mangled), mangled)).toBe(true);
  });
});

describe('numeral provenance', () => {
  it('gaps a statistic the material cannot account for', () => {
    const { frame, converted } = proveNumerals(
      'AI PRs are 1.7x more likely to introduce defects.',
      MATERIAL,
    );
    expect(converted).toContain('1.7x');
    expect(frame).toContain('[[how many times?]]');
  });

  it('leaves a numeral that appears in the material alone', () => {
    const { frame, converted } = proveNumerals('It looked 100% complete.', MATERIAL);
    expect(converted).toHaveLength(0);
    expect(frame).toContain('100%');
  });

  it('does not touch numbers inside an existing gap', () => {
    const { converted } = proveNumerals('shipped [[how many? 3 or 4]] things', MATERIAL);
    expect(converted).toHaveLength(0);
  });

  it('leaves hashtags alone', () => {
    const { converted } = proveNumerals('thoughts #AI2027 #Web3', MATERIAL);
    expect(converted).toHaveLength(0);
  });
});

describe('retrieval is verified, not trusted', () => {
  it('accepts a fill whose evidence is really in the material', () => {
    const gaps = parseGaps('I spent [[how long?]] on it.');
    const filled = applyRetrieved(
      gaps,
      [{ id: gaps[0]!.id, value: 'three weeks', evidence: 'I spent three weeks on the review pipeline' }],
      MATERIAL,
    );
    expect(filled[0]!.value).toBe('three weeks');
    expect(filled[0]!.source).toBe('retrieved');
  });

  it('discards a fill whose evidence is invented', () => {
    const gaps = parseGaps('I spent [[how long?]] on it.');
    const filled = applyRetrieved(
      gaps,
      [{ id: gaps[0]!.id, value: 'six months', evidence: 'I spent six months rewriting the parser' }],
      MATERIAL,
    );
    expect(filled[0]!.value).toBeNull();
  });

  it('discards a real span that does not fit the slot', () => {
    // "vibecoded" is genuinely theirs and is not a tool name.
    const gaps = parseGaps('built with [[tool name]]');
    const filled = applyRetrieved(
      gaps,
      [{ id: gaps[0]!.id, value: 'vibecoded', evidence: 'Production App vibecoded' }],
      MATERIAL,
    );
    expect(filled[0]!.value).toBeNull();
  });
});

describe('type hints', () => {
  it('classifies prompts', () => {
    expect(gapType('tool name')).toBe('tool');
    expect(gapType('how long?')).toBe('duration');
    expect(gapType('how many lines?')).toBe('quantity');
    expect(gapType('what happened?')).toBe('text');
  });

  it('accepts named things as tools and rejects bare words', () => {
    expect(fitsType('Postgres', 'tool')).toBe(true);
    expect(fitsType('gpt-4o', 'tool')).toBe(true);
    expect(fitsType('vibecoded', 'tool')).toBe(false);
  });
});

describe('the gate', () => {
  it('an open gap blocks self-publishing', () => {
    const gaps = parseGaps('I spent [[how long?]] on [[what?]].');
    expect(hasOpenGaps(gaps)).toBe(true);
    expect(isGrounded(gaps)).toBe(false);
  });

  it('a user fill closes the gap but does not earn autopilot', () => {
    // Autopilot has no human in it. A human-typed fill proves a human was
    // there, which is precisely the thing autopilot cannot supply.
    let gaps = parseGaps('I spent [[how long?]] on it.');
    gaps = applyUserFill(gaps, gaps[0]!.id, 'two days');
    expect(hasOpenGaps(gaps)).toBe(false);
    expect(isGrounded(gaps)).toBe(false);
  });

  it('only fully retrieved gaps are autopilot-eligible', () => {
    const gaps = parseGaps('I spent [[how long?]] on it.');
    const filled = applyRetrieved(
      gaps,
      [{ id: gaps[0]!.id, value: 'three weeks', evidence: 'I spent three weeks on the review pipeline' }],
      MATERIAL,
    );
    expect(isGrounded(filled)).toBe(true);
  });

  it('a post with no gaps at all is not grounded', () => {
    expect(isGrounded([])).toBe(false);
  });
});

describe('rendering', () => {
  it('substitutes filled gaps and leaves open ones visible', () => {
    let gaps = parseGaps('I spent [[how long?]] on [[what?]].');
    gaps = applyUserFill(gaps, gaps[0]!.id, 'two days');
    expect(renderGaps('I spent [[how long?]] on [[what?]].', gaps)).toBe(
      'I spent two days on [[what?]].',
    );
  });
});

describe('appearsIn', () => {
  it('matches a short phrase outright', () => {
    expect(appearsIn('three weeks', MATERIAL)).toBe(true);
    expect(appearsIn('four weeks', MATERIAL)).toBe(false);
  });

  it('tolerates retyped punctuation on a longer span', () => {
    expect(appearsIn('“AI-assisted coding can make an app look”', MATERIAL)).toBe(true);
  });
});
