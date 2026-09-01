/**
 * The Jobs fixture preview — `.claude/launch.json`'s `jobs-preview`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The Jobs page cannot be developed from a worktree. The dev stack shares one
 * appliance database, which is routinely ahead of a branch's migrations, and
 * the API refuses to boot against a schema it did not migrate — by design. So
 * the page whose entire job is rendering the state of the queues had no way to
 * be looked at while it was being changed.
 *
 * This serves it with no API, no Postgres and no pg-boss: the real page, the
 * real hooks, and a middleware that answers its five requests out of a fixture
 * corpus (see `src/preview/jobs/previewApi.ts`).
 *
 *   yarn workspace @ci/fe-web vite --config vite.preview.config.ts
 *
 * ── What it is not ─────────────────────────────────────────────────────────
 *
 * Not a test, and not a substitute for one — the fixture server reimplements
 * the API's filtering semantics and can drift from them. It is for the half of
 * this page that only a browser can show: axis ranges, six-figure ticks, the
 * phone fold, a 12,710-row backlog next to a 3-row queue, a stack trace in an
 * expanded row.
 */

import path from 'node:path';

import { defineConfig, type Plugin, type UserConfig } from 'vite';

import { jobsPreviewApi } from './src/preview/jobs/previewApi';
import baseConfig from './vite.config';

const base = baseConfig as UserConfig;

/**
 * Serve the preview at `/`.
 *
 * The launch configuration opens the port's root, and `index.html` there is the
 * whole application — which would immediately try to log in against an
 * appliance that is not running. Registered from `configureServer`'s body, so
 * it lands ahead of Vite's own HTML middleware.
 */
function previewIndex(): Plugin {
  return {
    name: 'ci:jobs-preview-index',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url === '/index.html') {
          req.url = '/jobs-preview.html';
        }

        next();
      });
    },
  };
}

export default defineConfig({
  // Inherit the app's plugins (React, Tailwind), aliases and dependency
  // handling — @powersync/web's worker exclusions in particular — so the
  // preview compiles the same sources the same way.
  plugins: [...(base.plugins ?? []), previewIndex(), jobsPreviewApi()],
  resolve: base.resolve,
  optimizeDeps: base.optimizeDeps,
  worker: base.worker,

  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT) || 5199,
    // Fail rather than drift: the launch configuration names this port, and a
    // silent fallback would leave it pointing at nothing.
    strictPort: true,
    allowedHosts: ['.localhost', '.ts.net'],
    fs: {
      allow: ['.', path.resolve(__dirname, '../../packages'), path.resolve(__dirname, '../../../.yarn')],
    },
    // NOTE: the base config's `/api` and `/static` proxies are deliberately NOT
    // inherited. `jobsPreviewApi` answers `/api/*` itself, and a proxy
    // underneath it would let an unhandled route reach a real appliance — a
    // preview that is sometimes live is worse than one that is never live.
  },
});
