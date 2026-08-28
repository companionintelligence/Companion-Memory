/**
 * Egress policy for peer + directory URLs — and the only dialer allowed to act
 * on it.
 *
 * `memoryEndpoint` and `directoryUrl` are attacker-influenced: a peer descriptor
 * comes from the Portal directory, and a peer link stores whatever endpoint that
 * descriptor carried. Fetching them server-side is a textbook SSRF sink — a
 * hostile or compromised directory entry pointing at `http://169.254.169.254/`
 * or `http://localhost:5432/` would have this box make the request on the
 * attacker's behalf, from inside the appliance's own network.
 *
 * The policy is deliberately an allowlist of *shapes*, not a blocklist of
 * strings: https only, no credentials, no non-standard ports, and no address
 * that resolves to a private, loopback, link-local, or otherwise special range.
 *
 * ═══ CHECKING THE URL IS ONLY HALF OF IT ═══
 *
 * A URL check answers "may we ask for this?". It cannot answer "is this the
 * address we will actually talk to?", and a peer whose appliance is compromised
 * — the *core* threat model of federation — gets to answer that second question
 * twice over:
 *
 *   - by REDIRECT. `fetch` follows redirects by default, and a 307 carries the
 *     method and the FULL BODY to the new location. A peer replying
 *     `307 Location: http://127.0.0.1:11434/api/pull` had this box make that
 *     request from inside its own network, with the ask body attached, because
 *     only the first URL was ever checked. Reproduced, not theorised.
 *   - by DNS. A name that passes every check above can resolve to 127.0.0.1 at
 *     connect time — classic rebinding, and it needs no rebinding at all if the
 *     peer simply publishes an A record for a private address.
 *
 * {@link peerEgressFetch} closes both, and every outbound call in this domain
 * goes through it:
 *
 *   - redirects are NOT followed. `redirect: 'manual'` plus a dispatcher with
 *     `maxRedirections: 0`, and a 3xx is refused outright rather than chased.
 *     A peer's `/agent/v1` is a JSON API; the directory is the source of truth
 *     for where a peer lives, so an HTTP redirect is not part of the protocol —
 *     it is only ever the attack. Zero hops means there is no "revalidate each
 *     hop" logic that can be got wrong later.
 *   - the address is pinned AT CONNECT TIME through the dispatcher's `lookup`,
 *     so the address that passed the check is the one dialled. There is no
 *     resolve-then-check-then-connect window.
 *
 * ═══ THE OLD NOTE HERE WAS WRONG, AND TALKED PEOPLE OUT OF THE FIX ═══
 *
 * This file used to carry a "NOTE ON DNS REBINDING" saying that pinning the
 * resolved IP through the socket is something "Node's fetch does not expose",
 * and recorded the exposure as a known limitation. That is not true, and the
 * counter-example was already in this repository: `domains/embed`'s
 * `UnfurlFetcher` pins addresses exactly this way, through an undici `Agent`
 * whose `connect.lookup` refuses blocked answers. The guard below is that same
 * reviewed mechanism, applied to a stricter policy. A comment that argues an
 * engineer out of the correct fix is part of the defect, so it is gone.
 *
 * The address tables are deliberately kept at parity with `UnfurlFetcher`'s (it
 * is the wider of the two, and a narrower peer table would be a downgrade for
 * the more sensitive caller). They are duplicated rather than imported because
 * `.dependency-cruiser.mjs`' `no-cross-domain-internals` forbids reaching into
 * `domains/embed`, and its barrel exports a whole NestJS module rather than
 * these predicates. `urlPolicy.spec.ts` pins the corpus on this side.
 */
import dns from 'node:dns';
import net, { type LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

/** Ports a legitimate peer or directory may listen on. */
const ALLOWED_PORTS: ReadonlySet<string> = new Set(['', '443']);

/** Names that can only ever mean "inside", whatever DNS says about them. */
const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
]);

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home', '.lan', '.arpa'];

/** Bound on a single connect attempt, independent of the caller's overall timeout. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface UrlPolicyResult {
  ok: boolean;
  reason?: string;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;

  return (ip & mask) === (ipv4ToInt(base) & mask);
}

/**
 * True for an IPv4 address nothing on the public internet should answer from.
 *
 * Assumes a well-formed dotted quad; {@link isBlockedAddress} is the gate that
 * guarantees it. Covers RFC1918 private space, loopback, link-local (incl.
 * cloud metadata at 169.254.169.254), CGNAT, benchmarking, the documentation
 * ranges, multicast and reserved.
 *
 * 100.64.0.0/10 matters here for the same reason it matters in `domains/embed`:
 * this appliance is routinely on a Tailscale tailnet, and a CGNAT address is
 * "inside" on such a box.
 */
export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);

  return (
    inCidr4(n, '0.0.0.0', 8) || // "this" network
    inCidr4(n, '10.0.0.0', 8) || // RFC1918
    inCidr4(n, '100.64.0.0', 10) || // CGNAT — Tailscale lives here
    inCidr4(n, '127.0.0.0', 8) || // loopback
    inCidr4(n, '169.254.0.0', 16) || // link-local + cloud metadata
    inCidr4(n, '172.16.0.0', 12) || // RFC1918
    inCidr4(n, '192.0.0.0', 24) || // IETF protocol assignments
    inCidr4(n, '192.0.2.0', 24) || // TEST-NET-1
    inCidr4(n, '192.168.0.0', 16) || // RFC1918
    inCidr4(n, '198.18.0.0', 15) || // benchmarking
    inCidr4(n, '198.51.100.0', 24) || // TEST-NET-2
    inCidr4(n, '203.0.113.0', 24) || // TEST-NET-3
    inCidr4(n, '224.0.0.0', 3) // multicast + reserved + broadcast
  );
}

/**
 * True for an IPv6 address that is loopback, link-local, ULA, multicast, or
 * wraps a blocked IPv4.
 *
 * IPv4-mapped addresses embed a v4 address inside a v6 one and must be
 * re-checked against the v4 rules, or `::ffff:10.0.0.1` becomes a bypass. Three
 * spellings reach us: the dotted form a caller types, the HEX form WHATWG `URL`
 * normalizes it to (`::ffff:a00:1`), and the long form with leading zero
 * groups. Handling only the first leaves the bypass wide open, because by the
 * time a host reaches here `new URL()` has usually rewritten it.
 */
export function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');

  const mapped = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }

  const mappedHex = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);

    return isBlockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  if (lower === '::' || lower === '::1') {
    return true;
  }

  const word = Number.parseInt(lower.split(':')[0] || '0', 16);

  return (
    (word & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (word & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (word & 0xff00) === 0xff00 || // ff00::/8 multicast
    lower.startsWith('2001:db8:') || // documentation
    lower.startsWith('64:ff9b:') // NAT64 well-known prefix
  );
}

/**
 * True for any literal address this box must not connect to.
 *
 * Anything that is not a parseable IP is blocked: this is the predicate the
 * connect-time guard runs against a RESOLVED answer, and an unparseable answer
 * is not something to give the benefit of the doubt to.
 */
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

/** Why a hostname is refused, or null when it is acceptable. */
function hostnameRefusal(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (!host) {
    return 'must name a host';
  }

  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return 'must not target a local hostname';
  }

  // Literal IPs — IPv6 literals arrive bracketed from `URL.hostname`, and
  // WHATWG parsing has already folded decimal (`2130706433`), hex
  // (`0x7f000001`), octal (`0177.0.0.1`) and short (`127.1`) IPv4 spellings
  // into a dotted quad by this point, so one check covers every encoding.
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    return isBlockedAddress(literal) ? 'must not target a private or loopback address' : null;
  }

  // A bare label ("intranet", "companion") is a search-domain lookup, never a
  // public host — and could never present a valid certificate for itself.
  if (!host.includes('.')) {
    return 'must not target a non-public hostname';
  }

  return null;
}

/**
 * Validate a URL this box is about to fetch server-side.
 *
 * Returns a reason rather than throwing so callers can log and degrade — a bad
 * peer endpoint should decline the ask, never crash the request.
 *
 * This is the PRE-FLIGHT half. It cannot see the address that will actually be
 * dialled; {@link peerEgressFetch} is what makes the decision stick.
 */
export function checkEgressUrl(raw: string): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'must use https' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'must not embed credentials' };
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: `port ${url.port} is not permitted` };
  }

  const refusal = hostnameRefusal(url.hostname);

  return refusal == null ? { ok: true } : { ok: false, reason: refusal };
}

/** Convenience predicate for call sites that only need a boolean. */
export function isEgressUrlAllowed(raw: string): boolean {
  return checkEgressUrl(raw).ok;
}

/**
 * Raised whenever egress is refused — by the URL shape, by the address a name
 * resolved to, or by a peer trying to redirect us somewhere else.
 *
 * `reason` is written by THIS box. Nothing the peer supplied (a `Location`
 * header, a response body) is ever folded into it, because the reason travels
 * back to the local UI and an attacker-chosen string there is how a collapsed
 * status gets undone one field along.
 */
export class EgressBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`egress refused: ${reason}`);
    this.name = 'EgressBlockedError';
  }
}

/** The shape of `dns.lookup` this module needs; injectable so the guard is testable without a resolver. */
export type AddressResolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * Build a DNS lookup that refuses blocked answers.
 *
 * undici hands this to `net.connect`, so the connection can only ever reach an
 * address this function approved — which is what removes the rebind window
 * between validating a URL and dialling it.
 *
 * ANY blocked answer poisons the whole set. A name that resolves to both a
 * public and a private address is not a name with one usable answer; it is
 * precisely the rebind shape, and picking the public one just means losing the
 * race later.
 */
export function createEgressLookup(resolve: AddressResolver): LookupFunction {
  return (hostname, options, callback) => {
    if (hostnameRefusal(hostname) != null) {
      callback(new EgressBlockedError(`${hostname} is not a permitted host`), '', 4);

      return;
    }

    resolve(hostname, { ...(options as dns.LookupAllOptions), all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 4);

        return;
      }

      const list = Array.isArray(addresses) ? addresses : [addresses];
      const allowed = list.filter((entry) => !isBlockedAddress(entry.address));
      if (allowed.length === 0 || allowed.length !== list.length) {
        callback(new EgressBlockedError(`${hostname} resolves to a blocked address`), '', 4);

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
}

/** The production lookup: node's resolver, with blocked answers refused. */
export const peerEgressLookup: LookupFunction = createEgressLookup((hostname, options, callback) => {
  dns.lookup(hostname, options, callback);
});

/**
 * A dispatcher that can only reach addresses {@link peerEgressLookup} approved.
 *
 * `lookup` is a parameter so a spec can drive a REAL socket through this exact
 * agent with a deterministic resolver, and show the connect-time guard refusing
 * a name that resolves inside — the property that cannot be demonstrated with a
 * mocked transport. Production never passes it.
 */
export function createPeerEgressAgent(lookup: LookupFunction = peerEgressLookup): Agent {
  return new Agent({
    connect: { lookup, timeout: CONNECT_TIMEOUT_MS },
    keepAliveTimeout: 4_000,
    // Belt and braces with `redirect: 'manual'` below: this stops a redirect
    // being followed underneath fetch, at the dispatcher level.
    maxRedirections: 0,
  });
}

let sharedAgent: Agent | undefined;

function agent(): Agent {
  sharedAgent ??= createPeerEgressAgent();

  return sharedAgent;
}

export interface PeerEgressInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * The ONLY way this domain is allowed to reach the network.
 *
 * Throws {@link EgressBlockedError} when the URL fails policy, when the host
 * resolves somewhere it must not, or when the peer answers with a redirect.
 * Every other failure (timeout, TLS, connection refused) throws whatever undici
 * threw, so callers can keep telling "we refused" apart from "they did not
 * answer".
 */
export async function peerEgressFetch(rawUrl: string, init: PeerEgressInit): Promise<Response> {
  const policy = checkEgressUrl(rawUrl);
  if (!policy.ok) {
    throw new EgressBlockedError(policy.reason ?? 'not permitted');
  }

  let response: Response;
  try {
    response = await undiciFetch(rawUrl, {
      method: init.method,
      headers: init.headers,
      ...(init.body == null ? {} : { body: init.body }),
      ...(init.signal == null ? {} : { signal: init.signal }),
      // ═══ LOAD-BEARING ═══ without this, `fetch` follows a peer's 307 into
      // the LAN and carries the request body with it.
      redirect: 'manual',
      dispatcher: agent(),
    });
  } catch (error: unknown) {
    // undici wraps a connect-time failure, so the guard's own error arrives as
    // `cause`. Surface it as a refusal rather than as an unreachable peer.
    const err = error as Error & { cause?: Error };
    const cause = err?.cause ?? err;
    if (cause instanceof EgressBlockedError || cause?.name === 'EgressBlockedError') {
      throw new EgressBlockedError(
        cause instanceof EgressBlockedError ? cause.reason : 'address not permitted',
      );
    }

    throw error;
  }

  if (response.status >= 300 && response.status < 400) {
    // Drain, so refusing a redirect does not leak the socket.
    await response.body?.cancel().catch(() => {});

    throw new EgressBlockedError(`peer answered ${response.status} with a redirect, which is not followed`);
  }

  return response;
}
