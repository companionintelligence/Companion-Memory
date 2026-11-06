import { isIP } from 'node:net';

import { stripInvisible } from '@ci/domains/asks/canonical';

import { isDidKeyId, wellFormedDidKeyJwk } from './didKeyId';

/**
 * Reading a Local.Pub profile: WebFinger (RFC 7033) to the ActivityPub actor, and from the actor
 * the claims a Companion owner needs to decide whether to link that person.
 *
 * ═══ EVERYTHING HERE IS A CLAIM, NOT A FACT ═══
 *
 * A profile says "my Companion is at this address" and "its key is this did:key". The profile's host
 * (and Local.Pub, which runs it) says so; nothing in what is read here proves that the person the
 * owner has in mind wrote it, or that their Companion signs with that key. That is why a
 * {@link LocalPubCandidate} never creates a peer link and never carries a trust tier: the owner makes
 * the link, as `stranger`, after confirming the key with the person, and raises it later by choice
 * (see `PeerLinkResolver`). What IS checked is internal consistency: the WebFinger subject names the
 * handle that was asked for, the actor's `id` is the URL it was fetched from, and the actor sits on
 * the handle's own host.
 *
 * ═══ WHAT IS DELIBERATELY NOT RETURNED: THE ACTOR'S OWN KEY ═══
 *
 * An actor lists an Ed25519 `Multikey` under `assertionMethod` (FEP-521a). For the one real account
 * examined (2026-11-05) that key is in none of the 31 entries of the person's own DID log, whose
 * authentication key is derived from the passkey and can rotate; nothing shows that the person, or
 * their Companion, holds the private half. A link made from it would name a key whose holder nothing
 * public ties to the person, and a Companion signs with its OWN key (`peers.signingKeyJwk`), so asks
 * from it would never match. It is therefore not offered. The Companion's key comes from a profile
 * field the owner of the Companion writes (below), where it is at least the claim of the right party.
 *
 * ═══ HOW A PERSON MAKES THEIR COMPANION FINDABLE ═══
 *
 * They add ONE profile field whose NAME contains "companion" (any case) and whose value contains an
 * `https` address (their Companion's `/agent/v1` base, as a link or as text; no query, no fragment) and/or their Companion's
 * `did:key` (the `kid` of its `peers.signingKeyJwk`). The address and the key are read from the SAME
 * field and never combined from two: a profile that lists a retired field before the current one must
 * not yield the old address with the new key, because the owner links exactly that pair. Mastodon-style
 * fields are served by Local.Pub as ActivityPub `PropertyValue` attachments. This convention is ours:
 * nothing guarantees that Local.Pub keeps such a field, and the value is whatever the profile's owner
 * or host put there.
 *
 * Pure: no I/O, no clock, no config. `LocalPubDiscoveryService` does the fetching.
 */

/** A handle split into the two halves WebFinger needs. */
export interface LocalPubHandle {
  /** The local part, as given (case preserved; compared case-insensitively). */
  name: string;
  /** The host: lower-case ASCII (punycode for an internationalized name), no port. */
  domain: string;
  /** `name@domain`, the form stored on a peer link. */
  handle: string;
}

/** What a profile claims about its owner. Always unverified; see the file header. */
export interface LocalPubCandidate {
  /** `name@domain`. */
  handle: string;
  /** The ActivityPub actor id: the URL the profile was read from. */
  actorId: string;
  profileUrl: string | null;
  displayName: string | null;
  /** DIDs the actor lists under `alsoKnownAs`, any method. For display only: none of them is read as a key. */
  claimedDids: string[];
  /** An `https` address from a profile field named for a Companion, or null. */
  companionEndpoint: string | null;
  /** A canonical Ed25519 `did:key` from a profile field named for a Companion, or null. */
  companionDidKey: string | null;
}

const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Two or more DNS labels of lower-case ASCII letters, digits and inner hyphens, each at most 63 characters. */
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ACTOR_TYPES: ReadonlySet<string> = new Set(['Person', 'Service', 'Application']);

const MAX_DISPLAY_NAME = 200;
const MAX_URL = 2048;
const MAX_CLAIMED_DIDS = 8;
const MAX_ATTACHMENTS = 32;

/**
 * How many did:key candidates are looked at in one field, and how many of them may reach the curve test
 * (about 0.2 ms each) in one actor. A hostile actor can pack 36 candidates into a field and 32 such
 * fields into the 256 KiB it may send; without the caps one lookup was a quarter of a second of
 * blocked event loop.
 */
const MAX_DID_KEY_CANDIDATES_PER_FIELD = 4;
const MAX_CURVE_CHECKS_PER_ACTOR = 8;
const MAX_FIELD_VALUE = 2048;

/**
 * Code points removed from text shown to an owner after `stripInvisible` has run. That function keeps
 * what an emoji needs, and a run of tag characters after a black flag is one of those things: unbounded,
 * invisible and ASCII, so up to 199 hidden characters. The whole Tags block therefore goes here, and
 * the England, Scotland and Wales flags show as the plain black flag. Also the controls and the line
 * and paragraph separators, which it does not touch.
 */
const CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x2028, 0x2029], // line and paragraph separators
  [0xe0000, 0xe007f], // tag characters, including the run an emoji flag may carry
];

/**
 * Split `@name@host`, `name@host` or `acct:name@host` into a {@link LocalPubHandle}, or null.
 *
 * Strict on purpose: the host that is contacted is the host that was typed. Anything the URL parser
 * would rewrite (a port, a path, a query, userinfo, a backslash, a tab, percent-encoding, an
 * internationalized name, a trailing dot, an empty label, legacy numeric IPv4 such as `127.1`) is
 * refused rather than normalized, and so are an IP literal and a single-label host. Write an
 * internationalized host in punycode (`xn--...`). WebFinger for a handle is always
 * `https://<host>/.well-known/webfinger`; letting a handle choose a port or an address would let it
 * choose where this box connects.
 */
export function parseLocalPubHandle(input: string): LocalPubHandle | null {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input
    .trim()
    .replace(/^acct:/i, '')
    .replace(/^@/, '');
  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return null;
  }

  const [name, rawDomain] = parts;
  const domain = asciiLowerCase(rawDomain);
  if (!NAME_PATTERN.test(name) || domain.length > 253 || !HOST_PATTERN.test(domain)) {
    return null;
  }

  // A real top-level label contains a letter. All-numeric last labels are how the URL parser reads
  // legacy IPv4 forms (`127.1`, `0x7f.1`, `2130706433`).
  const topLabel = domain.slice(domain.lastIndexOf('.') + 1);
  if (!/[a-z]/.test(topLabel) || isIP(domain) !== 0) {
    return null;
  }

  // Belt and braces: the URL parser must read the same host back.
  let hostname: string;
  try {
    hostname = new URL(`https://${domain}/`).hostname;
  } catch {
    return null;
  }

  return hostname === domain ? { name, domain, handle: `${name}@${domain}` } : null;
}

/** `https://<host>/.well-known/webfinger?resource=acct:<name>@<host>`. */
export function webfingerUrl(handle: LocalPubHandle): string {
  return `https://${handle.domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${handle.handle}`)}`;
}

/**
 * The actor URL a WebFinger answer points at, or null when the answer is not about this handle,
 * has no ActivityPub `self` link, or points off the handle's own host.
 */
export function actorUrlFromWebfinger(jrd: unknown, handle: LocalPubHandle): string | null {
  const body = asRecord(jrd);
  if (body == null || typeof body.subject !== 'string') {
    return null;
  }

  // The answer must be about the account that was asked for, not whichever one the server prefers.
  if (asciiLowerCase(body.subject.replace(/^acct:/i, '')) !== asciiLowerCase(handle.handle)) {
    return null;
  }

  const links = Array.isArray(body.links) ? body.links : [];
  for (const entry of links) {
    const link = asRecord(entry);
    if (
      link != null &&
      link.rel === 'self' &&
      typeof link.type === 'string' &&
      /activity\+json|ld\+json/.test(link.type) &&
      typeof link.href === 'string'
    ) {
      return sameHostHttps(link.href, handle.domain);
    }
  }

  return null;
}

/**
 * Read an actor document into a {@link LocalPubCandidate}, or null when it is not the actor that
 * `actorUrl` names for `handle`.
 */
export function candidateFromActor(
  actor: unknown,
  handle: LocalPubHandle,
  actorUrl: string,
): LocalPubCandidate | null {
  const body = asRecord(actor);
  if (body == null || typeof body.type !== 'string' || !ACTOR_TYPES.has(body.type)) {
    return null;
  }

  // Both sides in the URL parser's canonical form: an actor whose `id` is spelled differently from the
  // WebFinger `href` (case in the host, a default port) is the same URL, and one that is not, is not.
  if (typeof body.id !== 'string' || httpsUrl(body.id) !== actorUrl) {
    return null;
  }

  // `preferredUsername` is optional in ActivityPub, but when it is there it must be the name asked
  // for: an actor that answers to a different name is not this handle.
  if (
    typeof body.preferredUsername === 'string' &&
    asciiLowerCase(body.preferredUsername) !== asciiLowerCase(handle.name)
  ) {
    return null;
  }

  const companion = companionClaims(body.attachment);

  return {
    handle: handle.handle,
    actorId: actorUrl,
    profileUrl: typeof body.url === 'string' ? httpsUrl(body.url) : null,
    displayName: cleanText(body.name, MAX_DISPLAY_NAME),
    claimedDids: claimedDids(body.alsoKnownAs),
    companionEndpoint: companion.endpoint,
    companionDidKey: companion.didKey,
  };
}

function claimedDids(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const item of list) {
    if (
      typeof item === 'string' &&
      /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,300}$/.test(item) &&
      !out.includes(item)
    ) {
      out.push(item);
    }

    if (out.length === MAX_CLAIMED_DIDS) {
      break;
    }
  }

  return out;
}

/**
 * What the profile fields named for a Companion claim: an `https` address and a canonical Ed25519
 * `did:key`, both from ONE field. That is the first field that holds both; failing that, the first
 * that holds either. They are never assembled from two fields, because the owner links exactly this
 * pair and a retired field listed before the current one would otherwise lend its address to the
 * new key. Name-matched only: a link or a key that merely happens to sit in another field is not read
 * as a Companion's. Local.Pub renders a link field as HTML (`<a href="...">`); a bare address or key
 * in the text is read as itself.
 */
function companionClaims(attachment: unknown): { endpoint: string | null; didKey: string | null } {
  let partial: { endpoint: string | null; didKey: string | null } | null = null;
  const budget = { curveChecks: MAX_CURVE_CHECKS_PER_ACTOR };

  for (const entry of asArray(attachment).slice(0, MAX_ATTACHMENTS)) {
    const field = asRecord(entry);
    if (
      field == null ||
      field.type !== 'PropertyValue' ||
      typeof field.name !== 'string' ||
      typeof field.value !== 'string' ||
      !/companion/i.test(field.name)
    ) {
      continue;
    }

    // A value that long is not an address and a key: it is read as nothing, not cut short, because an
    // address cut in the middle is a different address.
    if (field.value.length > MAX_FIELD_VALUE) {
      continue;
    }

    const claims = { endpoint: firstHttpsUrl(field.value), didKey: firstDidKey(field.value, budget) };
    if (claims.endpoint != null && claims.didKey != null) {
      return claims;
    }

    if (partial == null && (claims.endpoint != null || claims.didKey != null)) {
      partial = claims;
    }
  }

  return partial ?? { endpoint: null, didKey: null };
}

function firstHttpsUrl(value: string): string | null {
  const candidates = [
    ...[...value.matchAll(/href="(https:\/\/[^"\s]+)"/gi)].map((match) => match[1]),
    ...[...value.matchAll(/https:\/\/[^\s"'<>]+/gi)].map((match) => match[0]),
  ];
  for (const candidate of candidates) {
    const url = httpsUrl(candidate);
    // The owner passes this as `memoryEndpoint`, and `/ask` is appended to it as text: a query or a
    // fragment would swallow the path and the ask would go to the base without a word. Not a base: skip.
    if (url != null && !/[?#]/.test(url)) {
      return url;
    }
  }

  return null;
}

function firstDidKey(value: string, budget: { curveChecks: number }): string | null {
  let looked = 0;
  for (const match of value.matchAll(/did:key:z[1-9A-HJ-NP-Za-km-z]{47}/g)) {
    looked += 1;
    if (looked > MAX_DID_KEY_CANDIDATES_PER_FIELD) {
      break;
    }

    // The cheap test first: only a well-formed candidate is worth the curve test.
    if (wellFormedDidKeyJwk(match[0]) == null) {
      continue;
    }

    if (budget.curveChecks <= 0) {
      break;
    }

    budget.curveChecks -= 1;
    if (isDidKeyId(match[0])) {
      return match[0];
    }
  }

  return null;
}

/** `value` as an `https` URL without credentials, in the URL parser's canonical form, or null. */
function httpsUrl(value: string): string | null {
  if (value.length > MAX_URL) {
    return null;
  }

  try {
    const url = new URL(value);

    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `value` when it is an `https` URL on exactly `domain` (default port), else null. */
function sameHostHttps(value: string, domain: string): string | null {
  const url = httpsUrl(value);
  if (url == null) {
    return null;
  }

  const parsed = new URL(url);

  return parsed.hostname === domain && parsed.port === '' ? url : null;
}

/**
 * Text with what renders as nothing removed (`stripInvisible`, the rule the ask prompts use, which
 * keeps an emoji's own joiner and variation selector), controls and line separators removed, and a
 * length cap in characters; null when nothing is left.
 */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const kept = Array.from(stripInvisible(value)).filter((char) => {
    const codePoint = char.codePointAt(0) ?? 0;

    return !CONTROL_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
  });
  const cleaned = kept.join('').trim();
  if (cleaned.length === 0) {
    return null;
  }

  // Strip again after the cut: a joiner whose partner fell beyond it would be left dangling at the end.
  const cut = stripInvisible(Array.from(cleaned).slice(0, max).join('')).trim();

  return cut.length > 0 ? cut : null;
}

/** Lower-cases A-Z only. `toLowerCase` also folds the Kelvin sign (U+212A) into a plain `k`. */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  return value == null ? [] : [value];
}
