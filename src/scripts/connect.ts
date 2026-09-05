/**
 * Register a real, already-linked provider account in PostFold.
 *
 * Run this AFTER logging into LinkedIn through the provider's hosted auth
 * page. It finds the linked account, writes our `accounts` row, and stops.
 *
 * Two deliberate choices:
 *
 *  - `connected_at` is set to now, which is when THIS account started sending
 *    through PostFold. The warm-up ladder anchors on it, so it starts at day 1
 *    and 5 invites/day even if the LinkedIn account itself is ten years old.
 *    That is the point: the ladder is about our sending pattern, not the
 *    account's age.
 *  - `sending_enabled` starts at 0. Nothing sends until you have looked at the
 *    account state and turned it on yourself.
 *
 * Usage:
 *   npm run connect                       -- list what is linked
 *   npm run connect -- <providerAccountId> [timezone]
 */

import { pathToFileURL } from 'node:url';
import { config, usingFakeProvider } from '../config.js';
import { createAccount, listAccounts, updateAccount } from '../db/accounts.js';
import { openDatabase, setDb } from '../db/index.js';
import { LIMITS } from '../policy.js';
import { getAccountOwner, listConnectableAccounts } from '../providers/index.js';

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

async function main(): Promise<void> {
  if (usingFakeProvider) {
    console.error(
      'UNIPILE_API_KEY is unset, so there is no real provider to connect to.\n' +
        'Set it in .env, or run `npm run seed` for the fake test account.',
    );
    process.exitCode = 1;
    return;
  }

  const db = openDatabase(config.databasePath);
  setDb(db);

  const linked = await listConnectableAccounts();
  if (linked.length === 0) {
    console.error(
      'The provider has no linked accounts yet.\n' +
        'Open the hosted auth link and log into LinkedIn first, then re-run this.',
    );
    process.exitCode = 1;
    db.close();
    return;
  }

  const wanted = process.argv[2];
  const existing = await listAccounts(config.singleUserId, db);
  const known = new Set(existing.map((a) => a.providerAccountId));

  if (!wanted) {
    console.log('Linked at the provider:\n');
    for (const a of linked) {
      const mark = known.has(a.providerAccountId) ? '(already in PostFold)' : '';
      console.log(`  ${a.providerAccountId}  ${a.network.padEnd(9)} ${a.displayName} ${mark}`);
      console.log(`      health: ${a.health.status}${a.health.reason ? ` — ${a.health.reason}` : ''}`);
    }
    console.log('\nConnect one with:  npm run connect -- <id> [timezone]');
    db.close();
    return;
  }

  const target = linked.find((a) => a.providerAccountId === wanted);
  if (!target) {
    console.error(`No linked account with id ${wanted}.`);
    process.exitCode = 1;
    db.close();
    return;
  }

  if (target.health.status !== 'active') {
    // Registering an unhealthy account is allowed — you may need the row to
    // exist so the UI can show you what is wrong — but it must not send.
    console.warn(
      `Warning: the provider reports this account as ${target.health.status}` +
        `${target.health.reason ? ` (${target.health.reason})` : ''}.`,
    );
  }

  const timezone = process.argv[3] ?? systemTimezone();
  const account = await createAccount(
    {
      userId: config.singleUserId,
      providerAccountId: target.providerAccountId,
      displayName: target.displayName,
      connectedAt: new Date(),
      timezone,
      sendDays: [...LIMITS.DEFAULT_SEND_DAYS],
    },
    db,
  );

  // Record who this account belongs to, so the engager pipeline can keep them
  // out of their own suggestions.
  let ownerPersonId: string | null = null;
  let isPremium: boolean | null = null;
  let headline: string | null = null;
  try {
    const owner = await getAccountOwner(target.providerAccountId);
    ownerPersonId = owner?.providerPersonId ?? null;
    isPremium = owner?.isPremium ?? null;
    headline = owner?.headline ?? null;
  } catch {
    console.warn('Could not read the account owner; self-filtering is off for this account.');
  }

  // Off until a human turns it on. See the note at the top of this file.
  await updateAccount(
    account.id,
    {
      ownerPersonId,
      isPremium,
      headline,
      sendingEnabled: false,
      status: target.health.status === 'active' ? 'paused' : target.health.status,
      pausedReason:
        'Newly connected. Check the account state, then press Resume to start sending.',
    },
    db,
  );

  console.log(`\nConnected ${target.displayName}`);
  console.log(`  PostFold account id : ${account.id}`);
  console.log(`  provider account id : ${target.providerAccountId}`);
  console.log(`  timezone            : ${timezone}`);
  console.log(`  warm-up             : day 1, ${LIMITS.DEFAULT_SEND_DAYS.length} send days/week`);
  console.log(
    `  tier                : ${isPremium === null ? 'unknown' : isPremium ? 'premium' : 'FREE'}`,
  );
  if (isPremium === false) {
    console.log(
      `
  A free account gets about ${LIMITS.FREE_WITH_NOTE_MONTHLY_CAP} invitations per MONTH when a note`,
    );
    console.log('  is attached — roughly 150 per week without one.');
  }
  console.log('\nSending is OFF. Open the app and press Resume when you are ready.');
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
