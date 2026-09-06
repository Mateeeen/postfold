/**
 * The account owner as a person: name, headline, face, location, tier.
 *
 * Kept fresh rather than fetched once. The avatar URL the platform hands out
 * is signed and carries an expiry, so a value cached at connect time stops
 * loading after a while — which looks like a broken product rather than an
 * expired link. Refreshing on the same schedule as the content sync costs one
 * request and keeps it working.
 *
 * Everything here is display material. Tier is the exception: it decides the
 * note allowance, which is why a failed refresh leaves the stored value alone
 * instead of writing null over a known answer.
 */

import { getAccount, updateAccount } from './db/accounts.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import { getAccountOwner } from './providers/index.js';

export async function refreshOwnerProfile(
  accountId: string,
  db: Db = getDb(),
): Promise<boolean> {
  const account = await getAccount(accountId, db);
  if (!account) return false;

  // Deliberately the module helper, not a SocialProvider method: reading your
  // own profile is setup-and-display work that only the real adapter answers,
  // and putting it on the seam would oblige every provider to implement it.
  const owner = await getAccountOwner(account.providerAccountId);
  if (!owner) return false;

  await updateAccount(
    accountId,
    {
      ownerPersonId: owner.providerPersonId,
      headline: owner.headline,
      avatarUrl: owner.avatarUrl,
      publicIdentifier: owner.publicIdentifier,
      location: owner.location,
      // Only overwrite the tier when the provider actually said. Null here
      // means "did not answer", and treating that as "free" would silently
      // cut a premium account's note allowance.
      ...(owner.isPremium === null ? {} : { isPremium: owner.isPremium }),
    },
    db,
  );

  return true;
}
