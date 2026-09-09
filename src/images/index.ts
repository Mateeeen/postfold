/**
 * The one place the image model is chosen. Same contract as getLlm() and
 * getProvider(): callers take an ImageProvider and never ask which one.
 */

import { config, usingFakeImages } from '../config.js';
import type { ImageProvider } from '../images.js';
import {
  FakeImages,
  GeminiImages,
  PollinationsImages,
  TogetherImages,
} from './together.js';

let cached: ImageProvider | null = null;

export function getImages(): ImageProvider {
  if (cached) return cached;
  if (config.imageProvider === 'none') {
    // Explicitly off. Returns null rather than a placeholder: a stand-in image
    // is right for a test and very wrong on a live account, where it would be
    // attached to a real post.
    cached = new FakeImages({ returnNull: true });
  } else if (config.imageProvider === 'gemini') {
    if (!config.geminiApiKey) {
      console.warn('[images] IMAGE_PROVIDER=gemini but GEMINI_API_KEY is unset - no images.');
      cached = new FakeImages({ returnNull: true });
    } else {
      // IMAGE_MODEL defaults to a Together model id, which would be nonsense
      // here. Only honour it when it names a Gemini model.
      cached = new GeminiImages({
        apiKey: config.geminiApiKey,
        model: config.imageModel.startsWith('gemini') ? config.imageModel : undefined,
      });
    }
  } else if (config.imageProvider === 'pollinations') {
    cached = new PollinationsImages();
  } else if (usingFakeImages) {
    console.warn('[images] no TOGETHER_API_KEY - posts will be drafted without images.');
    cached = new FakeImages({ returnNull: true });
  } else {
    cached = new TogetherImages({
      baseUrl: config.imageBaseUrl,
      apiKey: config.imageApiKey as string,
      model: config.imageModel,
    });
  }
  return cached;
}

/** Test seam. */
export function setImages(i: ImageProvider | null): void {
  cached = i;
}
