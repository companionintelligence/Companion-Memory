import { createHmac, timingSafeEqual } from 'node:crypto';

import { toDateTimeStamp } from './dateTime';
import { canonicalize } from './jcs';

/**
 * A tamper-evident record of a community's access decisions: each entry carries an HMAC-SHA-256
 * over its own content and the MAC of the entry before it, so changing, removing, inserting or
 * reordering an entry breaks every MAC after it.
 *
 * ═══ WHAT THIS PROVES, AND WHAT IT DOES NOT ═══
 *
 * It is keyed, so only a holder of the key can build or check a chain: it shows the operator that
 * their own log was not edited. It is not a public transparency log and not a signature; a party
 * without the key learns nothing from it, and the operator who holds the key can rewrite all of it.
 * It also cannot see TRUNCATION from the tail on its own: deleting the last entries leaves a valid
 * shorter chain. Keep the latest MAC somewhere the log writer cannot reach and pass it as
 * `expectedHead` when verifying.
 *
 * (Companion Memory's per-ask audit rows use a different, unkeyed internal digest,
 * `asks/auditSaid.ts`; the two are not interchangeable.)
 */

/** The `prev` of the first entry. */
export const AUDIT_GENESIS = 'genesis';

const MIN_KEY_BYTES = 32;

export interface AuditEntry<Event = unknown> {
  seq: number;
  at: string;
  event: Event;
  prev: string;
  mac: string;
}

export type AuditFailure = 'BAD_SEQUENCE' | 'BAD_LINK' | 'BAD_MAC' | 'HEAD_MISMATCH';

export type AuditVerdict =
  { ok: true; length: number; head: string | null } | { ok: false; index: number; reason: AuditFailure };

function macOf(
  key: Uint8Array | string,
  body: { seq: number; at: string; event: unknown; prev: string },
): string {
  const secret = Buffer.from(key);
  if (secret.length < MIN_KEY_BYTES) {
    throw new RangeError(`the audit key must be at least ${MIN_KEY_BYTES} bytes`);
  }

  return createHmac('sha256', secret).update(canonicalize(body), 'utf8').digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

/** The entry that follows `previous` (or starts the chain when it is null). */
export function appendAudit<Event>(
  previous: AuditEntry<Event> | null,
  event: Event,
  key: Uint8Array | string,
  at: Date,
): AuditEntry<Event> {
  const body = {
    seq: previous ? previous.seq + 1 : 0,
    at: toDateTimeStamp(at),
    event,
    prev: previous ? previous.mac : AUDIT_GENESIS,
  };

  return { ...body, mac: macOf(key, body) };
}

/**
 * Checks every link and MAC from the first entry on, and reports the first entry that fails.
 * `expectedHead` is the last MAC the operator recorded elsewhere; without it a truncated chain
 * verifies.
 */
export function verifyAuditChain(
  entries: readonly AuditEntry[],
  key: Uint8Array | string,
  options: { expectedHead?: string | null } = {},
): AuditVerdict {
  let previous: string = AUDIT_GENESIS;

  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index) {
      return { ok: false, index, reason: 'BAD_SEQUENCE' };
    }

    if (entry.prev !== previous) {
      return { ok: false, index, reason: 'BAD_LINK' };
    }

    let expected: string;
    try {
      expected = macOf(key, { seq: entry.seq, at: entry.at, event: entry.event, prev: entry.prev });
    } catch (error) {
      if (error instanceof RangeError && /audit key/.test(error.message)) {
        throw error;
      }

      return { ok: false, index, reason: 'BAD_MAC' };
    }

    if (typeof entry.mac !== 'string' || !sameText(entry.mac, expected)) {
      return { ok: false, index, reason: 'BAD_MAC' };
    }

    previous = entry.mac;
  }

  const head = entries.length === 0 ? null : previous;
  if (options.expectedHead !== undefined && options.expectedHead !== head) {
    return { ok: false, index: Math.max(entries.length - 1, 0), reason: 'HEAD_MISMATCH' };
  }

  return { ok: true, length: entries.length, head };
}
