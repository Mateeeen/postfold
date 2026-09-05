import { config, usingFakeProvider } from '../config.js';
import type {
  AccountOwner,
  ConnectableAccount,
  SocialProvider,
  WebhookAdapter,
} from '../provider.js';
import { FakeProvider } from './fake.js';
import { UnipileProvider, unipileWebhooks } from './unipile.js';

let cached: SocialProvider | null = null;

/**
 * The one place the concrete adapter is chosen. Callers take a
 * `SocialProvider` and never ask which one they got.
 */
export function getProvider(): SocialProvider {
  if (cached) return cached;
  if (usingFakeProvider) {
    console.warn(
      '[provider] UNIPILE_API_KEY is unset — using FakeProvider. Nothing will be sent to LinkedIn.',
    );
    cached = new FakeProvider();
  } else {
    cached = new UnipileProvider({
      baseUrl: config.unipileBaseUrl,
      apiKey: config.unipileApiKey as string,
    });
  }
  return cached;
}

/**
 * The webhook adapter for the configured provider. Routes take this rather
 * than importing the adapter, so nothing above src/providers/ names a vendor.
 */
export function getWebhookAdapter(): WebhookAdapter {
  return unipileWebhooks;
}

/**
 * Accounts this deployment could connect. Setup-time only, and only the real
 * adapter can answer it — on the FakeProvider there is nothing to list.
 */
export async function listConnectableAccounts(): Promise<ConnectableAccount[]> {
  if (usingFakeProvider) return [];
  return new UnipileProvider({
    baseUrl: config.unipileBaseUrl,
    apiKey: config.unipileApiKey as string,
  }).listConnectableAccounts();
}

/** Who a connected account belongs to. Setup-time only. */
export async function getAccountOwner(providerAccountId: string): Promise<AccountOwner | null> {
  if (usingFakeProvider) return null;
  return new UnipileProvider({
    baseUrl: config.unipileBaseUrl,
    apiKey: config.unipileApiKey as string,
  }).getAccountOwner(providerAccountId);
}

/** Test seam. */
export function setProvider(p: SocialProvider | null): void {
  cached = p;
}

export { FakeProvider } from './fake.js';
export { UnipileProvider } from './unipile.js';
