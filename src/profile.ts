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
import { getAccountOwner, getProvider } from './providers/index.js';

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

  // Impressions are per-post and only the owner's own posts carry them, so the
  // weekly figure is summed here rather than asked for. Reposts are excluded:
  // the reach belongs to whoever wrote the thing.
  let impressions7d: number | null = null;
  let posts7d: number | null = null;
  if (owner.providerPersonId) {
    try {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const page = await getProvider().listAuthoredPosts({
        providerAccountId: account.providerAccountId,
        providerPersonId: owner.providerPersonId,
        limit: 25,
      });
      const recent = page.items.filter(
        (p) => !p.isRepost && p.postedAt !== null && p.postedAt.getTime() >= since,
      );
      impressions7d = recent.reduce((n, p) => n + p.impressions, 0);
      posts7d = recent.length;
    } catch {
      // Reach is decoration. Losing it must not lose the profile refresh.
    }
  }

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
      followerCount: owner.followerCount,
      connectionsCount: owner.connectionsCount,
      ...(impressions7d === null
        ? {}
        : { impressions7d, posts7d, statsUpdatedAt: new Date() }),
    },
    db,
  );

  return true;
}
