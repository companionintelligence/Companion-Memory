import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defaultAllowedOrigins, defineConfig, type Plugin } from 'vite';
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

/**
 * Publish the canon's vanilla stylesheet at a stable same-origin URL.
 *
 * `@companionintelligence/tokens/tokens.css` is the canon for pages that run no
 * bundler. The API's GraphiQL page is one (`backend/apps/api/src/domains/
 * graphql/controllers/graphiql.html.ts`): it is a string served by NestJS, and
 * the API image cannot install the package — its Docker build has no GitHub
 * Packages credential — so this build, which already has the package, serves
 * the file and that page links `/brand/tokens.css`. The canon rule is consume,
 * never copy (CI-Common UI-STYLE-GUIDE §11); reading it from the package here
 * is what keeps a token change reaching that page with a version bump.
 *
 * Emitted as `brand/tokens.css` (not `assets/`) on purpose: the name is stable
 * across releases, and the gateway's `/assets/` location marks everything
 * under it immutable.
 */
const BRAND_TOKENS_PATH = 'brand/tokens.css';

function brandTokens(): Plugin {
  const tokensCss = () =>
    readFileSync(createRequire(import.meta.url).resolve('@companionintelligence/tokens/tokens.css'), 'utf8');

  return {
    name: 'ci:brand-tokens',
    configureServer(server) {
      server.middlewares.use(`/${BRAND_TOKENS_PATH}`, (_req, res) => {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.end(tokensCss());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: BRAND_TOKENS_PATH, source: tokensCss() });
    },
  };
}

// In a Capacitor native build the web assets are served from the local app bundle,
// where the Workbox service worker fights Capacitor's own asset serving and the
// now cross-origin `/api` calls. The mobile build sets VITE_DISABLE_PWA=true to
// drop the PWA plugin (Vite ignores falsy entries in `plugins`); offline support
// on native is provided by the on-device SQLite/local-first layer instead.
const disablePwa = process.env.VITE_DISABLE_PWA === 'true';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    brandTokens(),
    !disablePwa &&
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
          // Pre-caches all matching assets. Default 2 MiB rejects the main
          // bundle once it crossed that line (~2.11 MB at last production build).
          globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,

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
              // Match API requests, excluding OIDC auth redirects which cross
              // origins — and excluding every STREAMING endpoint. A response
              // proxied through a service worker dies when the browser
              // terminates the idle worker (Chrome's hard cap is ~30s), so a
              // chat turn intercepted here collapsed at ~28s with a bare
              // "TypeError: network error" while the server streamed on:
              // measured live against /api/llm/generate. Requests matching no
              // rule are not intercepted at all, which is exactly what a
              // long-lived stream needs.
              urlPattern: /\/api\/(?!authenticate\/oidc|llm\/generate|llm\/threads\/[^/]+\/stream|mcp\b)/,
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
    // Vite's own CORS middleware answers EVERY preflight itself, ahead of the
    // `/api` proxy below, and its default allowlist is http(s) localhost only. A
    // bundled iOS shell calling this dev server (its Memory Server set to
    // http://<lan-ip>:5173) runs at `capacitor://localhost`, so its preflight got
    // a 204 with no `Access-Control-Allow-Origin`: the WebView refused it,
    // `streamingFetch` fell back to the buffered CapacitorHttp path, and every
    // chat reply arrived whole after the generation ended — with no Stop control,
    // because a buffered reply is never "streaming". The appliance origin was
    // never affected: nginx forwards the preflight to the API, which already allows
    // these origins (`main.ts`). Android's `http(s)://localhost` is in Vite's
    // default, so only the two custom schemes are added to it.
    cors: { origin: [defaultAllowedOrigins, 'capacitor://localhost', 'ionic://localhost'] },
    // Dev-only: the app calls `/api/*` (and `/api/graphql`) as same-origin paths.
    // On `make dev`'s Caddy route, Caddy strips the `/api` prefix and forwards to
    // the API, so this block is not involved there. Whenever the Vite port is
    // opened directly — under `make dev` too, or with the dev server run
    // standalone (e.g. the Claude preview) — bridge `/api` to the local API the
    // same way Caddy does: strip `/api`. `make dev` sets API_PROXY_TARGET to this
    // worktree's API on its assigned port; set it yourself when running Vite alone.
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
      // Dev-only: the app renders object-store media (photo previews, video
      // posters, file downloads) via same-origin `/static/...` URLs — presigned
      // object-store paths with the `/static` prefix the app adds (see
      // resolveStaticUrl / MediaTile). On the Caddy route, Caddy strips
      // `/static` and proxies to the object store, REWRITING the Host to its
      // signing host so the presigned SigV4 signature still validates
      // (presigned URLs are host-specific). Opened directly on its own port
      // (e.g. over the tailnet) Vite has no Caddy hop in front of it, so
      // `/static/*` fell through to the SPA fallback and returned index.html —
      // every <img> got HTML instead of bytes (broken thumbnails). Mirror Caddy
      // here: strip `/static`, forward to the object store, and force Host to
      // the signing host so the signature matches.
      //
      // `make dev` always sets STATIC_PROXY_TARGET, to the port Caddy's
      // `/static` route dials (scripts/dev-stack/overmind-env.ts). The fallback
      // is for launchers that set nothing — a bare `yarn dev`, the Claude
      // preview, Playwright's webServer (e2e.yml publishes the store on 9000):
      // compose's default port, which is this checkout's store only while no
      // other worktree's stack holds it. 127.0.0.1, not `localhost`: compose
      // publishes the object store on IPv4 loopback only.
      '/static': {
        target: process.env.STATIC_PROXY_TARGET || 'http://127.0.0.1:9000',
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
      // Vite auto-allows the Yarn PnP cache (`.yarn/cache`) but not the virtual
      // paths PnP hands out for packages with peer dependencies
      // (`.yarn/__virtual__/<pkg>/0/cache/<zip>/node_modules/...`). @powersync/web
      // is one, and it reaches its SQLite worker via `new URL(..., import.meta.url)`
      // — a plain file request, not an import, so it gets no module-graph
      // exemption and the dev server answers 403 without this entry.
      allow: ['.', path.resolve(__dirname, '../../packages'), path.resolve(__dirname, '../../../.yarn')],
    },
    warmup: {
      clientFiles: ['./src/main.tsx'],
    },
  },
  optimizeDeps: {
    include: ['@ci/shadcn', 'react', 'react-dom', 'react-router-dom'],
    // @powersync/web must not be pre-bundled: it opens its SQLite worker via
    // `new SharedWorker(new URL('./WASQLiteDB.worker.js', import.meta.url))`,
    // and once the package is flattened into `.vite/deps/@powersync_web.js`
    // that URL resolves to a file that does not exist (Vite logs "The file
    // does not exist at .../.vite/deps/WASQLiteDB.worker.js"). The database
    // then never becomes ready, and anything awaiting it — logout's
    // `disconnectAndClear()` — hangs. This is PowerSync's own Vite example
    // config (demos/example-vite/vite.config.ts). Dev-only: the production
    // build handles `new URL(..., import.meta.url)` workers itself.
    exclude: ['@powersync/web', '@powersync/capacitor', '@capacitor-community/sqlite'],
  },
  worker: {
    // @powersync/web ships its SQLite worker as an ES module; the default
    // 'iife' format can't be code-split and fails the production build with
    // "UMD and IIFE output formats are not supported for code-splitting
    // builds." This is PowerSync's own documented Vite integration step.
    format: 'es',
  },
});
