/** Accept API envelopes, job errors, native errors, or direct reason strings. */
export function errorMessage(error: unknown, fallback = '发生了未知错误。'): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string') return value.message;
    if (value.error !== undefined && value.error !== error) return errorMessage(value.error, fallback);
  }
  return fallback;
}
