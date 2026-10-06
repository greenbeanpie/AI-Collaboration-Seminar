// Deliberately narrow, dependency-free defense. Provider-side GitHub scanning
// remains the authoritative complementary check; never print the matched secret.
export const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{70,}\b/,
  /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{40,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
export function containsSecret(text) { return secretPatterns.some(pattern => pattern.test(text)); }
