import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function getAllowedHosts(): string[] {
  // `.ts.net` permits Tailscale MagicDNS hostnames (e.g. <machine>.<tailnet>.ts.net)
  // so the dev server is reachable over the tailnet, alongside the local proxy host.
  const base = ['ci-server.localhost', '.ts.net'];
  const hostname = process.env.APP_PUBLIC_HOSTNAME;

  if (!hostname) {
    return base;
  }

  try {
    const url = new URL(hostname);

    return [...base, url.hostname];
  } catch {
    return [...base, hostname];
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
    // When WEB_PORT is set, bind exactly that port and fail rather than
    // drifting to the next free one, which is Vite's default. A reverse proxy
    // in front routes to this exact port, so a silent fallback would leave it
    // pointing at nothing. A plain `yarn dev` has no WEB_PORT and keeps the
    // auto-increment fallback.
    //
    // allowedHosts permits any *.localhost, since the app is served behind the
    // proxy at https://<name>.localhost rather than one fixed hostname. HMR
    // needs no extra config. Vite connects to the page's own origin, which the
    // proxy forwards.
    port: Number(process.env.WEB_PORT) || 5173,
    strictPort: Boolean(process.env.WEB_PORT),
    // `.companionintelligence.com` allows serving a preview through a Cloudflare
    // Tunnel (see infrastructure/cloudflare/). The tunnel normally rewrites the
    // Host to <stack>.localhost, but this also permits preserving the public host.
    allowedHosts: ['.localhost', '.companionintelligence.com', ...getAllowedHosts()],
    // Dev-only: the app calls `/api/*` (and `/api/graphql`) as same-origin paths.
    // Under `make dev`, the Caddy proxy strips the `/api` prefix and forwards to
    // the API, so this block is never exercised there. When the Vite dev server
    // is run standalone (e.g. the Claude preview), bridge `/api` to the local API
    // the same way Caddy does — strip `/api`. Override the target per session with
    // API_PROXY_TARGET (e.g. this worktree's API on its assigned port).
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:64669',
        changeOrigin: true,
        // Forward X-Forwarded-Host/Proto so the API derives OIDC callback URLs
        // from the real browser-facing host (e.g. the tailnet hostname) rather
        // than the proxy target — otherwise the OIDC redirect_uri is localhost.
        xfwd: true,
        rewrite: (requestPath) => requestPath.replace(/^\/api/, ''),
      },
      // Dev-only: the app renders object-store media (photo previews, file
      // downloads) via same-origin `/static/...` URLs — signed MinIO paths with
      // the `/static` prefix the app adds (see resolveStaticUrl / MediaTile).
      // Under `make dev`, Caddy strips `/static` and proxies to MinIO, REWRITING
      // the Host to the object store's signing host so the presigned SigV4
      // signature still validates (presigned URLs are host-specific). When Vite
      // runs standalone (accessed directly on :5173, e.g. over the tailnet), that
      // Caddy hop is absent, so `/static/*` fell through to the SPA fallback and
      // returned index.html — every <img> got HTML instead of bytes (broken
      // thumbnails). Mirror Caddy here: strip `/static`, forward to MinIO, and
      // force Host to the signing host so the signature matches.
      '/static': {
        target: process.env.STATIC_PROXY_TARGET || 'http://localhost:9000',
        changeOrigin: false,
        rewrite: (requestPath) => requestPath.replace(/^\/static/, ''),
        configure: (proxy) => {
          const signingHost = process.env.STATIC_PROXY_HOST || 'object-store:9000';
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Host', signingHost);
          });
        },
      },
    },
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
