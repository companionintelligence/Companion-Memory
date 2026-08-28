import dns from 'node:dns';
import net, { type LookupFunction } from 'node:net';

import { Injectable } from '@nestjs/common';
import { Agent, fetch as undiciFetch } from 'undici';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

/**
 * The one place the appliance fetches a URL that came out of user data.
 *
 * Every unfurl is a server-side request to an address the content row chose,
 * which is the exact shape of an SSRF primitive — so this class is the
 * chokepoint, and the rules live here and nowhere else:
 *
 *  - http/https only; no credentials in the URL.
 *  - Blocked address ranges are refused AT CONNECT TIME through the agent's
 *    `lookup`, so the address that passed the check is the one dialled. A
 *    resolve-then-check-then-connect sequence has a rebind window; this has
 *    none. Hostnames that are literal IPs go through the same check.
 *  - Redirects are followed by hand (≤ {@link MAX_REDIRECTS}) through the same
 *    agent, so a public host cannot bounce the request into the LAN.
 *  - Hard timeout, hard byte cap, fixed User-Agent, no cookies.
 *
 * The deny list includes 100.64.0.0/10: this appliance is routinely on a
 * Tailscale tailnet, and a CGNAT address is "inside" here.
 */

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
/** Enough for any <head>; OpenGraph never needs the body. */
export const MAX_HTML_BYTES = 256 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'CI-Server/1.0 (+https://ci.computer; link preview)';

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home', '.lan', '.arpa'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', '169.254.169.254']);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;

  return (ip & mask) === (ipv4ToInt(base) & mask);
}

/** True for an IPv4 address nothing on the public internet should answer from. */
export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);

  return (
    inCidr4(n, '0.0.0.0', 8) ||
    inCidr4(n, '10.0.0.0', 8) ||
    inCidr4(n, '100.64.0.0', 10) || // CGNAT — Tailscale lives here
    inCidr4(n, '127.0.0.0', 8) ||
    inCidr4(n, '169.254.0.0', 16) ||
    inCidr4(n, '172.16.0.0', 12) ||
    inCidr4(n, '192.0.0.0', 24) ||
    inCidr4(n, '192.0.2.0', 24) ||
    inCidr4(n, '192.168.0.0', 16) ||
    inCidr4(n, '198.18.0.0', 15) ||
    inCidr4(n, '198.51.100.0', 24) ||
    inCidr4(n, '203.0.113.0', 24) ||
    inCidr4(n, '224.0.0.0', 3) // multicast + reserved + broadcast
  );
}

/** True for an IPv6 address that is loopback, link-local, ULA, or wraps a blocked IPv4. */
export function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');

  // ::ffff:a.b.c.d — IPv4-mapped; judge the v4 part.
  const mapped = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }

  // ::ffff:xxxx:xxxx hex form of the same thing.
  const mappedHex = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);

    return isBlockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  if (lower === '::' || lower === '::1') {
    return true;
  }

  const first = lower.split(':')[0];
  const word = Number.parseInt(first || '0', 16);

  return (
    (word & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (word & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (word & 0xff00) === 0xff00 || // ff00::/8 multicast
    lower.startsWith('2001:db8:') || // documentation
    lower.startsWith('64:ff9b:') // NAT64 well-known prefix
  );
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return isBlockedIpv4(address);
  }

  if (family === 6) {
    return isBlockedIpv6(address);
  }

  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || BLOCKED_HOSTS.has(host)) {
    return true;
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  // Literal IPs (IPv6 literals arrive bracketed from URL.hostname).
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    return isBlockedAddress(literal);
  }

  // A bare label ("intranet") is never a public host.
  return !host.includes('.');
}

export class BlockedAddressError extends Error {
  constructor(public readonly host: string) {
    super(`refusing to connect to blocked address for ${host}`);
    this.name = 'BlockedAddressError';
  }
}

/**
 * DNS lookup that refuses blocked results. undici hands this to net.connect,
 * so the connection can only ever reach an address this function approved.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  if (isBlockedHostname(hostname)) {
    callback(new BlockedAddressError(hostname), '', 4);

    return;
  }

  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 4);

      return;
    }

    const list = Array.isArray(addresses) ? addresses : [addresses];
    const allowed = list.filter((a) => !isBlockedAddress(a.address));
    if (allowed.length === 0 || allowed.length !== list.length) {
      // Any blocked answer poisons the set: a host that resolves to both a
      // public and a private address is exactly the rebind shape.
      callback(new BlockedAddressError(hostname), '', 4);

      return;
    }

    // `all` was forced on above, but the caller may not have asked for it.
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (e: null, a: typeof allowed) => void)(null, allowed);
    } else {
      callback(null, allowed[0].address, allowed[0].family);
    }
  });
};

export type FetchOutcome =
  | { kind: 'ok'; status: number; url: string; contentType: string; body: Buffer }
  | { kind: 'status'; status: number; url: string }
  | { kind: 'blocked'; url: string }
  | { kind: 'too_large'; url: string }
  | { kind: 'timeout'; url: string }
  | { kind: 'transport'; url: string; error: string };

export interface FetchOptions {
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Default pause after a 429 with no Retry-After. */
const RATE_LIMIT_PAUSE_MS = 30_000;
const MAX_RETRY_AFTER_MS = 10 * 60_000;

/**
 * Hosts run by one operator share one rate budget. Wikimedia in particular
 * throttles per client across Wikipedia, Wikidata and Commons, and a resolve
 * touches all three.
 */
export function rateBucketFor(hostname: string): string {
  const host = hostname.toLowerCase();
  if (/(^|\.)(wikipedia|wikidata|wikimedia)\.org$/.test(host)) {
    return 'wikimedia';
  }

  if (/(^|\.)(youtube\.com|ytimg\.com|googlevideo\.com)$/.test(host)) {
    return 'youtube';
  }

  if (/(^|\.)(spotify\.com|scdn\.co|spotifycdn\.com)$/.test(host)) {
    return 'spotify';
  }

  return host;
}

/**
 * Minimum-interval throttle per bucket, applied to EVERY request — not per
 * resolve, which is how the first cut sent ~8 req/s to Wikimedia at a
 * configured 2 (a Wikidata resolve is 3–5 requests, the poster copy one more).
 * A 429 pushes the bucket's next slot out by Retry-After (or 30 s).
 */
export class RateBuckets {
  private readonly nextAt = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  async acquire(bucket: string): Promise<void> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextAt.get(bucket) ?? 0);
    this.nextAt.set(bucket, startAt + this.minIntervalMs);
    if (startAt > now) {
      await new Promise((resolve) => setTimeout(resolve, startAt - now));
    }
  }

  pause(bucket: string, ms: number): void {
    this.nextAt.set(bucket, Math.max(this.nextAt.get(bucket) ?? 0, Date.now() + ms));
  }
}

function retryAfterMs(header: string | null): number {
  if (!header) {
    return RATE_LIMIT_PAUSE_MS;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, seconds * 1000));
  }

  const at = Date.parse(header);

  return Number.isFinite(at)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, at - Date.now()))
    : RATE_LIMIT_PAUSE_MS;
}

@Injectable()
export class UnfurlFetcher {
  private readonly agent = new Agent({
    connect: { lookup: guardedLookup, timeout: DEFAULT_TIMEOUT_MS },
    keepAliveTimeout: 4_000,
    maxRedirections: 0,
  });

  private readonly buckets = new RateBuckets(1000 / Math.max(0.1, config.unfurl.ratePerSecond));

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(UnfurlFetcher.name);
  }

  /** GET a URL with every guard applied; never throws for a bad remote. */
  async get(rawUrl: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
    const maxBytes = opts.maxBytes ?? MAX_HTML_BYTES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let url = rawUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { kind: 'transport', url, error: 'invalid_url' };
      }

      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        isBlockedHostname(parsed.hostname)
      ) {
        return { kind: 'blocked', url };
      }

      const bucket = rateBucketFor(parsed.hostname);
      await this.buckets.acquire(bucket);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await undiciFetch(parsed, {
          method: 'GET',
          redirect: 'manual',
          dispatcher: this.agent,
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: opts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
            'accept-language': 'en',
          },
        });
      } catch (e) {
        clearTimeout(timer);
        const err = e as Error & { cause?: Error; name?: string };
        if (err.name === 'AbortError') {
          return { kind: 'timeout', url };
        }

        const cause = err.cause ?? err;
        if (cause instanceof BlockedAddressError || cause?.name === 'BlockedAddressError') {
          return { kind: 'blocked', url };
        }

        return { kind: 'transport', url, error: cause?.message ?? String(e) };
      }

      if (response.status >= 300 && response.status < 400) {
        clearTimeout(timer);
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || hop === MAX_REDIRECTS) {
          return { kind: 'status', status: response.status, url };
        }

        try {
          url = new URL(location, parsed).toString();
        } catch {
          return { kind: 'transport', url, error: 'invalid_redirect' };
        }

        continue;
      }

      if (!response.ok) {
        clearTimeout(timer);
        if (response.status === 429 || response.status === 503) {
          const pause = retryAfterMs(response.headers.get('retry-after'));
          this.buckets.pause(bucket, pause);
          this.logger.warn('Provider throttled; pausing bucket', {
            bucket,
            status: response.status,
            pauseMs: pause,
          });
        }

        await response.body?.cancel().catch(() => {});

        return { kind: 'status', status: response.status, url };
      }

      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        clearTimeout(timer);
        await response.body?.cancel().catch(() => {});

        return { kind: 'too_large', url };
      }

      try {
        const body = await readCapped(response, maxBytes);
        clearTimeout(timer);
        if (!body) {
          return { kind: 'too_large', url };
        }

        return {
          kind: 'ok',
          status: response.status,
          url,
          contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
          body,
        };
      } catch (e) {
        clearTimeout(timer);
        const err = e as Error;

        return err.name === 'AbortError'
          ? { kind: 'timeout', url }
          : { kind: 'transport', url, error: err.message };
      }
    }

    return { kind: 'status', status: 310, url };
  }
}

/** Reads at most `max` bytes; returns null (and cancels the stream) past that. */
async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});

      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}
