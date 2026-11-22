import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import { didKeyPublicJwk, isDidKeyId } from './didKeyId';

/**
 * The two notices one box sends another about a link: "I have a new key" and
 * "I ended our link". Each names its RECIPIENT, the person on the other box the
 * link is with (their `did:key`, which the sender's link records), so a box
 * with several people on it changes only that person's link.
 */

export const KEY_ROTATION_PATH = '/key-rotation';
export const UNLINK_PATH = '/unlink';

const ROTATION_DOMAIN = 'companion-memory key rotation v1\n';

export interface KeyRotationNotice {
  v: 1;
  oldDidKey: string;
  newDidKey: string;
  recipient: string;
  /** base64url signature by the NEW key over {@link rotationMessage}: the sender holds it. */
  proof: string;
}

export interface UnlinkNotice {
  v: 1;
  recipient: string;
}

function rotationMessage(oldDidKey: string, newDidKey: string): string {
  return `${ROTATION_DOMAIN}${oldDidKey}\n${newDidKey}`;
}

/**
 * The rotation notice. The REQUEST carrying it is signed by the old key (the one
 * the recipient's link names); the proof inside is signed by the new key, so
 * the link is never moved to a key its holder cannot sign with.
 */
export function rotationNotice(fields: {
  oldDidKey: string;
  newDidKey: string;
  newKey: KeyObject;
  recipient: string;
}): KeyRotationNotice {
  const proof = sign(
    null,
    Buffer.from(rotationMessage(fields.oldDidKey, fields.newDidKey), 'utf8'),
    fields.newKey,
  );

  return {
    v: 1,
    oldDidKey: fields.oldDidKey,
    newDidKey: fields.newDidKey,
    recipient: fields.recipient,
    proof: proof.toString('base64url'),
  };
}

/** The notice in `raw`, if it is one whose proof verifies; null otherwise. */
export function readRotationNotice(raw: unknown): KeyRotationNotice | null {
  if (typeof raw !== 'object' || raw == null) {
    return null;
  }

  const notice = raw as Partial<KeyRotationNotice>;
  if (
    notice.v !== 1 ||
    typeof notice.oldDidKey !== 'string' ||
    typeof notice.newDidKey !== 'string' ||
    typeof notice.recipient !== 'string' ||
    typeof notice.proof !== 'string' ||
    !isDidKeyId(notice.oldDidKey) ||
    !isDidKeyId(notice.newDidKey) ||
    !isDidKeyId(notice.recipient) ||
    notice.oldDidKey === notice.newDidKey
  ) {
    return null;
  }

  const jwk = didKeyPublicJwk(notice.newDidKey);
  if (jwk == null) {
    return null;
  }

  try {
    const ok = verify(
      null,
      Buffer.from(rotationMessage(notice.oldDidKey, notice.newDidKey), 'utf8'),
      createPublicKey({ key: jwk as never, format: 'jwk' }),
      Buffer.from(notice.proof, 'base64url'),
    );

    return ok ? (notice as KeyRotationNotice) : null;
  } catch {
    return null;
  }
}

export function readUnlinkNotice(raw: unknown): UnlinkNotice | null {
  if (typeof raw !== 'object' || raw == null) {
    return null;
  }

  const notice = raw as Partial<UnlinkNotice>;

  return notice.v === 1 && typeof notice.recipient === 'string' && isDidKeyId(notice.recipient)
    ? { v: 1, recipient: notice.recipient }
    : null;
}
