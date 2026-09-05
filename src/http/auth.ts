import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { listAccounts } from '../db/accounts.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

/**
 * Stub auth.
 *
 * TODO: replace with real authentication before this is exposed to more than
 * one person. Every route below trusts `req.userId`, and right now it is a
 * constant — there is no session, no token check, and no way to distinguish
 * one caller from another. Anything reachable from the network can act as the
 * single user, including approving connection requests on their LinkedIn
 * account. Bind the server to localhost until that is fixed.
 */
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  req.userId = config.singleUserId;
  next();
}

/**
 * Resolve which account a request is about: `?accountId=` when given,
 * otherwise the user's only account. Returns null when the account exists but
 * belongs to someone else, so callers 404 rather than leaking its existence.
 */
export async function resolveAccountId(req: Request): Promise<string | null> {
  const accounts = await listAccounts(req.userId);
  const requested = typeof req.query['accountId'] === 'string' ? req.query['accountId'] : null;
  if (requested) {
    return accounts.some((a) => a.id === requested) ? requested : null;
  }
  return accounts[0]?.id ?? null;
}

/** Same check for an account id that arrived in the path. */
export async function ownsAccount(req: Request, accountId: string): Promise<boolean> {
  const accounts = await listAccounts(req.userId);
  return accounts.some((a) => a.id === accountId);
}
