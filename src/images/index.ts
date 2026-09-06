/**
 * The one place the image model is chosen. Same contract as getLlm() and
 * getProvider(): callers take an ImageProvider and never ask which one.
 */

import { config, usingFakeImages } from '../config.js';
import type { ImageProvider } from '../images.js';
import { FakeImages, TogetherImages } from './together.js';

let cached: ImageProvider | null = null;

export function getImages(): ImageProvider {
  if (cached) return cached;
  // No key means no pictures - NOT a placeholder picture. The fake provider
  // returns a stand-in image, which is right for a test and very wrong on a
  // live account, where it would be attached to a real post.
  cached = usingFakeImages
    ? new FakeImages({ returnNull: true })
    : new TogetherImages({
        baseUrl: config.imageBaseUrl,
        apiKey: config.imageApiKey as string,
        model: config.imageModel,
      });
  return cached;
}

/** Test seam. */
export function setImages(i: ImageProvider | null): void {
  cached = i;
}
