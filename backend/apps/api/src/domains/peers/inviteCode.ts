import { createHash, randomBytes } from 'node:crypto';

import { stripInvisible } from '@ci/common/stripInvisible';

import { isDidKeyId } from './didKeyId';
import { publishedBase } from './peerRequest';

/**
 * The code one person hands another to link their Companions.
 *
 * `cmi1.` followed by base64url JSON: the inviter's `/agent/v1` address (`e`),
 * their `did:key` (`k`), a one-time secret (`s`) and the name they chose to be
 * shown by (`n`). It is a capability: whoever holds it can link to the inviter
 * once, at the lowest trust tier, until it expires. So it is shared the way a
 * door code is, directly, and the confirmation words (`safetyCode.ts`) are how
 * the two people check afterwards that nobody swapped it on the way.
 */
const PREFIX = 'cmi1.';

/** Longest code accepted. A real one is about 300 characters. */
const MAX_CODE_LENGTH = 2_000;

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const MAX_INVITE_NAME_LENGTH = 80;

export interface InviteCode {
  endpoint: string;
  didKey: string;
  secret: string;
  name: string;
}

export function newInviteSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored for a secret: base64url SHA-256, so a copy of the table accepts nothing. */
export function hashInviteSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

export function isInviteSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET_PATTERN.test(value);
}

/** A display name as it may be stored and shown: visible characters only, trimmed, bounded; null if nothing is left. */
export function cleanPersonName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const cleaned = stripInvisible(value.normalize('NFKC')).replace(/\s+/g, ' ').trim();

  return cleaned.length === 0 ? null : cleaned.slice(0, MAX_INVITE_NAME_LENGTH);
}

export function encodeInviteCode(code: InviteCode): string {
  const json = JSON.stringify({ e: code.endpoint, k: code.didKey, s: code.secret, n: code.name });

  return `${PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

/**
 * The invite a pasted code names, or null for anything that is not one. Every
 * field is checked here, so nothing downstream sees an address that is not an
 * https base, a key that is not a did:key, or a name with hidden characters.
 */
export function parseInviteCode(raw: string): InviteCode | null {
  const text = raw.replace(/\s+/g, '');
  if (!text.startsWith(PREFIX) || text.length > MAX_CODE_LENGTH) {
    return null;
  }

  const body = text.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed == null) {
    return null;
  }

  const { e, k, s, n } = parsed as Record<string, unknown>;
  const endpoint = typeof e === 'string' ? publishedBase(e) : null;
  const name = cleanPersonName(n);

  if (
    endpoint == null ||
    !endpoint.startsWith('https://') ||
    typeof k !== 'string' ||
    !isDidKeyId(k) ||
    !isInviteSecret(s) ||
    name == null
  ) {
    return null;
  }

  return { endpoint, didKey: k, secret: s, name };
}

/**
 * A link handle made from a person's name: lowercase letters, digits and
 * hyphens, at most 32 characters, `peer` when nothing usable is left. The
 * caller makes it unique.
 */
export function handleFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');

  return slug || 'peer';
}

/** `base`, or `base-2`, `base-3`… — the first one not in `taken`. */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }

  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
