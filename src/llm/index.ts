import { config, usingFakeLlm } from '../config.js';
import type { LlmProvider } from '../llm.js';
import { FakeLlm } from './fake.js';
import { GroqLlm } from './groq.js';

let cached: LlmProvider | null = null;

/**
 * The one place the drafting model is chosen. Callers take an `LlmProvider`
 * and never ask which one they got — same contract as getProvider().
 */
export function getLlm(): LlmProvider {
  if (cached) return cached;
  if (usingFakeLlm) {
    console.warn(
      '[llm] LLM_API_KEY is unset — using FakeLlm. Drafts are placeholders, not model output.',
    );
    cached = new FakeLlm();
  } else {
    cached = new GroqLlm({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey as string,
      model: config.llmModel,
    });
  }
  return cached;
}

/** Test seam. */
export function setLlm(l: LlmProvider | null): void {
  cached = l;
}

export { FakeLlm } from './fake.js';
export { GroqLlm } from './groq.js';
