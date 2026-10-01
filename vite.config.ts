import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the build works from any static host or sub-path
// (GitHub Pages project site, Cloudflare Pages, a USB stick...).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered manually in src/main.ts (reload deferred until idle)
      // workbox.globPatterns already precaches every svg/png in public/ (icons included),
      // so don't list them a second time.
      includeManifestIcons: false,
      manifest: {
        name: 'KeySplash',
        short_name: 'KeySplash',
        description: 'A fullscreen, ad-free, offline keyboard smash toy for babies and toddlers.',
        theme_color: '#f5f2ec',
        background_color: '#f5f2ec',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,mp3}'],
        navigateFallback: 'index.html',
        // injectRegister:false turns off the plugin's autoUpdate defaults, so set them here:
        // a new version activates right away, and src/main.ts reloads into it only when
        // play is back on the start screen (never in front of a toddler mid-play).
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
});
