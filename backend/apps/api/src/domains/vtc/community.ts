import { randomInt, randomUUID } from 'node:crypto';

import { DTG_CONTEXT_V1, W3C_CREDENTIALS_V2 } from './contexts';
import { secureDocument } from './dataIntegrity';
import { toDateTimeStamp } from './dateTime';
import { parseDtgCredential } from './dtgCredential';
import type { Signer } from './ed25519';
import type { JsonObject } from './json';
import {
  buildStatusListCredential,
  createBitstring,
  encodeBitstring,
  expandBitstring,
  MIN_STATUS_LIST_ENTRIES,
  readStatus,
  writeStatus,
} from './statusList';

/**
 * The issuing half of a Verifiable Trust Community: what a community does to turn "an admin
 * approved this person" into a credential the member holds and anyone can check.
 *
 *   1. allocate a slot in the community's revocation list,
 *   2. sign a Verifiable Membership Credential (VMC) for the member's DID that names the slot,
 *   3. later, set the slot's bit and publish the list again to revoke it.
 *
 * What is NOT here, and is the service's job around this class: deciding who may join (join
 * criteria, admin review, step-up, second-party consent), persisting the slot state and the
 * credentials, serving `GET /v1/status-lists/revocation`, and appending each decision to the
 * audit chain (`auditChain.ts`). The signing key arrives as a `Signer`, so custody can be a local
 * key, a VTA, or an enclave.
 *
 * The credential has the shape OpenVTC's VTC documents (`docs/03-vtc/credentials.md`): DTG v1
 * contexts, `issuerScope: public`, a FINITE `validUntil` (30 days by default, since an external
 * verifier must see a bounded credential), and one `BitstringStatusListEntry` for `revocation`.
 * Every credential is read back by the DTG reader (`dtgCredential.ts`) before it is returned. That
 * checks the envelope only. It does not re-verify the signature (a `Signer` is not given its
 * public key, so a mis-wired one would yield credentials nobody can verify), and it does not apply
 * a verifier's limits: a recognizer refuses a lifetime above its cap (90 days by default,
 * `recognition.ts`), so a community that issues for longer must have its verifiers raise the cap.
 *
 * Renewing is another `issueMembership` call and takes a NEW slot. Revoking the newest credential
 * leaves the older one valid until it expires, so a service keeps every `statusIndex` it issued to
 * a member and revokes them all.
 */

/**
 * Slots 0 to 3 are never given to a credential, and are set from the first publication, so a new
 * community's first member is not visibly "index 0" (as OpenVTC's VTC spec §6.2 describes; its
 * service instead sets about 5% of a new list's slots at random, which also hides the member count).
 */
export const RESERVED_DECOY_SLOTS = 4;

export const DEFAULT_MEMBERSHIP_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_LIST_VALIDITY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LIST_TTL_MS = 60 * 60 * 1000;

/** Set bits in each byte value, for counting free slots a byte at a time. */
const POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let count = 0;
  for (let rest = value; rest > 0; rest >>= 1) {
    count += rest & 1;
  }

  return count;
});

export class StatusListFullError extends Error {
  constructor() {
    super('every slot in the status list is allocated');
    this.name = 'StatusListFullError';
  }
}

/** Serializable state of a `StatusSlots`: the persisted form. */
export interface StatusSlotsSnapshot {
  /** The list as published: `u` + base64url of the GZIP-compressed status bits. */
  statusList: string;
  /** The same encoding over which slots have been handed out. Never published. */
  allocated: string;
}

/**
 * One status list's state: which slots are handed out, and which of those are revoked.
 *
 * "Handed out" and "revoked" are separate facts. A new credential's slot reads 0 (valid), exactly
 * like a slot nobody has, so the list alone cannot tell the allocator what is free.
 *
 * Not safe to share between writers. The service persisting it must serialize allocate and revoke.
 */
export class StatusSlots {
  private constructor(
    private readonly status: Uint8Array,
    private readonly allocated: Uint8Array,
  ) {}

  /** A fresh list with the decoy slots set and reserved. */
  static create(entries: number = MIN_STATUS_LIST_ENTRIES): StatusSlots {
    const slots = new StatusSlots(createBitstring(entries), createBitstring(entries));
    for (let index = 0; index < RESERVED_DECOY_SLOTS; index += 1) {
      writeStatus(slots.status, index, 1);
      writeStatus(slots.allocated, index, 1);
    }

    return slots;
  }

  static restore(snapshot: StatusSlotsSnapshot): StatusSlots {
    const status = expandBitstring(snapshot.statusList);
    const allocated = expandBitstring(snapshot.allocated);
    if (status.length !== allocated.length) {
      throw new RangeError('the persisted status list and allocation map do not describe the same list');
    }

    if (status.length * 8 < MIN_STATUS_LIST_ENTRIES) {
      throw new RangeError(`the persisted list is below the ${MIN_STATUS_LIST_ENTRIES}-entry floor`);
    }

    // The invariants the allocator relies on. A snapshot that breaks them would hand out a slot
    // that is already revoked, or give two members the same one.
    for (let byte = 0; byte < status.length; byte += 1) {
      if (((status[byte] ?? 0) & ~(allocated[byte] ?? 0)) !== 0) {
        throw new RangeError('the persisted status list has a slot set that was never handed out');
      }
    }

    for (let index = 0; index < RESERVED_DECOY_SLOTS; index += 1) {
      if (readStatus(status, index) !== 1 || readStatus(allocated, index) !== 1) {
        throw new RangeError(
          `the persisted lists do not hold the decoy slots 0 to ${RESERVED_DECOY_SLOTS - 1}`,
        );
      }
    }

    return new StatusSlots(status, allocated);
  }

  get entries(): number {
    return this.status.length * 8;
  }

  /**
   * Hands out a free slot chosen at random (the specification's §6 asks issuers to assign indexes
   * randomly, so a slot number does not reveal when its credential was issued).
   */
  allocate(): number {
    const span = this.entries - RESERVED_DECOY_SLOTS;

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const index = RESERVED_DECOY_SLOTS + randomInt(span);
      if (this.isFree(index)) {
        writeStatus(this.allocated, index, 1);

        return index;
      }
    }

    // The list is dense, so guessing stops paying. Draw uniformly from the slots that are left:
    // walking on from a random start would favour the slot that follows the longest taken run.
    // Counted a byte at a time (the decoys are taken, so no mask needs to skip them).
    let free = 0;
    for (let byte = 0; byte < this.allocated.length; byte += 1) {
      free += POPCOUNT[this.freeMask(byte)] ?? 0;
    }

    if (free === 0) {
      throw new StatusListFullError();
    }

    let skip = randomInt(free);
    for (let byte = 0; byte < this.allocated.length; byte += 1) {
      const mask = this.freeMask(byte);
      const count = POPCOUNT[mask] ?? 0;
      if (skip >= count) {
        skip -= count;
        continue;
      }

      for (let bit = 0; bit < 8; bit += 1) {
        if ((mask & (0x80 >> bit)) === 0) {
          continue;
        }

        if (skip === 0) {
          const index = byte * 8 + bit;
          writeStatus(this.allocated, index, 1);

          return index;
        }

        skip -= 1;
      }
    }

    throw new StatusListFullError();
  }

  /** Never handed out and not set. A set slot is not free even if the allocation map forgot it. */
  private isFree(index: number): boolean {
    return readStatus(this.allocated, index) === 0 && readStatus(this.status, index) === 0;
  }

  /** The free slots of one byte of the map, left-most slot in the high bit. */
  private freeMask(byte: number): number {
    return ~((this.allocated[byte] ?? 0) | (this.status[byte] ?? 0)) & 0xff;
  }

  /** Gives back a slot that was allocated but never put on a credential. */
  release(index: number): void {
    if (index < RESERVED_DECOY_SLOTS || readStatus(this.status, index) === 1) {
      throw new RangeError(`slot ${index} cannot be released`);
    }

    writeStatus(this.allocated, index, 0);
  }

  isAllocated(index: number): boolean {
    return readStatus(this.allocated, index) === 1;
  }

  isRevoked(index: number): boolean {
    return readStatus(this.status, index) === 1;
  }

  /** Revocation is permanent: a revocation list's bit never goes back to 0. */
  revoke(index: number): void {
    if (index < RESERVED_DECOY_SLOTS || !this.isAllocated(index)) {
      throw new RangeError(`slot ${index} was never handed out`);
    }

    writeStatus(this.status, index, 1);
  }

  bits(): Uint8Array {
    return this.status.slice();
  }

  snapshot(): StatusSlotsSnapshot {
    return { statusList: encodeBitstring(this.status), allocated: encodeBitstring(this.allocated) };
  }
}

export interface CommunityIssuerOptions {
  /** The community's DID. */
  did: string;
  /** Signs as the community; its `verificationMethod` must be a key under `did`. */
  signer: Signer;
  /** The https URL the revocation list is served from. */
  revocationListUrl: string;
  /** Restored state; a new list is created when absent. */
  revocation?: StatusSlots;
  clock?: () => Date;
  membershipValidityMs?: number;
  listValidityMs?: number;
  listTtlMs?: number;
}

export interface IssuedMembership {
  /** The signed VMC to hand to the member. */
  credential: JsonObject;
  credentialId: string;
  /**
   * The revocation slot. Store it against the member: it is the only handle for revoking. A
   * renewal gets a new slot, so keep every index issued to a member until its credential expires.
   */
  statusIndex: number;
  /** The credential's own `validUntil`, as written (whole seconds). */
  expiresAt: Date;
}

export class CommunityIssuer {
  readonly revocation: StatusSlots;

  private readonly clock: () => Date;

  constructor(private readonly options: CommunityIssuerOptions) {
    if (!options.signer.verificationMethod.startsWith(`${options.did}#`)) {
      throw new Error(`${options.signer.verificationMethod} is not a key of ${options.did}`);
    }

    // A list valid for under a second would be dated to end before it begins, and every verifier
    // would refuse it at publication.
    const periods: Array<[string, number | undefined, number]> = [
      ['membershipValidityMs', options.membershipValidityMs, 1000],
      ['listValidityMs', options.listValidityMs, 1000],
      ['listTtlMs', options.listTtlMs, 1],
    ];
    for (const [name, value, floor] of periods) {
      if (value !== undefined && !(Number.isFinite(value) && value >= floor)) {
        throw new RangeError(`${name} must be a finite number of milliseconds, ${floor} or more`);
      }
    }

    this.revocation = options.revocation ?? StatusSlots.create();
    this.clock = options.clock ?? (() => new Date());
  }

  /** Issues a membership credential to `member`, a DID, and reserves its revocation slot. */
  async issueMembership(
    member: string,
    options: { personhoodHint?: boolean; validityMs?: number } = {},
  ): Promise<IssuedMembership> {
    const now = this.clock();
    const validityMs =
      options.validityMs ?? this.options.membershipValidityMs ?? DEFAULT_MEMBERSHIP_VALIDITY_MS;
    if (!Number.isFinite(validityMs) || validityMs < 1000) {
      throw new RangeError('a membership credential must be valid for a finite period of at least a second');
    }

    const expiresAt = new Date(now.getTime() + validityMs);
    const statusIndex = this.revocation.allocate();
    const credentialId = `urn:uuid:${randomUUID()}`;

    try {
      const unsecured: JsonObject = {
        '@context': [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1],
        id: credentialId,
        type: [
          'VerifiableCredential',
          'DTGCredential',
          'MembershipCredential',
          ...(options.personhoodHint ? ['PersonhoodCredential'] : []),
        ],
        issuer: this.options.did,
        issuerScope: 'public',
        validFrom: toDateTimeStamp(now),
        validUntil: toDateTimeStamp(expiresAt),
        credentialSubject: { id: member },
        credentialStatus: {
          id: `${this.options.revocationListUrl}#${statusIndex}`,
          type: 'BitstringStatusListEntry',
          statusPurpose: 'revocation',
          statusListIndex: String(statusIndex),
          statusListCredential: this.options.revocationListUrl,
        },
      };

      const credential = await secureDocument(unsecured, this.options.signer, { created: now });
      const written = parseDtgCredential(credential);

      return { credential, credentialId, statusIndex, expiresAt: written.validUntil ?? expiresAt };
    } catch (error) {
      this.revocation.release(statusIndex);
      throw error;
    }
  }

  /** Sets the credential's bit. Takes effect for verifiers when the list is next published. */
  revoke(statusIndex: number): void {
    this.revocation.revoke(statusIndex);
  }

  /**
   * The signed revocation list for verifiers. It is valid for a day by default: a verifier refuses
   * a list past its `validUntil`, and (by default) one whose `validFrom` is more than a day old,
   * which bounds how long a replayed old copy could hide a revocation. Publish again before it
   * lapses, and after every revocation.
   */
  async publishRevocationList(): Promise<JsonObject> {
    const now = this.clock();
    const unsecured = buildStatusListCredential({
      id: this.options.revocationListUrl,
      issuer: this.options.did,
      purpose: 'revocation',
      bits: this.revocation.bits(),
      validFrom: now,
      validUntil: new Date(now.getTime() + (this.options.listValidityMs ?? DEFAULT_LIST_VALIDITY_MS)),
      ttlMs: this.options.listTtlMs ?? DEFAULT_LIST_TTL_MS,
    });

    return secureDocument(unsecured, this.options.signer, { created: now });
  }
}
