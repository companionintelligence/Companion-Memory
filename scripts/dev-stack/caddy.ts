/**
 * caddy — a small client for the Caddy admin API, shared by the local dev tooling.
 *
 * index.ts (per-worktree stack supervisor) and oauth.ts (canonical OAuth host
 * claim) both drive Caddy through a CaddyClient, so the admin transport, config
 * reads, and route bookkeeping live in one place. The supervisor's teardown also
 * calls releaseOauthIfOwned so a stack that claimed the canonical host gives it
 * back when it goes down.
 */
import http from 'node:http';

import { note, ok } from './log';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tries per admin call when the connection fails, pausing 150 ms, 300 ms, ...
 * between them: about 1.5 s in all, enough to ride out a Caddy reload. */
const MAX_ATTEMPTS = 5;
const backoff = (attempt: number): Promise<void> => delay(150 * attempt);

/** Caddy resets in-flight admin connections while it reloads the HTTP app to
 * bring up a new :443 listener (and the HTTP/3 UDP listener) — the first
 * mutating call that introduces the listener typically lands but the socket is
 * torn down before the response arrives. Treat those connection-level failures
 * as retryable; real 4xx/5xx responses are not. */
function isTransientError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);

  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    /socket hang up/i.test(message)
  );
}

/** Caddy answered, and refused: a non-2xx status. */
class CaddyAdminError extends Error {
  constructor(
    method: string,
    urlPath: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Caddy admin ${method} ${urlPath} returned ${status} ${body}`);
  }
}

/** PUT creates and never replaces, so Caddy answers it 409 "key already exists"
 * when the key is there. For a caller ensuring that the key exists, that is done. */
const isAlreadyExists = (err: unknown): boolean =>
  err instanceof CaddyAdminError && err.status === 409 && /already exists/.test(err.body);

/**
 * Where the shared stack server listens: loopback only. Every route on it is
 * matched on a `<key>.localhost` host, which only this machine resolves, and
 * `make tunnel` reaches it as https://localhost:443. Listening on `:443` instead
 * answered the whole network, and a request that names one of those hosts in its
 * Host header reaches the stack (and its `/static` object-store route) from any
 * machine. A server created by an older checkout keeps its `:443` until the last
 * stack on it goes down and it is removed.
 */
export const CADDY_LISTEN = '127.0.0.1:443';

export type CaddyRoute = {
  '@id'?: string;
  [key: string]: unknown;
};

export type CaddyServer = {
  routes?: CaddyRoute[];
  [key: string]: unknown;
};

export type CaddyPolicy = {
  '@id'?: string;
  [key: string]: unknown;
};

export type CaddyConfig = {
  apps?: {
    http?: {
      servers?: Record<string, CaddyServer>;
    };
    tls?: {
      automation?: {
        policies?: CaddyPolicy[];
      };
    };
  };
};

/** stack-<key> is the per-worktree route id; the OAuth route and its TLS
 * automation policy are separate fixed ids (only one stack can own the canonical
 * host at a time). */
export const routeId = (key: string) => `stack-${key}`;
export const OAUTH_ROUTE_ID = 'oauth-canonical';
export const OAUTH_TLS_ID = 'oauth-tls';

type AdminResponse = {
  status: number;
  text: string;
};

export type CaddyClientOptions = {
  host?: string;
  port?: number;
  /** Name of the single shared :443 server that every stack route hangs off. */
  serverName?: string;
};

export class CaddyClient {
  readonly host: string;

  readonly port: number;

  readonly serverName: string;

  constructor(options: CaddyClientOptions = {}) {
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 2019;
    this.serverName = options.serverName ?? 'stacks';
  }

  /** Low-level admin call over node:http (NOT fetch). The Fetch spec makes undici
   * attach an `Origin` header to non-GET/HEAD requests; with no document origin
   * it's empty, and Caddy's admin API rejects unrecognized origins with a 403
   * ("client is not allowed to access from origin ''"). The http module sends no
   * Origin, so PUT/POST/DELETE are accepted, matching the spike's urllib. */
  private request(method: string, urlPath: string, body?: unknown): Promise<AdminResponse> {
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          method,
          path: urlPath,
          // A fresh connection per call, never a pooled one. Node's default
          // agent keeps sockets alive (since Node 19), and up() blocks the event
          // loop in spawnSync for minutes between two admin calls (compose,
          // migrate). Caddy's admin server drops an idle socket after 60 s, Node
          // cannot read that FIN while blocked, and the next call went out on
          // the dead socket and was reset. Admin calls are few; keep-alive saves
          // nothing.
          agent: false,
          headers:
            payload === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                },
        },
        (res) => {
          let data = '';

          res.on('data', (chunk) => (data += chunk));
          // A connection cut mid-answer is reported here (ECONNRESET, so it
          // is retried), and only to a listener: without one the call could
          // stay pending forever.
          res.on('error', reject);
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              text: data,
            }),
          );
        },
      );

      req.on('error', reject);

      if (payload !== undefined) {
        req.write(payload);
      }

      req.end();
    });
  }

  /** Mutating admin call; throws on connection failure or a non-2xx status.
   *
   * Retries transient connection resets (see isTransientError) a few times,
   * because Caddy tears down in-flight admin connections while it reloads to
   * bring up the :443 listener. `verify`, when given, reports whether the change
   * already took effect: a reset often still applies the config, and the call is
   * a non-idempotent append (POST), so we must not blindly retry and duplicate
   * it — if verify() is true we treat the reset as success instead. If verify()
   * cannot read Caddy either, there is no telling, so we give up rather than
   * retry. */
  private async send(
    method: string,
    urlPath: string,
    body?: unknown,
    verify?: () => Promise<boolean>,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let res: AdminResponse;

      try {
        res = await this.request(method, urlPath, body);
      } catch (err) {
        // A reset may have still applied the change; if so, we're done.
        if (verify) {
          let applied: boolean;

          try {
            applied = await verify();
          } catch (verifyErr) {
            throw new Error(
              `Caddy admin ${method} ${urlPath} failed, and reading back whether it applied failed too; ` +
                `is Caddy running on :${this.port}?`,
              { cause: verifyErr },
            );
          }

          if (applied) {
            return;
          }
        }

        if (isTransientError(err) && attempt < MAX_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }

        throw new Error(`Caddy admin ${method} ${urlPath} failed; is Caddy running on :${this.port}?`, {
          cause: err,
        });
      }

      if (res.status >= 200 && res.status < 300) {
        return;
      }

      throw new CaddyAdminError(method, urlPath, res.status, res.text);
    }
  }

  /** Whether the admin API answers at all, in one try. config() also fails on a
   * dead admin socket, but only after retrying; callers that just want to say
   * "start Caddy" up front (rather than "no stacks up") probe with this first. */
  async reachable(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/config/');

      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** The whole config, `{}` when Caddy has none.
   *
   * A read that fails is retried as send() retries, and if it keeps failing it
   * throws. It is never passed off as an empty config, because every caller acts
   * on what it reads: ensureServer() took a failed read for "no server yet" and
   * PUT one, which Caddy refuses with a 409 while another stack's server is up. */
  async config(): Promise<CaddyConfig> {
    // A plain GET on /config/ always returns 200 (literal `null` when
    // unconfigured), so we read whole-config state rather than probing deep
    // paths/@ids that 404 and make Caddy log scary errors during normal flow.
    for (let attempt = 1; ; attempt++) {
      let res: AdminResponse;

      try {
        res = await this.request('GET', '/config/');
      } catch (err) {
        if (isTransientError(err) && attempt < MAX_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }

        throw new Error(`Caddy admin GET /config/ failed; is Caddy running on :${this.port}?`, {
          cause: err,
        });
      }

      if (res.status !== 200) {
        throw new CaddyAdminError('GET', '/config/', res.status, res.text);
      }

      const text = res.text.trim();
      if (!text || text === 'null') {
        return {};
      }

      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(`Caddy admin GET /config/ returned a body that is not JSON: ${text.slice(0, 200)}`, {
          cause: err,
        });
      }
    }
  }

  /** The shared :443 server, if it has been created yet. */
  async server(): Promise<CaddyServer | undefined> {
    const cfg = await this.config();

    return cfg?.apps?.http?.servers?.[this.serverName];
  }

  /** Create the shared :443 server if it isn't there yet. */
  async ensureServer(): Promise<void> {
    if ((await this.server()) !== undefined) {
      return;
    }

    try {
      await this.send('PUT', `/config/apps/http/servers/${this.serverName}`, {
        listen: [CADDY_LISTEN],
        routes: [],
        tls_connection_policies: [{}],
      });
    } catch (err) {
      // It was created after our read, by another worktree's `make dev` or by
      // this very PUT before a reset made send() retry it. Either way it's there.
      if (!isAlreadyExists(err)) {
        throw err;
      }
    }
  }

  /** Every route currently hanging off the shared :443 server. */
  async routes(): Promise<CaddyRoute[]> {
    return (await this.server())?.routes ?? [];
  }

  async routeById(id: string): Promise<CaddyRoute | undefined> {
    return (await this.routes()).find((r) => r['@id'] === id);
  }

  async hasRoute(id: string): Promise<boolean> {
    return (await this.routeById(id)) !== undefined;
  }

  /** Append a route to the shared server, creating the server first if needed.
   * This is the call most likely to race Caddy's :443 listener coming up; when
   * the route carries an @id we let send() verify by it so a connection reset
   * that still applied the route isn't retried into a duplicate. */
  async addRoute(route: CaddyRoute): Promise<void> {
    await this.ensureServer();

    const id = route['@id'];
    const verify = typeof id === 'string' ? () => this.hasRoute(id) : undefined;

    await this.send('POST', `/config/apps/http/servers/${this.serverName}/routes`, route, verify);
  }

  /** Delete any config object by its @id (a route, a TLS policy, etc.). */
  async deleteById(id: string): Promise<void> {
    await this.send('DELETE', `/id/${id}`);
  }

  /** Remove the shared server once its last route is gone. Returns whether it
   * was removed, so the caller can log it. */
  async removeServerIfEmpty(): Promise<boolean> {
    const server = await this.server();

    if (server && !(server.routes ?? []).length) {
      await this.send('DELETE', `/config/apps/http/servers/${this.serverName}`);

      return true;
    }

    return false;
  }

  // --- tls automation --------------------------------------------------------

  /** Ensure apps.tls.automation.policies exists as an array, creating only the
   * missing level so we never clobber existing tls config. A 409 means the level
   * we PUT was created after our read; unlike ensureServer() we can't stop there,
   * because what is beneath it may still be missing, so read again. */
  private async ensureTlsPolicies(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const cfg = await this.config();
      const tls = cfg.apps?.tls;

      if (Array.isArray(tls?.automation?.policies)) {
        return;
      }

      try {
        if (tls?.automation) {
          await this.send('PUT', '/config/apps/tls/automation/policies', []);
        } else if (tls) {
          await this.send('PUT', '/config/apps/tls/automation', {
            policies: [],
          });
        } else {
          await this.send('PUT', '/config/apps/tls', {
            automation: {
              policies: [],
            },
          });
        }

        return;
      } catch (err) {
        // A genuine race conflicts at most once per level (tls, automation,
        // policies); the read after the third finds the array.
        if (!isAlreadyExists(err) || attempt > 3) {
          throw err;
        }
      }
    }
  }

  private async tlsPolicyExists(id: string): Promise<boolean> {
    const cfg = await this.config();
    const policies = cfg.apps?.tls?.automation?.policies ?? [];

    return policies.some((p) => p['@id'] === id);
  }

  /** Pin the internal (locally-trusted) CA for `subjects`. Caddy auto-issues its
   * internal cert for .localhost and IPs, but treats a real TLD as public and
   * would attempt ACME (which fails for a dev-only domain), so a GTLD alias needs
   * this explicit policy. The CA itself is trusted via `caddy trust`. */
  private async provisionTls(subjects: string[]): Promise<void> {
    await this.ensureTlsPolicies();

    if (await this.tlsPolicyExists(OAUTH_TLS_ID)) {
      await this.deleteById(OAUTH_TLS_ID);
    }

    await this.send(
      'POST',
      '/config/apps/tls/automation/policies',
      {
        '@id': OAUTH_TLS_ID,
        subjects,
        issuers: [
          {
            module: 'internal',
          },
        ],
      },
      () => this.tlsPolicyExists(OAUTH_TLS_ID),
    );
  }

  private async deprovisionTls(): Promise<void> {
    if (await this.tlsPolicyExists(OAUTH_TLS_ID)) {
      await this.deleteById(OAUTH_TLS_ID).catch(() => {});
    }
  }

  // --- static OAuth host ------------------------------------------------------

  /** The one static host the OAuth provider redirects back to, taken from the
   * registered OAUTH_CALLBACK_URL. It never changes; `make oauth` only repoints
   * it at whichever stack is currently assigned. */
  private oauthHost(): string {
    const url = process.env.OAUTH_CALLBACK_URL?.trim();

    if (!url) {
      throw new Error('OAUTH_CALLBACK_URL not set in .env');
    }

    try {
      return new URL(url).host;
    } catch {
      throw new Error(`OAUTH_CALLBACK_URL is not a valid URL: ${url}`);
    }
  }

  /** Repoint the static OAuth host at the stack named by `key`: a 307 redirect to
   * https://<key>.localhost that preserves the path and query, mirroring the old
   * gateway's `return 307 ... $request_uri`. The provider always redirects to the
   * single registered host; this bounces that hit on to the assigned stack, which
   * serves the callback under its own origin. Replaces any prior claim. */
  async claimOauth(key: string): Promise<void> {
    if (!(await this.hasRoute(routeId(key)))) {
      throw new Error(`Stack \`${key}\` is not up. Run \`make dev\` first, then claim OAuth`);
    }

    const oauthHost = this.oauthHost();
    const target = `${key}.localhost`;

    // The provider redirects to https://<oauthHost>, so Caddy must serve TLS
    // there to issue the redirect. Pin the internal CA before the route exists,
    // so Caddy never tries a public ACME cert for it.
    await this.provisionTls([oauthHost]);

    if (await this.routeById(OAUTH_ROUTE_ID)) {
      await this.deleteById(OAUTH_ROUTE_ID);
    }

    await this.addRoute({
      '@id': OAUTH_ROUTE_ID,
      match: [
        {
          host: [oauthHost],
        },
      ],
      handle: [
        {
          handler: 'static_response',
          status_code: 307,
          headers: {
            Location: [`https://${target}{http.request.uri}`],
          },
        },
      ],
    });

    ok(`OAuth host https://${oauthHost} now redirects to https://${target}`);
  }

  async releaseOauth(): Promise<void> {
    if (await this.routeById(OAUTH_ROUTE_ID)) {
      await this.deleteById(OAUTH_ROUTE_ID);

      ok('Released the OAuth redirect');
    } else {
      note('No OAuth redirect to release');
    }

    await this.deprovisionTls();
  }

  /** Release the OAuth redirect only if it currently points at this stack. The
   * redirect's Location carries the stack's `<key>.localhost`, so its presence
   * identifies ownership. Used by the supervisor's teardown so a stack that
   * claimed the host hands it back instead of leaving it aimed at a dead stack. */
  async releaseOauthIfOwned(key: string): Promise<void> {
    const route = await this.routeById(OAUTH_ROUTE_ID);

    if (route && JSON.stringify(route).includes(`${key}.localhost`)) {
      await this.deleteById(OAUTH_ROUTE_ID).catch(() => {});
      await this.deprovisionTls();

      ok('Released the OAuth redirect this stack was holding');
    }
  }
}
