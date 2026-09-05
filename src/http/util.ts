import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 does not catch rejected promises from handlers. This does. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

/**
 * Route params are `string | undefined` under noUncheckedIndexedAccess. A
 * missing one cannot match a mounted path, so an empty string is enough — it
 * falls through to the same 404 as an id that does not exist.
 */
export function param(req: Request, name: string): string {
  return req.params[name] ?? '';
}

export function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

export function notFound(res: Response, message = 'Not found'): void {
  res.status(404).json({ error: message });
}

/**
 * The queue refused. 409, not 400 — the request was well-formed, the account
 * simply is not allowed to do this right now. `reason` comes from policy.ts
 * and is shown to the user verbatim.
 */
export function refused(res: Response, reason: string): void {
  res.status(409).json({ error: reason, reason });
}
