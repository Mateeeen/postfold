import 'dotenv/config';

export interface Config {
  port: number;
  databasePath: string;
  unipileBaseUrl: string;
  unipileApiKey: string | null;
  unipileWebhookSecret: string | null;
  /** Single-user build. See src/http/auth.ts. */
  singleUserId: string;

  /**
   * Shared token gating the whole API. Unset is fine on localhost; the server
   * refuses to start a public deployment without one.
   */
  appToken: string | null;
  /** Exact origins allowed to call this API from a browser. */
  allowedOrigins: string[];
  /** True when this instance is reachable from the internet. */
  isPublic: boolean;

  /** Any OpenAI-compatible chat-completions endpoint. */
  llmBaseUrl: string;
  llmApiKey: string | null;
  llmModel: string;
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : null;
}

export const config: Config = {
  port: Number(process.env['PORT'] ?? 3000),
  databasePath: process.env['DATABASE_PATH'] ?? './data/postfold.db',
  unipileBaseUrl: process.env['UNIPILE_BASE_URL'] ?? 'https://api.unipile.com',
  unipileApiKey: optional('UNIPILE_API_KEY'),
  unipileWebhookSecret: optional('UNIPILE_WEBHOOK_SECRET'),
  singleUserId: process.env['SINGLE_USER_ID'] ?? 'user_local',
  llmBaseUrl: process.env['LLM_BASE_URL'] ?? 'https://api.groq.com/openai/v1',
  llmApiKey: optional('LLM_API_KEY'),
  llmModel: process.env['LLM_MODEL'] ?? 'openai/gpt-oss-120b',
  appToken: optional('APP_TOKEN'),
  allowedOrigins: (process.env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== ''),
  // Railway sets this; locally it is unset and the gate stays optional.
  isPublic:
    optional('PUBLIC_DEPLOYMENT') === 'true' ||
    optional('RAILWAY_PUBLIC_DOMAIN') !== null,
};

/** True when we are running without third-party credentials. */
export const usingFakeProvider = config.unipileApiKey === null;

/** True when no drafting model is configured; drafts become placeholders. */
export const usingFakeLlm = config.llmApiKey === null;
