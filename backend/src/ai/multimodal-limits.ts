/** Serialized transport bounds; image bytes are not model text characters. */
export const MULTIMODAL_LIMITS = {
  images: 3,
  imageBytes: 2 * 1024 * 1024,
  // Three maximum-size images encoded in base64, including padding and small URL envelopes.
  imagePayloadBytes: 8 * 1024 * 1024 + 4096,
  requestBytes: 9 * 1024 * 1024,
} as const;
