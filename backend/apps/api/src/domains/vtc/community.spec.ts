import { generateKeyPairSync } from 'node:crypto';

import {
  CommunityIssuer,
  DEFAULT_LIST_TTL_MS,
  DEFAULT_LIST_VALIDITY_MS,
  DEFAULT_MEMBERSHIP_VALIDITY_MS,
  RESERVED_DECOY_SLOTS,
  StatusListFullError,
  StatusSlots,
} from './community';
import { verifyProof } from './dataIntegrity';
import { multikeyFromPublicKey } from './didKey';
import { parseDtgCredential } from './dtgCredential';
import { LocalSigner, rawPublicKey, type Signer } from './ed25519';
import { createKeyResolver } from './keyResolver';
import {
  createBitstring,
  encodeBitstring,
  evaluateStatus,
  expandBitstring,
  MIN_STATUS_LIST_ENTRIES,
  parseStatusEntry,
  readStatus,
  writeStatus,
} from './statusList';

const DID = 'did:webvh:community.example.com:abc';
const METHOD = `${DID}#key-0`;
const LIST_URL = 'https://community.example.com/v1/status-lists/revocation';
const MEMBER = 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const NOW = new Date('2026-11-05T12:00:00Z');

function community(overrides: Partial<ConstructorParameters<typeof CommunityIssuer>[0]> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = new LocalSigner(METHOD, privateKey);
  const issuer = new CommunityIssuer({
    did: DID,
    signer,
    revocationListUrl: LIST_URL,
    clock: () => NOW,
    ...overrides,
  });
  const resolveKey = createKeyResolver({
    pinned: [
      {
        did: DID,
        verificationMethods: [
          { id: METHOD, publicKeyMultibase: multikeyFromPublicKey(rawPublicKey(publicKey)) },
        ],
      },
    ],
  });

  return { issuer, signer, resolveKey };
}

describe('StatusSlots', () => {
  it('starts with the four decoy slots set and reserved', () => {
    const slots = StatusSlots.create();

    expect(RESERVED_DECOY_SLOTS).toBe(4);
    expect(slots.entries).toBe(MIN_STATUS_LIST_ENTRIES);
    for (let index = 0; index < RESERVED_DECOY_SLOTS; index += 1) {
      expect(readStatus(slots.bits(), index)).toBe(1);
      expect(slots.isAllocated(index)).toBe(true);
    }

    expect(readStatus(slots.bits(), RESERVED_DECOY_SLOTS)).toBe(0);
  });

  it('allocates distinct slots outside the decoys, in no particular order', () => {
    const slots = StatusSlots.create();
    const taken = Array.from({ length: 2_000 }, () => slots.allocate());

    expect(new Set(taken).size).toBe(2_000);
    expect(Math.min(...taken)).toBeGreaterThanOrEqual(RESERVED_DECOY_SLOTS);
    expect(Math.max(...taken)).toBeLessThan(MIN_STATUS_LIST_ENTRIES);
    expect(taken.every((index) => slots.isAllocated(index))).toBe(true);
    // 20 sequential draws from 131,068 slots that come out as 4, 5, 6, … would not be random.
    expect(taken.slice(0, 20)).not.toEqual(
      Array.from({ length: 20 }, (_, offset) => RESERVED_DECOY_SLOTS + offset),
    );
    expect(taken.slice(0, 20)).not.toEqual([...taken.slice(0, 20)].sort((a, b) => a - b));
  });

  it('hands out every slot exactly once, then reports the list full', () => {
    const slots = StatusSlots.create();
    const seen = new Set<number>();

    for (let count = 0; count < MIN_STATUS_LIST_ENTRIES - RESERVED_DECOY_SLOTS; count += 1) {
      seen.add(slots.allocate());
    }

    const lowest = [...seen].reduce((low, index) => Math.min(low, index), Number.POSITIVE_INFINITY);
    const highest = [...seen].reduce((high, index) => Math.max(high, index), -1);

    expect(seen.size).toBe(MIN_STATUS_LIST_ENTRIES - RESERVED_DECOY_SLOTS);
    expect(lowest).toBe(RESERVED_DECOY_SLOTS);
    expect(highest).toBe(MIN_STATUS_LIST_ENTRIES - 1);
    expect(() => slots.allocate()).toThrow(StatusListFullError);
  });

  it('revokes an allocated slot permanently and touches no other bit', () => {
    const slots = StatusSlots.create();
    const index = slots.allocate();
    const before = slots.bits();

    slots.revoke(index);
    slots.revoke(index);

    const after = slots.bits();
    expect(slots.isRevoked(index)).toBe(true);
    expect(readStatus(after, index)).toBe(1);
    const changed = after.reduce((count, byte, position) => count + (byte === before[position] ? 0 : 1), 0);
    expect(changed).toBe(1);
  });

  it.each([
    ['a decoy slot', 0],
    ['a slot never handed out', 5000],
  ])('will not revoke %s', (_name, index) => {
    expect(() => StatusSlots.create().revoke(index)).toThrow(RangeError);
  });

  it('gives back an unused slot, but never a decoy or a revoked one', () => {
    const slots = StatusSlots.create();
    const index = slots.allocate();

    slots.release(index);
    expect(slots.isAllocated(index)).toBe(false);

    const revoked = slots.allocate();
    slots.revoke(revoked);
    expect(() => slots.release(revoked)).toThrow(RangeError);
    expect(() => slots.release(0)).toThrow(RangeError);
  });

  it('survives a snapshot and restore', () => {
    const slots = StatusSlots.create();
    const [a, b] = [slots.allocate(), slots.allocate()];
    slots.revoke(a);

    const restored = StatusSlots.restore(slots.snapshot());

    expect([
      restored.isAllocated(a),
      restored.isRevoked(a),
      restored.isAllocated(b),
      restored.isRevoked(b),
    ]).toEqual([true, true, true, false]);
    expect(Array.from(restored.bits())).toEqual(Array.from(slots.bits()));
    expect(restored.allocate()).not.toBe(a);
  });

  it('refuses to restore a snapshot whose two halves do not match', () => {
    const small = StatusSlots.create();
    const large = StatusSlots.create(MIN_STATUS_LIST_ENTRIES * 2);

    expect(() =>
      StatusSlots.restore({ statusList: small.snapshot().statusList, allocated: large.snapshot().allocated }),
    ).toThrow(RangeError);
  });

  it('refuses to restore a list below the 131,072-entry floor, even a consistent one', () => {
    const small = new Uint8Array(MIN_STATUS_LIST_ENTRIES / 8 / 2);
    for (let index = 0; index < RESERVED_DECOY_SLOTS; index += 1) {
      writeStatus(small, index, 1);
    }

    expect(() =>
      StatusSlots.restore({ statusList: encodeBitstring(small), allocated: encodeBitstring(small) }),
    ).toThrow('do not describe the same list');
  });

  describe('refuses to restore a snapshot that breaks what the allocator relies on', () => {
    const decoys = () => {
      const bits = createBitstring();
      for (let index = 0; index < RESERVED_DECOY_SLOTS; index += 1) {
        writeStatus(bits, index, 1);
      }

      return bits;
    };

    it('a slot that is revoked but was never handed out', () => {
      const status = decoys();
      writeStatus(status, 500, 1);

      expect(() =>
        StatusSlots.restore({ statusList: encodeBitstring(status), allocated: encodeBitstring(decoys()) }),
      ).toThrow('never handed out');
    });

    it.each([
      ['a status list without them', createBitstring(), decoys(), 'decoy slots'],
      // Decoys that are set but not allocated are caught first, as slots set without being handed out.
      ['an allocation map without them', decoys(), createBitstring(), 'never handed out'],
    ])('missing decoy slots: %s', (_name, status, allocated, message) => {
      expect(() =>
        StatusSlots.restore({ statusList: encodeBitstring(status), allocated: encodeBitstring(allocated) }),
      ).toThrow(message);
    });

    it('but takes one that is consistent', () => {
      const status = decoys();
      const allocated = decoys();
      writeStatus(allocated, 500, 1);
      writeStatus(status, 500, 1);

      const restored = StatusSlots.restore({
        statusList: encodeBitstring(status),
        allocated: encodeBitstring(allocated),
      });

      expect(restored.isRevoked(500)).toBe(true);
      expect(restored.isAllocated(500)).toBe(true);
    });
  });

  describe('when the list is nearly full', () => {
    /** Every slot taken except `free`, in the persisted form. */
    const nearlyFull = (free: number[]) => {
      const allocated = new Uint8Array(MIN_STATUS_LIST_ENTRIES / 8).fill(0xff);
      for (const index of free) {
        writeStatus(allocated, index, 0);
      }

      const status = createBitstring();
      for (let index = 0; index < RESERVED_DECOY_SLOTS; index += 1) {
        writeStatus(status, index, 1);
      }

      return { statusList: encodeBitstring(status), allocated: encodeBitstring(allocated) };
    };

    it('hands out exactly the free slots, once each, then reports the list full', () => {
      const free = [4, 1000, 65_535, 131_071];
      const slots = StatusSlots.restore(nearlyFull(free));

      const drawn = free.map(() => slots.allocate());

      expect([...drawn].sort((a, b) => a - b)).toEqual(free);
      expect(() => slots.allocate()).toThrow(StatusListFullError);
    });

    it('draws uniformly from them, not by walking on from a random start', () => {
      // 1000 and 1001 sit just after a long taken run; 90,000 sits after an even longer one. A walk
      // from a random start would pick 90,000 about nine times in ten.
      const free = [1000, 1001, 90_000];
      const snapshot = nearlyFull(free);
      const counts = new Map<number, number>(free.map((index) => [index, 0]));

      for (let trial = 0; trial < 900; trial += 1) {
        const index = StatusSlots.restore(snapshot).allocate();
        counts.set(index, (counts.get(index) ?? 0) + 1);
      }

      for (const index of free) {
        // 300 expected, standard deviation about 14: this band is almost six deviations wide.
        expect(counts.get(index)).toBeGreaterThan(220);
        expect(counts.get(index)).toBeLessThan(380);
      }
    });
  });
});

describe('CommunityIssuer', () => {
  it('issues a membership credential that the strict reader accepts', async () => {
    const { issuer } = community();

    const issued = await issuer.issueMembership(MEMBER);
    const credential = parseDtgCredential(issued.credential);

    expect(credential).toMatchObject({
      subtype: 'MembershipCredential',
      personhoodHint: false,
      issuer: DID,
      issuerScope: 'public',
      subject: MEMBER,
      id: issued.credentialId,
    });
    expect(issued.credentialId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(credential.validFrom).toEqual(NOW);
    expect(credential.validUntil?.getTime()).toBe(NOW.getTime() + DEFAULT_MEMBERSHIP_VALIDITY_MS);
    expect(issued.expiresAt).toEqual(credential.validUntil);
    expect(credential.status).toEqual([
      {
        id: `${LIST_URL}#${issued.statusIndex}`,
        statusPurpose: 'revocation',
        statusListIndex: issued.statusIndex,
        statusListCredential: LIST_URL,
        statusSize: 1,
      },
    ]);
    expect(issued.statusIndex).toBeGreaterThanOrEqual(RESERVED_DECOY_SLOTS);
  });

  it('signs as the community, with a proof that verifies and breaks on any change', async () => {
    const { issuer, resolveKey } = community();
    const { credential } = await issuer.issueMembership(MEMBER);

    expect(await verifyProof(credential, { resolveKey })).toMatchObject({
      ok: true,
      verificationMethod: METHOD,
    });
    expect(
      await verifyProof({ ...credential, validUntil: '2099-01-01T00:00:00Z' }, { resolveKey }),
    ).toMatchObject({
      ok: false,
      code: 'PROOF_SIGNATURE_INVALID',
    });
  });

  it('adds the personhood type as a hint when asked, and honours a custom validity', async () => {
    const { issuer } = community();

    const issued = await issuer.issueMembership(MEMBER, { personhoodHint: true, validityMs: 3_600_000 });
    const credential = parseDtgCredential(issued.credential);

    expect(credential.personhoodHint).toBe(true);
    expect(credential.validUntil?.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it('is not an acknowledgement: it names no digest of a grant', async () => {
    const { issuer } = community();

    const { credential } = await issuer.issueMembership(MEMBER);

    expect(parseDtgCredential(credential).subjectDigest).toBeNull();
  });

  it('reports the expiry the credential states, in whole seconds, whatever the clock’s milliseconds', async () => {
    const { issuer } = community({ clock: () => new Date('2026-11-05T12:00:00.789Z') });

    const issued = await issuer.issueMembership(MEMBER);

    expect(issued.expiresAt).toEqual(parseDtgCredential(issued.credential).validUntil);
    expect(issued.expiresAt.getTime() % 1000).toBe(0);
  });

  it('pins its defaults, and honours the periods it is given', async () => {
    expect(DEFAULT_MEMBERSHIP_VALIDITY_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_LIST_TTL_MS).toBe(60 * 60 * 1000);

    const { issuer } = community({
      membershipValidityMs: 2 * 3_600_000,
      listValidityMs: 3 * 3_600_000,
      listTtlMs: 5_000,
    });
    const { credential } = await issuer.issueMembership(MEMBER);
    const list = await issuer.publishRevocationList();

    expect(credential).toMatchObject({ validUntil: '2026-11-05T14:00:00Z' });
    expect(list).toMatchObject({
      validUntil: '2026-11-05T15:00:00Z',
      credentialSubject: { ttl: 5_000 },
    });
  });

  it('keeps every revocation across a restart when the persisted state is handed back', async () => {
    const { issuer, signer, resolveKey } = community();
    const [revoked, kept] = [await issuer.issueMembership(MEMBER), await issuer.issueMembership(MEMBER)];
    issuer.revoke(revoked.statusIndex);
    const persisted = issuer.revocation.snapshot();

    // A new process: a new issuer object whose state comes back from storage.
    const restarted = new CommunityIssuer({
      did: DID,
      signer,
      revocationListUrl: LIST_URL,
      clock: () => NOW,
      revocation: StatusSlots.restore(persisted),
    });
    const list = await restarted.publishRevocationList();

    const entry = (index: number) =>
      parseStatusEntry({
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex: String(index),
        statusListCredential: LIST_URL,
      });
    expect(await verifyProof(list, { resolveKey })).toMatchObject({ ok: true });
    expect(evaluateStatus(entry(revoked.statusIndex), list, { now: NOW })).toMatchObject({ valid: false });
    expect(evaluateStatus(entry(kept.statusIndex), list, { now: NOW })).toMatchObject({ valid: true });

    // And it never hands a persisted slot to someone new.
    const next = await Promise.all(Array.from({ length: 300 }, () => restarted.issueMembership(MEMBER)));
    expect(next.map((issued) => issued.statusIndex)).not.toContain(revoked.statusIndex);
    expect(next.map((issued) => issued.statusIndex)).not.toContain(kept.statusIndex);
    expect(expandBitstring(persisted.allocated).length).toBe(MIN_STATUS_LIST_ENTRIES / 8);
  });

  it.each([0, 999, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a validity of %p and does not use up a slot doing so',
    async (validityMs) => {
      const { issuer } = community();
      const before = issuer.revocation.snapshot().allocated;

      await expect(issuer.issueMembership(MEMBER, { validityMs })).rejects.toThrow(RangeError);

      expect(issuer.revocation.snapshot().allocated).toBe(before);
    },
  );

  it('gives the slot back when signing fails', async () => {
    const failing: Signer = {
      verificationMethod: METHOD,
      sign: () => Promise.reject(new Error('custody offline')),
    };
    const { issuer } = community({ signer: failing });
    const before = issuer.revocation.snapshot().allocated;

    await expect(issuer.issueMembership(MEMBER)).rejects.toThrow('custody offline');

    expect(issuer.revocation.snapshot().allocated).toBe(before);
  });

  it('gives the slot back when the result would not pass its own reader', async () => {
    const { issuer } = community();
    const before = issuer.revocation.snapshot().allocated;

    // Not a DID, so the strict reader refuses the credential it just signed.
    await expect(issuer.issueMembership('https://example.com/member')).rejects.toThrow('SUBJECT');

    expect(issuer.revocation.snapshot().allocated).toBe(before);
  });

  it('refuses a signing key that is not under the community DID', () => {
    const { signer } = community();
    const foreign: Signer = {
      verificationMethod: 'did:webvh:other.example:abc#key-0',
      sign: signer.sign.bind(signer),
    };

    expect(() => community({ signer: foreign })).toThrow('is not a key of');
  });

  it('publishes a signed revocation list that shows exactly the revoked credentials', async () => {
    const { issuer, resolveKey } = community();
    const [first, second] = [await issuer.issueMembership(MEMBER), await issuer.issueMembership(MEMBER)];

    issuer.revoke(first.statusIndex);
    const list = await issuer.publishRevocationList();

    expect(await verifyProof(list, { resolveKey })).toMatchObject({ ok: true });
    const entry = (index: number) =>
      parseStatusEntry({
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex: String(index),
        statusListCredential: LIST_URL,
      });
    const options = { now: NOW };
    expect(evaluateStatus(entry(first.statusIndex), list, options)).toMatchObject({
      status: 1,
      valid: false,
    });
    expect(evaluateStatus(entry(second.statusIndex), list, options)).toMatchObject({
      status: 0,
      valid: true,
    });
    expect(evaluateStatus(entry(0), list, options)).toMatchObject({ status: 1, valid: false });
  });

  it('dates the list for a day and asks verifiers to keep it for an hour', async () => {
    const { issuer } = community();

    const list = await issuer.publishRevocationList();

    expect(list).toMatchObject({
      id: LIST_URL,
      issuer: DID,
      validFrom: '2026-11-05T12:00:00Z',
      validUntil: '2026-11-06T12:00:00Z',
      credentialSubject: { ttl: DEFAULT_LIST_TTL_MS },
    });
    expect(DEFAULT_LIST_VALIDITY_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('will not revoke a slot it never issued', () => {
    expect(() => community().issuer.revoke(12_345)).toThrow(RangeError);
  });
});
