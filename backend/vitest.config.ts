import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

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
    // setup 在 worker 运行时内执行：按序应用 migrations/ 下的 D1 迁移
    setupFiles: ['./test/setup.ts'],
  },
});
