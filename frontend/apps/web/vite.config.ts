import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function getAllowedHosts(): string[] {
  const hostname = process.env.HOSTNAME;

  if (!hostname) {
    return ['memory.ci.localhost'];
  }

  try {
    const url = new URL(hostname);

    return [url.hostname];
  } catch {
    return [hostname];
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Companion Intelligence',
        short_name: 'Companion',
        description: 'Your AI-powered assistant',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/logo-180x180.png',
            sizes: '180x180',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/logo-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/logo-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
      workbox: {
        // Pre-caches all matching assets.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],

        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Match any request that ends with .png, .jpg, .jpeg or .svg.
            // Treat these as static files that should be persisted in the
            // application cache.
            urlPattern: /\.(?:png|jpg|jpeg|svg)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 Days
              },
            },
          },
          {
            // Match API requests, excluding OIDC auth redirects which cross origins
            urlPattern: /\/api\/(?!authenticate\/oidc)/,
            handler: 'NetworkOnly',
            options: {
              backgroundSync: {
                name: 'api-queue',
                options: {
                  maxRetentionTime: 24 * 60,
                },
              },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // This package is type-only; resolve to empty module for runtime
      '@graphql-typed-document-node/core': path.resolve(
        __dirname,
        './src/graphql/typed-document-node-shim.ts',
      ),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: getAllowedHosts(),
    fs: {
      allow: ['.', path.resolve(__dirname, '../../packages')],
    },
    warmup: {
      clientFiles: ['./src/main.tsx'],
    },
  },
  optimizeDeps: {
    include: ['@ci/shadcn', 'react', 'react-dom', 'react-router-dom'],
  },
});
