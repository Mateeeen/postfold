/**
 * The only file that knows Together AI exists.
 *
 * FLUX.1-schnell on the free tier. The response hands back a URL on their CDN
 * that expires within about an hour, which is why the image is fetched and
 * re-hosted rather than stored as a link: a draft sits for 24 hours before it
 * publishes, so a stored URL would be dead by the time it mattered.
 */

import { ImageError } from '../images.js';
import type { GeneratedImage, ImageProvider } from '../images.js';

export interface TogetherConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ImageResponse {
  data?: { url?: string; b64_json?: string }[];
  error?: { message?: string };
}

export class TogetherImages implements ImageProvider {
  readonly name = 'together';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: TogetherConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async draw(input: { prompt: string }): Promise<GeneratedImage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt: input.prompt,
          // 1200x628 is the shape a link preview gets rendered at; anything
          // squarer is cropped by the feed and loses whatever was at the edges.
          width: 1200,
          height: 628,
          steps: 4,
          n: 1,
          response_format: 'b64_json',
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ImageError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Image generation timed out'
          : 'Could not reach the image provider',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      // 429 and 5xx are worth another attempt; a 400 means the prompt or the
      // model id is wrong and retrying just burns the free tier.
      throw new ImageError(`Image provider returned ${res.status}: ${text.slice(0, 200)}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    let body: ImageResponse;
    try {
      body = JSON.parse(text) as ImageResponse;
    } catch {
      throw new ImageError('Image provider returned a non-JSON envelope', { retryable: true });
    }

    const first = body.data?.[0];
    if (!first) return null;

    // Inlined as a data URI. The alternative is storing their CDN link, which
    // expires long before the 24-hour review window closes.
    const url = first.b64_json
      ? `data:image/jpeg;base64,${first.b64_json}`
      : (first.url ?? null);
    if (!url) return null;

    return { url, prompt: input.prompt, model: this.model };
  }
}

/** Logs instead of drawing. Used when there is no key, and in tests. */
export class FakeImages implements ImageProvider {
  readonly name = 'fake';
  readonly model = 'fake-image';
  readonly calls: string[] = [];

  constructor(private readonly options: { log?: (m: string) => void; returnNull?: boolean } = {}) {}

  async draw(input: { prompt: string }): Promise<GeneratedImage | null> {
    this.calls.push(input.prompt);
    (this.options.log ?? ((m: string) => console.log(`[fake-images] ${m}`)))(input.prompt);
    if (this.options.returnNull) return null;
    // A 1x1 transparent GIF: valid, tiny, and obviously not a real picture.
    return {
      url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      prompt: input.prompt,
      model: this.model,
    };
  }
}

/**
 * Pollinations: free, keyless, no account.
 *
 * Here because Together's "Free" model tier still requires credits on the
 * account, which makes it useless until someone pays. This has no such
 * gate. The trade is real and worth stating: no uptime guarantee, no
 * capacity guarantee, and output quality varies run to run.
 *
 * Same contract as every other adapter — returns null rather than throwing
 * when it simply has nothing to give, so a bad day costs an image and never
 * a post.
 */
export class PollinationsImages implements ImageProvider {
  readonly name = 'pollinations';
  readonly model: string;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: { model?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    // Pollinations' model list is now exactly ["sana"]; asking for "flux"
    // silently returned Sana instead, which is most of why these looked bad.
    this.model = config.model ?? 'sana';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 90_000;
  }

  async draw(input: { prompt: string }): Promise<GeneratedImage | null> {
    const url =
      `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt)}` +
      `?width=1200&height=628&nologo=true&model=${encodeURIComponent(this.model)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        throw new ImageError(`Image provider returned ${res.status}`, {
          retryable: res.status === 429 || res.status >= 500,
        });
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      // Generation is slow enough that a truncated or error response is a real
      // possibility; anything this small is not a picture.
      if (bytes.length < 1024) return null;

      const mime = res.headers.get('content-type') ?? 'image/jpeg';
      return {
        url: `data:${mime};base64,${bytes.toString('base64')}`,
        prompt: input.prompt,
        model: this.model,
      };
    } catch (err) {
      if (err instanceof ImageError) throw err;
      throw new ImageError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Image generation timed out'
          : 'Could not reach the image provider',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Google AI Studio — Gemini image generation.
 *
 * Chosen over the alternatives for output quality on editorial illustration,
 * which is the only kind of image this product makes.
 *
 * The response is inline base64 rather than a URL, which suits us: the image
 * is stored as a data URI anyway, so there is no expiring link to lose during
 * the day a draft spends waiting.
 */
export class GeminiImages implements ImageProvider {
  readonly name = 'gemini';
  readonly model: string;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: {
    apiKey: string;
    model?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-2.5-flash-image';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 90_000;
  }

  async draw(input: { prompt: string }): Promise<GeneratedImage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          this.model,
        )}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: input.prompt }] }],
            generationConfig: {
              responseModalities: ['IMAGE'],
              // 1.91:1 is what the feed crops a link image to. Asking for it
              // beats generating a square and letting the platform choose
              // which third of the picture to throw away.
              imageConfig: { aspectRatio: '16:9' },
            },
          }),
          signal: controller.signal,
        },
      );
    } catch (err) {
      throw new ImageError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Image generation timed out'
          : 'Could not reach the image provider',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ImageError(`Image provider returned ${res.status}: ${text.slice(0, 200)}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    let body: {
      candidates?: {
        content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
        finishReason?: string;
      }[];
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new ImageError('Image provider returned a non-JSON envelope', { retryable: true });
    }

    // A safety filter returns a candidate with no image rather than an error.
    // Null is the right answer for that: the post still goes out, without one.
    const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const data = part?.inlineData?.data;
    if (!data) return null;

    return {
      url: `data:${part?.inlineData?.mimeType ?? 'image/png'};base64,${data}`,
      prompt: input.prompt,
      model: this.model,
    };
  }
}
