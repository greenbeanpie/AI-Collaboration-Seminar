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
    // Dispose Workflow instances from setup before per-file fetch mocks are removed.
    sequence: { hooks: 'list' },
    // setup 在 worker 运行时内执行：按序应用 migrations/ 下的 D1 迁移
    setupFiles: ['./test/setup.ts'],
  },
});
