import { expect, it } from 'vitest';
import { aiSecret, checkpointSecret, purposeSecret, seal, unseal } from '../src/ai/secrets';
import { consumePasswordRateLimit } from '../src/services/accounts';
import { hmacSha256Hex } from '../src/core/db';
import { env } from './helpers/env';
it('versioned purpose ciphertext reads historical secrets and rejects wrong purpose or root', async () => {
  const legacy = await seal('既有 API key', env.AUTH_SECRET);
  const configured = { ...env, AI_CONFIG_SECRET: 'new-ai-key', CHECKPOINT_SECRET: 'new-checkpoint-key' };
  expect(await unseal(legacy, aiSecret(configured))).toBe('既有 API key');
  const ciphertext = await seal('new API key', aiSecret(configured));
  expect(ciphertext).toMatch(/^v2:ai-config:/);
  expect(await unseal(ciphertext, aiSecret(configured))).toBe('new API key');
  await expect(unseal(ciphertext, checkpointSecret(configured))).rejects.toThrow();
  await expect(unseal(ciphertext, aiSecret({ ...configured, AI_CONFIG_SECRET: 'wrong-key' }))).rejects.toThrow();
  await expect(unseal(ciphertext, env.AUTH_SECRET)).rejects.toThrow();
  const checkpoint = await seal('private excerpt', checkpointSecret(env));
  expect(await unseal(checkpoint, checkpointSecret(env))).toBe('private excerpt');
  await expect(unseal(checkpoint, aiSecret(env))).rejects.toThrow();
});
it('derives deterministic distinct purposes with optional independent roots', async () => {
  const media = await purposeSecret(env, 'media-grant');
  expect(await purposeSecret(env, 'media-grant')).toBe(media);
  expect(await purposeSecret(env, 'rate-limit')).not.toBe(media);
  expect(await purposeSecret({ ...env, MEDIA_GRANT_SECRET: 'separate-root' }, 'media-grant')).not.toBe(media);
});
it('honors a pre-upgrade exhausted rate window', async () => {
  const scope = 'legacy-test-' + crypto.randomUUID();
  const window = Math.floor(Date.now() / 900000);
  const key = await hmacSha256Hex(env.AUTH_SECRET, `${scope}|identity|${window}`);
  await env.DB.prepare('INSERT INTO auth_password_rate_limits(bucket_key,attempts,expires_at) VALUES(?1,?2,?3)').bind(key, 5, new Date((window + 1) * 900000).toISOString()).run();
  await expect(consumePasswordRateLimit(env, scope, 'identity', 5, 900)).rejects.toThrow();
});
