/**
 * Gaps are the fabrication guarantee, so these tests are the guarantee's
 * proof. Each one corresponds to a way the drafter has actually failed:
 * inventing an anecdote, asserting a statistic in prose, mangling a delimiter,
 * and filling a slot with something real but wrong.
 */

import { describe, expect, it } from 'vitest';
import { addDocument, evidenceMaterial, trustFor, voiceSamples } from '../src/db/documents.js';
import { fixture } from './helpers.js';
import { createDraft, setDraftStatus } from '../src/db/drafts.js';
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

/** Something the user pasted. Real words, not their words. */
const PASTED =
  'A recent industry report found that 47% of enterprises now run AI code review '
  + 'in production, up from single digits two years ago.';

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
  it('a filled gap set still reads as open when the frame has residue', () => {
    // The case the optional argument used to hide: every gap accounted for,
    // and a mangled marker still sitting in the text.
    const gaps = parseGaps('I shipped [[what?]].');
    const filled = applyUserFill(gaps, gaps[0]!.id, 'the parser');
    expect(hasOpenGaps(filled, 'I shipped [[what?]] in ⟨how long�>.')).toBe(true);
  });

  it('an open gap blocks self-publishing', () => {
    const frame = 'I spent [[how long?]] on [[what?]].';
    const gaps = parseGaps(frame);
    expect(hasOpenGaps(gaps, frame)).toBe(true);
    expect(isGrounded(gaps)).toBe(false);
  });

  it('a user fill closes the gap but does not earn autopilot', () => {
    // Autopilot has no human in it. A human-typed fill proves a human was
    // there, which is precisely the thing autopilot cannot supply.
    const frame = 'I spent [[how long?]] on it.';
    let gaps = parseGaps(frame);
    gaps = applyUserFill(gaps, gaps[0]!.id, 'two days');
    // Closed, and the frame carries no residue - both halves checked, which
    // is the point of the argument being required.
    expect(hasOpenGaps(gaps, frame)).toBe(false);
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

/* ================================================================== *
 * The trust boundary
 *
 * Retrieved material is what lets a specific through the provenance scan,
 * so what counts as "theirs" is a security question, not a storage one.
 * ================================================================== */

describe('trust levels', () => {
  it('classifies sources by whether authorship is verifiable', () => {
    // Source decides whether evidence is POSSIBLE; authorship decides whether
    // it is granted. Both are required.
    expect(trustFor('linkedin_post', 'human-verified')).toBe('evidence');
    expect(trustFor('linkedin_comment', 'human-verified')).toBe('evidence');
    expect(trustFor('commit', 'human-verified')).toBe('evidence');
    // The whole point: pasting an article must not make it quotable as yours,
    // however confidently the caller asserts authorship.
    expect(trustFor('note', 'human-verified')).toBe('voice');
    expect(trustFor('link', 'human-verified')).toBe('voice');
  });

  it('keeps pasted text out of citable material', async () => {
    const f = await fixture();
    try {
      await addDocument(
        { accountId: f.account.id, source: 'note', text: PASTED, externalId: 'n1' },
        f.db,
      );
      await addDocument(
        {
          accountId: f.account.id,
          source: 'linkedin_post',
          text: MATERIAL,
          externalId: 'p1',
          authorship: 'human-verified',
        },
        f.db,
      );

      const citable = await evidenceMaterial(f.account.id, 40, f.db);
      expect(citable).toContain('three weeks');
      expect(citable).not.toContain('47% of enterprises');

      // Style may draw on both — tone is not a truth claim.
      const style = await voiceSamples(f.account.id, 5, f.db);
      expect(style.join(' ')).toContain('47% of enterprises');
    } finally {
      f.db.close();
    }
  });

  it('will not let a pasted statistic prove a numeral', async () => {
    const f = await fixture();
    try {
      await addDocument(
        { accountId: f.account.id, source: 'note', text: PASTED, externalId: 'n1' },
        f.db,
      );
      const citable = await evidenceMaterial(f.account.id, 40, f.db);

      // The number is right there in the pasted article, and still gets gapped.
      const { converted } = proveNumerals('Adoption sits at 47% of enterprises.', citable);
      expect(converted).toContain('47%');
    } finally {
      f.db.close();
    }
  });
});

/* ================================================================== *
 * Human authorship
 *
 * Verifiable origin is not enough: a comment this product sent unattended
 * carries the user's byline and is still machine text. Citing it would let
 * one autopilot draft license the specifics in the next.
 * ================================================================== */

describe('unattended output is not evidence', () => {
  it('keeps a timer-sent comment out of citable material', async () => {
    const f = await fixture();
    try {
      // What the ingest path does with an unattended item: stores it at voice
      // trust so it still shapes tone, and never as something quotable.
      await addDocument(
        {
          accountId: f.account.id,
          source: 'note',
          text: 'Our autopilot comment claiming 63% of teams now do this.',
          externalId: 'c-timer',
        },
        f.db,
      );
      await addDocument(
        {
          accountId: f.account.id,
          source: 'linkedin_comment',
          text: MATERIAL,
          externalId: 'c-approved',
          authorship: 'human-verified',
        },
        f.db,
      );

      const citable = await evidenceMaterial(f.account.id, 40, f.db);
      expect(citable).toContain('three weeks');
      expect(citable).not.toContain('63% of teams');

      // And the number it invented cannot prove a numeral in the next draft.
      const { converted } = proveNumerals('Now 63% of teams do this.', citable);
      expect(converted).toContain('63%');
    } finally {
      f.db.close();
    }
  });
});

describe('authorship survives sending', () => {
  it('does not lose decided_by when a sent draft is marked approved', async () => {
    // The worker marks a draft 'approved' after sending and passes null for
    // the decider. A plain assignment wiped the one field that says whether a
    // person stood behind the words, so every sent item later looked
    // hand-written and machine text became citable as the user's own.
    const f = await fixture();
    try {
      const draft = await createDraft(
        { accountId: f.account.id, kind: 'comment', text: 'A drafted reply.', rationale: 'x' },
        f.db,
      );
      await setDraftStatus(draft.id, 'queued', 'timer', null, f.db);
      await setDraftStatus(draft.id, 'approved', null, null, f.db);

      const row = f.db
        .prepare('SELECT status, decided_by FROM drafts WHERE id = ?')
        .get(draft.id) as { status: string; decided_by: string | null };

      expect(row.status).toBe('approved');
      expect(row.decided_by).toBe('timer');
    } finally {
      f.db.close();
    }
  });
});

describe('invariant 12: the trust layer defaults to voice', () => {
  it('refuses evidence when authorship is not asserted', () => {
    // The parameter is omitted, as a forgetful caller would. An
    // evidence-capable source is not enough on its own.
    expect(trustFor('linkedin_post')).toBe('voice');
    expect(trustFor('linkedin_comment')).toBe('voice');
  });

  it('grants evidence only on positive proof', () => {
    expect(trustFor('linkedin_post', 'human-verified')).toBe('evidence');
    expect(trustFor('linkedin_post', 'unproven')).toBe('voice');
    // Proof does not promote a source that can never be verified.
    expect(trustFor('note', 'human-verified')).toBe('voice');
  });

  it('stores as voice when a caller forgets the authorship argument', async () => {
    const f = await fixture();
    try {
      await addDocument(
        { accountId: f.account.id, source: 'linkedin_post', text: MATERIAL, externalId: 'p1' },
        f.db,
      );
      expect(await evidenceMaterial(f.account.id, 40, f.db)).toBe('');
    } finally {
      f.db.close();
    }
  });
});
