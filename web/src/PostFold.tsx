/**
 * The composer and the carousel builder.
 *
 * Ported from the standalone PostFold.jsx. The composer and carousel logic is
 * unchanged; the only addition is wiring "Copy post" to also offer "Add to
 * queue", which routes through the API so the post is paced like everything
 * else.
 *
 * The fold position comes from the server (policy.ts), not from a constant
 * here — a composer that disagrees with policy about where the fold is would
 * be lying to the user about the one thing it exists to show them.
 */

import { useMemo, useState } from 'react';
import type { AppConfig } from './App';

interface Props {
  config: AppConfig;
  onQueuePost: (text: string) => Promise<string | null>;
}

/* ------------------------------------------------------------------ *
 * Fold calculation
 * ------------------------------------------------------------------ */

interface Fold {
  index: number;
  reason: 'chars' | 'lines' | 'none';
  above: string;
  below: string;
}

/**
 * LinkedIn truncates a feed post at roughly 210 characters OR after the third
 * line, whichever comes first. Everything after that is behind "…see more".
 */
export function findFold(text: string, charLimit: number, lineLimit: number): Fold {
  const lines = text.split('\n');

  let lineCut = -1;
  if (lines.length > lineLimit) {
    lineCut = lines.slice(0, lineLimit).join('\n').length;
  }

  const charCut = text.length > charLimit ? charLimit : -1;

  let index: number;
  let reason: Fold['reason'];
  if (lineCut === -1 && charCut === -1) {
    index = text.length;
    reason = 'none';
  } else if (lineCut === -1) {
    index = charCut;
    reason = 'chars';
  } else if (charCut === -1) {
    index = lineCut;
    reason = 'lines';
  } else if (lineCut <= charCut) {
    index = lineCut;
    reason = 'lines';
  } else {
    index = charCut;
    reason = 'chars';
  }

  return { index, reason, above: text.slice(0, index), below: text.slice(index) };
}

/* ------------------------------------------------------------------ *
 * Reach flags
 * ------------------------------------------------------------------ */

export interface Flag {
  level: 'warn' | 'ok';
  text: string;
}

const URL_RE = /https?:\/\/[^\s)]+/gi;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;

export function reachFlags(text: string, fold: Fold): Flag[] {
  const flags: Flag[] = [];
  if (text.trim() === '') return flags;

  const links = text.match(URL_RE) ?? [];
  if (links.length > 0) {
    flags.push({
      level: 'warn',
      text: `${links.length} outbound link${links.length > 1 ? 's' : ''} in the post. Links in the body suppress reach — put them in the first comment instead.`,
    });
  }

  const hashtags = text.match(HASHTAG_RE) ?? [];
  if (hashtags.length > 5) {
    flags.push({
      level: 'warn',
      text: `${hashtags.length} hashtags. More than about five reads as reach-chasing; three well-chosen ones do more.`,
    });
  }

  const firstLine = text.split('\n')[0] ?? '';
  if (firstLine.length > 90) {
    flags.push({
      level: 'warn',
      text: 'Your first line is long. It is the only line most people read — make it land in under 90 characters.',
    });
  }
  if (firstLine.trim().length > 0 && firstLine.length <= 90) {
    flags.push({ level: 'ok', text: 'First line is short enough to land before the fold.' });
  }

  const capsWords = (text.match(/\b[A-Z]{4,}\b/g) ?? []).length;
  if (capsWords >= 3) {
    flags.push({ level: 'warn', text: `${capsWords} words in all caps. It reads as shouting.` });
  }

  if (fold.reason !== 'none' && fold.below.trim().length > 0) {
    const hook = fold.above.trim();
    if (!/[?:.!—-]$/.test(hook)) {
      flags.push({
        level: 'warn',
        text: 'The text cuts mid-sentence at the fold. Land a complete thought — or a question — right before it.',
      });
    }
  }

  if (text.length > 2800) {
    flags.push({ level: 'warn', text: `${text.length} characters. LinkedIn cuts posts off at 3000.` });
  }

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim() !== '');
  if (text.length > 400 && paragraphs.length < 3) {
    flags.push({
      level: 'warn',
      text: 'Long post with few line breaks. A wall of text loses people on mobile.',
    });
  }

  return flags;
}

/* ------------------------------------------------------------------ *
 * Carousel
 * ------------------------------------------------------------------ */

export interface Slide {
  body: string;
  cover: boolean;
}

/** Outline -> slides. Blank lines and `---` both split. */
export function buildSlides(outline: string, title: string): Slide[] {
  const chunks = outline
    .split(/\n\s*(?:---+\s*)?\n|\n---+\n/)
    .map((c) => c.trim())
    .filter((c) => c !== '');

  const slides: Slide[] = chunks.map((body) => ({ body, cover: false }));
  if (title.trim() !== '') slides.unshift({ body: title.trim(), cover: true });
  return slides;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function Composer({ config, onQueuePost }: Props): JSX.Element {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [queueState, setQueueState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'queued' }
  >({ kind: 'idle' });

  const fold = useMemo(
    () => findFold(text, config.foldCharLimit, config.foldLineLimit),
    [text, config],
  );
  const flags = useMemo(() => reachFlags(text, fold), [text, fold]);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const queue = async (): Promise<void> => {
    setQueueState({ kind: 'busy' });
    const error = await onQueuePost(text);
    setQueueState(error ? { kind: 'error', message: error } : { kind: 'queued' });
  };

  return (
    <div className="grid">
      <div className="panel">
        <h2>Compose</h2>
        <textarea
          className="compose"
          value={text}
          placeholder="Write your post. The fold marker shows where LinkedIn stops showing it."
          onChange={(e) => {
            setText(e.target.value);
            setQueueState({ kind: 'idle' });
          }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <span className="meta">
            {text.length} characters · {fold.above.length} above the fold
          </span>
          <span className="spacer" />
          <button onClick={() => void copy()} disabled={text.trim() === ''}>
            {copied ? 'Copied' : 'Copy post'}
          </button>
          <button
            className="primary"
            onClick={() => void queue()}
            disabled={text.trim() === '' || queueState.kind === 'busy'}
          >
            Add to queue
          </button>
        </div>

        {queueState.kind === 'queued' && (
          <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
            Queued. It will publish inside your send window — see the Queue tab.
          </div>
        )}
        {queueState.kind === 'error' && (
          <div className="blocked" style={{ marginTop: 12 }}>
            {queueState.message}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>What people see</h2>
        <div className="preview">
          <span className="above">{fold.above || <span className="see-more">Nothing yet.</span>}</span>
          {fold.reason !== 'none' && fold.below.length > 0 && (
            <>
              <span className="see-more"> …see more</span>
              <div className="fold-rule">
                the fold · cut by {fold.reason === 'lines' ? 'line count' : 'character count'}
              </div>
              <span className="below">{fold.below}</span>
            </>
          )}
        </div>

        {flags.length > 0 && (
          <ul className="flags">
            {flags.map((f, i) => (
              <li key={i}>
                <span className={`dot ${f.level}`} />
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function Carousel(): JSX.Element {
  const [title, setTitle] = useState('');
  const [outline, setOutline] = useState('');
  const slides = useMemo(() => buildSlides(outline, title), [outline, title]);

  return (
    <>
      <div className="grid">
        <div className="panel">
          <h2>Outline</h2>
          <input
            type="text"
            value={title}
            placeholder="Cover slide (optional)"
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="compose"
            style={{ marginTop: 10 }}
            value={outline}
            placeholder={'One idea per block.\n\nSeparate slides with a blank line\n\n---\n\nor with three dashes.'}
            onChange={(e) => setOutline(e.target.value)}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <span className="meta">{slides.length} slides</span>
            <span className="spacer" />
            {/* Export goes through the browser's own print-to-PDF. It needs no
                PDF library, and the page CSS already describes the slides. */}
            <button
              className="primary"
              onClick={() => window.print()}
              disabled={slides.length === 0}
            >
              Export PDF
            </button>
          </div>
          <p className="meta" style={{ marginTop: 8 }}>
            Export opens your print dialog — choose “Save as PDF”. Each slide is one square page.
          </p>
        </div>

        <div className="panel">
          <h2>Slides</h2>
          {slides.length === 0 ? (
            <div className="empty">Write an outline and the slides appear here.</div>
          ) : (
            <div className="slides">
              {slides.map((s, i) => (
                <div key={i} className={`slide${s.cover ? ' cover' : ''}`}>
                  <span className="n">{s.cover ? 'COVER' : String(i + (title ? 0 : 1))}</span>
                  <div className="body">{s.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="print-only">
        {slides.map((s, i) => (
          <div key={i} className={`print-slide${s.cover ? ' cover' : ''}`}>
            <div className="body">{s.body}</div>
            {!s.cover && <div className="n">{i + (title ? 0 : 1)}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
