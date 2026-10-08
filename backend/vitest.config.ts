import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Test the deployed compatibility date using the explicitly pinned runtime.
process.env.MINIFLARE_WORKERD_PATH = createRequire(import.meta.url)('workerd').default;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          AUTH_SECRET: 'test-auth-secret',
          CLOUDFLARE_API_TOKEN: 'test-cf-token',
          CLOUDFLARE_ACCOUNT_ID: 'test-account-id',
          AI_GATEWAY_ID: 'test-gateway-id',
          ADMIN_TOKEN: 'test-admin-token',
        },
      },
    }),
  ],
  test: {
    maxWorkers: 4,
    // These are workerd + D1 + Workflow integration cases, not unit tests: one case can run a
    // full parse/review pipeline. Under a 4-core CI runner that exceeds vitest's 5s default,
    // which failed two CI runs with "Test timed out in 5000ms" (70-sources-parse, 82-agents).
    // draft-execution-continuation already had to raise its own limit to 30s for the same reason.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Dispose Workflow instances from setup before per-file fetch mocks are removed.
    sequence: { hooks: 'list' },
    // setup 在 worker 运行时内执行：按序应用 migrations/ 下的 D1 迁移
    setupFiles: ['./test/setup.ts'],
  },
});
