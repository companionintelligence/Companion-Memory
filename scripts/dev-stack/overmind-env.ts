/**
 * overmind-env — the environment the Procfile's processes (api, worker, web)
 * run under: where each of them finds this stack's services.
 *
 * Every address is derived from the stack's allocated ports (./ports), never
 * left to a consumer's own default. A default names the conventional port, and
 * the conventional port belongs to whichever worktree's stack claimed it first.
 */
import type { StackPorts } from './ports';

/**
 * The address the host-run API listens on. DEV_LISTEN_HOST (from .env or the
 * shell) wins; it is the same switch Vite reads, for testing from a phone on the
 * LAN or over the tailnet.
 *
 * Otherwise loopback, except on Linux. The HBPE and Summary containers call the
 * API back at `host.docker.internal` (docker-compose.local.yml), and on native
 * Linux Docker that name is the docker bridge gateway, not this machine's
 * loopback, so an API on 127.0.0.1 would never see those callbacks. Docker
 * Desktop on macOS forwards it to the host's loopback, so there loopback is
 * enough. The API used to listen on 0.0.0.0 everywhere.
 */
export function apiListenHost(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (base.DEV_LISTEN_HOST) {
    return base.DEV_LISTEN_HOST;
  }

  return platform === 'linux' ? '0.0.0.0' : '127.0.0.1';
}

export function buildOvermindEnv(
  base: NodeJS.ProcessEnv,
  ports: StackPorts,
  { host, socket, platform = process.platform }: { host: string; socket: string; platform?: NodeJS.Platform },
): NodeJS.ProcessEnv {
  return {
    ...base,
    PORT: String(ports.apiPort),
    // Mapped to the API's `host` by config/custom-environment-variables.json.
    API_LISTEN_HOST: apiListenHost(base, platform),
    API_PORT: String(ports.apiPort),
    WEB_PORT: String(ports.webPort),
    DATABASE_PORT: String(ports.dbPort),
    OBJECT_STORE_URL: `http://localhost:${ports.objPort}`,
    HBPE_HOST: `http://localhost:${ports.hbpePort}`,
    // Both sidecars need a host-side URL, not the compose service name. The
    // API runs on the host under overmind, so config's defaults
    // (http://hbpe-service:8002, http://summary-service:8001) resolve only
    // inside the compose network — from here they are ENOTFOUND. Mapped to
    // services.{hbpe,summary}.host via config/custom-environment-variables.json.
    SUMMARY_HOST: `http://localhost:${ports.summaryPort}`,
    PARSER_HOST: `http://localhost:${ports.parserPort}`,
    APP_PUBLIC_HOSTNAME: host, // this stack's own origin (<key>.localhost); OAuth host is separate
    // Vite's own `/api` proxy, for anyone who opens the raw dev-server port
    // instead of the Caddy route. Without this it falls back to the hardcoded
    // `http://localhost:64669` in vite.config.ts — a port nothing listens on —
    // so EVERY /api call from that origin fails with ECONNREFUSED: no feature
    // flags (which silently unregisters flag-gated routes, so /import serves a
    // 404 that reads like "not signed in"), no GraphQL, and an OAuth link that
    // lands on a blank page.
    //
    // 127.0.0.1, not `localhost`: the API binds IPv4 (API_LISTEN_HOST above,
    // `127.0.0.1` or `0.0.0.0` unless DEV_LISTEN_HOST names another), while
    // `localhost` resolves to ::1 first on a dual-stack host. curl falls back
    // to IPv4; Node's proxy agent reports the AggregateError instead.
    API_PROXY_TARGET: `http://127.0.0.1:${ports.apiPort}`,
    // Vite's `/static` proxy, for the same raw-port visitors: every photo
    // thumbnail and video poster is a presigned `/static/...` URL. Without this
    // it falls back to the conventional 9000 in vite.config.ts, which is this
    // stack's object store only if this stack won that port. A worktree started
    // beside another stack gets an ephemeral one, so its vite sent every
    // presigned URL to the SIBLING's store, which refuses it (403
    // InvalidAccessKeyId: other credentials) or has no such object (keys are
    // per-upload UUIDs) — every thumbnail broken either way. objPort is the
    // port Caddy's `/static` route dials, so the two proxies cannot disagree.
    // 127.0.0.1 as above; compose publishes the object store on IPv4 loopback.
    STATIC_PROXY_TARGET: `http://127.0.0.1:${ports.objPort}`,
    OVERMIND_SOCKET: socket,
    // Overmind reloads .env over the environment we hand it, which would
    // overwrite the dynamic per-worktree ports set above. `base` already
    // carries .env (index.ts loads it at startup), so skip overmind's reload.
    OVERMIND_SKIP_ENV: '1',
  };
}
