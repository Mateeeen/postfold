import express, { Router } from 'express';
import { config } from '../../config.js';
import { getWebhookAdapter } from '../../providers/index.js';
import { handleEvent } from '../../webhooks.js';
import { asyncHandler } from '../util.js';

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
    const signature =
      (req.get('x-unipile-signature') ?? req.get('x-signature') ?? null);

    const adapter = getWebhookAdapter();
    if (!adapter.verify(raw, signature, secret)) {
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
