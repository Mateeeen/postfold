/**
 * Access control for a deployed instance.
 *
 * This is NOT user authentication. It is a single shared token that gates the
 * whole API, and it exists because every route below it takes irreversible
 * actions on a real LinkedIn account under one person's name — publishing
 * posts, commenting on strangers' threads, sending connection requests. An
 * unauthenticated public URL for that is an account-takeover surface, not a
 * missing feature.
 *
 * TODO: replace with real per-user authentication before more than one person
 * uses this. `requireUser` still resolves a hardcoded id; this token only
 * decides whether a caller gets in at all, not who they are.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/** Constant-time compare, so the token cannot be discovered a byte at a time. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function presentedToken(req: Request): string | null {
  const header = req.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const direct = req.get('x-postfold-token');
  return direct && direct.trim() !== '' ? direct.trim() : null;
}

/**
 * Refuse everything unless the caller presents the shared token.
 *
 * When APP_TOKEN is unset the gate is open — correct for `npm run dev` on
 * localhost, and the reason the server refuses to bind publicly without one
 * (see server.ts).
 */
export function requireAccess(req: Request, res: Response, next: NextFunction): void {
  const expected = config.appToken;
  if (!expected) {
    next();
    return;
  }

  const provided = presentedToken(req);
  if (!provided || !tokensMatch(provided, expected)) {
    res.status(401).json({ error: 'Not authorised.' });
    return;
  }
  next();
}

/**
 * Cross-origin access for a separately hosted frontend.
 *
 * The allowlist is explicit: a wildcard would let any page on the internet
 * make authenticated calls from a visitor's browser.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-postfold-token');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
