/**
 * Image generation seam.
 *
 * Same shape as the LLM and provider seams, for the same reason: the thing
 * above this line asks for an image for a post, and never learns which vendor
 * drew it or what their response looks like.
 *
 * An image is always optional. Every caller must work when this returns null —
 * a post with no image is a post, and a drafting run that fails to draw
 * something must not lose the words it already wrote.
 */

export interface GeneratedImage {
  /** Where the image lives. Whether it expires is the adapter's problem. */
  url: string;
  /** The prompt that produced it, kept so a bad image is explainable. */
  prompt: string;
  model: string;
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;

  /**
   * Draw something for a post. Returns null when the provider declined or is
   * not configured; throws only on a fault worth surfacing.
   */
  draw(input: { prompt: string }): Promise<GeneratedImage | null>;
}

/** Errors that cross the seam, mirroring LlmError so the worker can classify. */
export class ImageError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'ImageError';
    this.retryable = options.retryable ?? false;
  }
}
