import { Injectable } from '@nestjs/common';
import type { Response as UndiciResponse } from 'undici';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import {
  actorUrlFromWebfinger,
  candidateFromActor,
  parseLocalPubHandle,
  webfingerUrl,
  type LocalPubCandidate,
} from '../localPubProfile';
import { EgressBlockedError, outstandingPeerEgressLookups, peerEgressFetch } from '../urlPolicy';

export type LocalPubLookupFailure =
  /** `peers.localPubEnabled` is off. */
  | 'disabled'
  /** Not `name@host` with a plain ASCII public DNS host. */
  | 'bad-handle'
  /** The egress policy refused the URL or the address it resolved to. */
  | 'blocked'
  /** The host answered with a redirect, which is never followed. Includes Local.Pub's "redirect" domain mode. */
  | 'redirected'
  /** The host answered, and has no such account. */
  | 'not-found'
  /** The host answered with something that is not a consistent profile for this handle. */
  | 'bad-response'
  /** The host did not answer. */
  | 'unreachable'
  /** More lookups are in flight, still resolving a name, or started in the last minute, than this box allows. */
  | 'busy';

export type LocalPubLookupResult =
  { ok: true; candidate: LocalPubCandidate } | { ok: false; reason: LocalPubLookupFailure };

/** A WebFinger answer is a few hundred bytes; 64 KiB is generous and bounds what a host can make us read. */
export const MAX_WEBFINGER_BYTES = 64 * 1024;

/** An actor with a bio, a dozen fields and a few keys; 256 KiB bounds the rest. */
export const MAX_ACTOR_BYTES = 256 * 1024;

/**
 * At most this many lookups run at once, process-wide.
 */
export const MAX_CONCURRENT_LOOKUPS = 2;

/**
 * No lookup starts while this many name lookups (resolver calls) are still waiting for DNS, whoever
 * made them: this feature or a peer ask, because all peer egress shares one agent and one counter.
 *
 * A lookup resolves a name chosen by the caller. `AbortSignal.timeout` rejects the fetch, but it cannot
 * cancel the `dns.lookup` underneath it: that is `getaddrinfo` on libuv's thread pool, held until the
 * system resolver gives up, which can be well after the deadline. libuv lets that kind of work use two
 * of the pool's four threads (UV_THREADPOOL_SIZE is set nowhere), and every other lookup in the process
 * shares them. Counting fetches alone would hand the slot back at the deadline while the thread was
 * still busy, and a caller asking for names that never answer could queue work in front of every other
 * lookup without limit. Counting the resolver calls bounds that, and the bound is ONE, not two: with two
 * a steady flood holds both threads and every other lookup waits as long as the flood lasts; with one,
 * the flood holds a single thread and the other stays free.
 *
 * What this does NOT do: a flood of fresh unresolvable names still holds that one thread for as long as
 * it lasts (about six names a minute with the resolver's ten seconds per name), and other lookups can
 * queue behind it only on that thread. It also means a stuck lookup made by a peer ask makes Local.Pub
 * lookups answer `busy` until it ends.
 */
export const MAX_OUTSTANDING_RESOLVER_CALLS = 1;

/** At most this many lookups may START per minute, process-wide. */
export const MAX_LOOKUPS_PER_MINUTE = 20;

const RATE_WINDOW_MS = 60_000;

/**
 * The longest deadline that means what it says: `AbortSignal.timeout` fires after ONE millisecond for a
 * delay above this (it does not fit in a signed 32-bit timer) and throws above 2^32 - 1, either of which
 * would fail every lookup at once, and `peers.timeoutMs` is only required to be a positive integer.
 */
const MAX_DEADLINE_MS = 2_147_483_647;

/** "The host has no such document". A symbol, so a body that is the JSON string "missing" cannot pass for it. */
const MISSING = Symbol('missing');

const WEBFINGER_ACCEPT = 'application/jrd+json, application/json';
const ACTOR_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/**
 * Looks a person up on Local.Pub (or any host that serves the same WebFinger and ActivityPub actor
 * with Mastodon-style profile fields) — the second DISCOVERY plane beside `PeerDirectoryService`.
 *
 * ═══ WHAT IT DOES NOT DO ═══
 *
 * It creates no link, grants nothing and verifies no identity. It returns what a profile CLAIMS
 * (see `localPubProfile.ts`), and the owner decides, through the same `createPeerLink` mutation
 * that already exists (whose input defaults to the `stranger` tier). A host that lies about a handle can make the
 * owner look at the wrong key; it cannot make this box answer anyone.
 *
 * ═══ HOW IT REACHES THE NETWORK ═══
 *
 * Only through `peerEgressFetch`, like every other outbound call in this domain: https only, no
 * credentials, no private or link-local address (checked again at connect time), and NO REDIRECT
 * FOLLOWED. A handle's host is chosen by whoever typed the handle, so unlike the Portal directory
 * URL it is not operator config, and an owner can be talked into pasting one. One deadline
 * (`peers.timeoutMs`) covers the WHOLE lookup, both requests and the reading of both bodies.
 *
 * Off by default (`peers.localPubEnabled`): a box that never looks anyone up makes no such call.
 *
 * ═══ HOW MUCH IT MAY BE ASKED ═══
 *
 * {@link MAX_CONCURRENT_LOOKUPS} at once, none while {@link MAX_OUTSTANDING_RESOLVER_CALLS} name lookup is
 * still waiting for DNS (it outlives its fetch), and
 * {@link MAX_LOOKUPS_PER_MINUTE} per minute, for the whole process, answered `busy` beyond that. A
 * GraphQL request can name many aliases of the same field, and an AI app can call the field
 * repeatedly, so the cap lives here and not in the caller.
 */
@Injectable()
export class LocalPubDiscoveryService {
  /** The clock, in milliseconds. A field so tests can move it. Monotonic: a wall-clock step must not move the window. */
  public now: () => number = monotonicMilliseconds;

  private active = 0;

  private readonly started: number[] = [];

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(LocalPubDiscoveryService.name);
  }

  get enabled(): boolean {
    return config.peers?.localPubEnabled === true;
  }

  async lookup(input: string): Promise<LocalPubLookupResult> {
    if (!this.enabled) {
      return { ok: false, reason: 'disabled' };
    }

    const handle = parseLocalPubHandle(input);
    if (handle == null) {
      return { ok: false, reason: 'bad-handle' };
    }

    if (!this.admit()) {
      return this.refuse(
        handle.handle,
        'busy',
        'too many lookups in flight, still resolving a name, or started in the last minute',
      );
    }

    this.active += 1;
    try {
      return await this.read(handle);
    } finally {
      this.active -= 1;
    }
  }

  /** Take a slot, or say there is none. A slot is spent when the lookup STARTS, finished or not. */
  private admit(): boolean {
    const now = this.now();
    while (this.started.length > 0 && now - this.started[0] >= RATE_WINDOW_MS) {
      this.started.shift();
    }

    if (
      this.active >= MAX_CONCURRENT_LOOKUPS ||
      outstandingPeerEgressLookups() >= MAX_OUTSTANDING_RESOLVER_CALLS ||
      this.started.length >= MAX_LOOKUPS_PER_MINUTE
    ) {
      return false;
    }

    this.started.push(now);

    return true;
  }

  private async read(
    handle: NonNullable<ReturnType<typeof parseLocalPubHandle>>,
  ): Promise<LocalPubLookupResult> {
    // One deadline for the whole lookup: both requests and both body reads share it.
    const signal = AbortSignal.timeout(Math.min(config.peers.timeoutMs ?? 10_000, MAX_DEADLINE_MS));

    try {
      const finger = await this.getJson(webfingerUrl(handle), WEBFINGER_ACCEPT, MAX_WEBFINGER_BYTES, signal);
      if (finger === MISSING) {
        return { ok: false, reason: 'not-found' };
      }

      const actorUrl = finger == null ? null : actorUrlFromWebfinger(finger, handle);
      if (actorUrl == null) {
        return this.refuse(handle.handle, 'bad-response', 'webfinger is not about this handle');
      }

      const actor = await this.getJson(actorUrl, ACTOR_ACCEPT, MAX_ACTOR_BYTES, signal);
      if (actor === MISSING) {
        return this.refuse(handle.handle, 'bad-response', 'webfinger names an actor that does not exist');
      }

      const candidate = actor == null ? null : candidateFromActor(actor, handle, actorUrl);
      if (candidate == null) {
        return this.refuse(handle.handle, 'bad-response', 'actor is not this handle');
      }

      return { ok: true, candidate };
    } catch (error: unknown) {
      if (error instanceof EgressBlockedError) {
        return this.refuse(handle.handle, error.redirected ? 'redirected' : 'blocked', error.reason);
      }

      // A timeout, a TLS failure, a refused connection: whatever undici threw, the host did not answer.
      return this.refuse(handle.handle, 'unreachable', String(error));
    }
  }

  private refuse(handle: string, reason: LocalPubLookupFailure, detail: string): LocalPubLookupResult {
    this.logger.warn(`local.pub lookup of ${handle} refused (${reason}): ${detail}`);

    return { ok: false, reason };
  }

  /** The parsed JSON body, {@link MISSING} for a 404/410, or null for anything unusable. */
  private async getJson(
    url: string,
    accept: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await peerEgressFetch(url, { method: 'GET', headers: { accept }, signal });

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();

      return MISSING;
    }

    if (!response.ok) {
      await response.body?.cancel();
      this.logger.warn(`local.pub ${url} → ${response.status}`);

      return null;
    }

    const text = await readCapped(response, maxBytes);
    if (text == null) {
      this.logger.warn(`local.pub ${url} answered with more than ${maxBytes} bytes`);

      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

/** Milliseconds from a clock that never steps back (NTP, a resumed VM), unlike `Date.now`. */
function monotonicMilliseconds(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** The body as text, or null when it is larger than `maxBytes`. Stops reading at the cap. */
async function readCapped(response: UndiciResponse, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();

    return null;
  }

  if (response.body == null) {
    return '';
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
    if (total > maxBytes) {
      await reader.cancel();

      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}
