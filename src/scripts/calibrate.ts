/**
 * Score the corpus of real posts and report the distribution.
 *
 * These are posts written by humans that demonstrably got engagement — a free
 * labelled set of known-good writing. If a meaningful share of them score
 * "weak", the thresholds are wrong, and the per-signal means say which one is
 * doing it. Run this before changing any Q_ constant in policy.ts.
 *
 *   npx tsx src/scripts/calibrate.ts
 */

import Database from 'better-sqlite3';
import { config } from '../config.js';
import { LIMITS } from '../policy.js';
import { scorePost } from '../quality.js';
import type { QualityScore } from '../quality.js';

const db = new Database(config.databasePath, { readonly: true });

const rows = db
  .prepare(
    `SELECT text, reactions, comments FROM discovered_posts
      WHERE length(text) > 80
      ORDER BY (reactions + comments) DESC`,
  )
  .all() as { text: string; reactions: number; comments: number }[];

if (rows.length === 0) {
  console.log('No corpus. Run a trend sync first.');
  process.exit(0);
}

const scored = rows.map((r) => ({ ...r, q: scorePost(r.text) }));

function report(label: string, items: { q: QualityScore }[]): void {
  const n = items.length;
  const bands = { strong: 0, ok: 0, weak: 0 };
  for (const i of items) bands[i.q.band]++;

  const pct = (x: number): string => `${((x / n) * 100).toFixed(0)}%`.padStart(4);
  console.log(`\n${label}  (n=${n})`);
  console.log(`  strong ${pct(bands.strong)}  ${String(bands.strong).padStart(4)}`);
  console.log(`  ok     ${pct(bands.ok)}  ${String(bands.ok).padStart(4)}`);
  console.log(`  weak   ${pct(bands.weak)}  ${String(bands.weak).padStart(4)}`);

  const keys = ['rhythm', 'specificity', 'firstPerson', 'cliche', 'structure'] as const;
  const mean = (k: string): string => {
    const vals = items.map((i) => i.q.signals[k]?.score).filter((v): v is number => v !== null && v !== undefined);
    return vals.length === 0 ? ' n/a' : (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
  };
  console.log('  means: ' + keys.map((k) => `${k} ${mean(k)}`).join('  '));

  const composites = items.map((i) => i.q.composite).sort((a, b) => a - b);
  const at = (p: number): string => composites[Math.floor(composites.length * p)]!.toFixed(2);
  console.log(`  composite  p10 ${at(0.1)}  median ${at(0.5)}  p90 ${at(0.9)}`);
}

console.log('=== thresholds ===');
console.log(`  strong >= ${LIMITS.Q_BAND_STRONG}   ok >= ${LIMITS.Q_BAND_OK}`);

report('ALL POSTS', scored);

const quartile = Math.max(1, Math.floor(scored.length / 4));
report('TOP QUARTILE BY ENGAGEMENT', scored.slice(0, quartile));

console.log('\n=== weakest proven posts (these should worry us) ===');
for (const s of [...scored].sort((a, b) => a.q.composite - b.q.composite).slice(0, 5)) {
  console.log(`\n  ${s.q.composite.toFixed(2)} [${s.q.band}]  ${s.reactions + s.comments} engagements`);
  console.log(`  "${s.text.replace(/\s+/g, ' ').slice(0, 90)}…"`);
  for (const [k, v] of Object.entries(s.q.signals)) {
    console.log(`     ${k.padEnd(12)} ${v.score === null ? ' n/a' : v.score.toFixed(2)}  ${v.detail}`);
  }
}
