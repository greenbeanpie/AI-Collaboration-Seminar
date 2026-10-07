export const securityHeaders: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; worker-src 'self' blob:; media-src 'self' blob:",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  'X-Frame-Options': 'DENY',
};
export function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);

  if (headers.get('Content-Type')?.includes('text/html') && response.status !== 304) {
    // Cloudflare JavaScript Detections reads CSP nonces and applies them to its injected scripts.
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    headers.set('Content-Security-Policy', securityHeaders['Content-Security-Policy']!.replace("script-src 'self'", "script-src 'self' 'nonce-" + nonce + "'"));
    headers.set('Cache-Control', 'no-store');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
