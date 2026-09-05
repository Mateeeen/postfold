import crypto from 'node:crypto';
import express, { Router } from 'express';
import { config } from '../../config.js';
import { getWebhookAdapter } from '../../providers/index.js';
import { handleEvent } from '../../webhooks.js';
import { asyncHandler } from '../util.js';

/**
 * The header a provider that cannot sign should send its shared secret in.
 * Configured on the provider side when the webhook is created.
 */
const SHARED_SECRET_HEADER = 'x-postfold-webhook-secret';

/** Constant-time, so the secret cannot be discovered a byte at a time. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const webhooksRouter = Router();

/**
 * Inbound provider events.
 *
 * The body is parsed as RAW bytes, not JSON: the HMAC is computed over exactly
 * what was sent, and re-serialising parsed JSON reorders keys and changes
 * whitespace, so the signature stops matching for reasons that look like a key
 * problem and are not.
 */
webhooksRouter.post(
  '/webhooks/unipile',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const secret = config.unipileWebhookSecret;
    if (!secret) {
      // Refusing is the safe default: an unverified webhook can disable an
      // account or move the acceptance rate.
      res.status(503).json({ error: 'Webhook secret is not configured.' });
      return;
    }

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));

    // Two ways in, because providers differ in what they are willing to prove.
    //
    // A signature header means the body itself is authenticated: replaying it
    // with one byte changed fails. Preferred, and tried first.
    //
    // Unipile does not sign. It offers only static headers you set when the
    // webhook is created, and echoes them back on delivery — so a shared
    // secret in a header is the strongest thing available. It authenticates
    // the *sender*, not the body, which is why the signature path is not
    // being replaced by it.
    const signature = req.get('x-unipile-signature') ?? req.get('x-signature') ?? null;
    const presented = req.get(SHARED_SECRET_HEADER) ?? null;

    const adapter = getWebhookAdapter();
    const authorised = signature
      ? adapter.verify(raw, signature, secret)
      : presented !== null && secretsMatch(presented, secret);

    if (!authorised) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const event = adapter.parse(raw);
    const outcome = await handleEvent(event, raw.toString('utf8'));

    // 200 even for events we do not handle: a non-2xx makes the provider retry
    // an event that will never succeed.
    res.status(200).json(outcome);
  }),
);
