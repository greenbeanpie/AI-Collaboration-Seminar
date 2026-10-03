import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  define: { 'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(process.env.VITE_BUILD_VERSION || `build-${new Date().toISOString()}`) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: '补位 · AI 项目办公室',
        short_name: '补位',
        description: '协作推进项目材料、任务和过程记录',
        lang: 'zh-CN',
        theme_color: '#f4f6fa',
        background_color: '#f4f6fa',
        display: 'standalone',
        start_url: '/',
        // Chrome 安装性检查要求 192/512 位图图标；maskable 单独一条并提供安全区留白。
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff,woff2}'],
        // A waiting update activates only after SKIP_WAITING, then takes control.
        skipWaiting: false,
        clientsClaim: true,
        // Imported navigation handler owns network/offline fallback without runtime HTML caching.
        navigateFallback: null,
        importScripts: ['/navigation-worker.js', '/asset-compat.js', '/push-worker.js'],
        runtimeCaching: [{
          urlPattern: ({ url, sameOrigin }) => sameOrigin && /^\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname),
          handler: 'CacheFirst',
          options: { cacheName: 'ai-office-assets-compat-v1', cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 256, maxAgeSeconds: 7 * 24 * 60 * 60 } },
        }],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.AI_OFFICE_API_TARGET || 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
