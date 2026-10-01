import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
      workbox: { navigateFallbackDenylist: [/^\/api(?:\/.*)?$/], runtimeCaching: [] },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
