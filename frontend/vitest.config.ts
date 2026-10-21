import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { handbookPlugin } from './plugins/handbook.ts';

export default defineConfig({
  plugins: [handbookPlugin(), react()],
  resolve: { alias: { 'virtual:pwa-register/react': fileURLToPath(new URL('./src/test/pwa-register.ts', import.meta.url)) } },
  test: {
    maxWorkers: 4,
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: './src/test/setup.ts',
    restoreMocks: true,
    clearMocks: true,
  },
});
