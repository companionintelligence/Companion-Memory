import { generateKeyPairSync } from 'node:crypto';

import { CommunityIssuer } from './community';
import { DTG_CONTEXT_V1, W3C_CREDENTIALS_V2 } from './contexts';
import { secureDocument } from './dataIntegrity';
import { didKeyFromPublicKey, didKeyVerificationMethod, multikeyFromPublicKey } from './didKey';
import { LocalSigner, rawPublicKey } from './ed25519';
import { createKeyResolver, type KeyResolver } from './keyResolver';
import { createMembershipRecognizer, type RecognizerConfig } from './recognition';
import {
  buildStatusListCredential,
  createBitstring,
  encodeBitstring,
  expandBitstring,
  writeStatus,
} from './statusList';

const COMMUNITY = 'did:webvh:community.example.com:abc';
const METHOD = `${COMMUNITY}#key-0`;
const LIST_URL = 'https://community.example.com/v1/status-lists/revocation';
const SUSPENSION_URL = 'https://community.example.com/v1/status-lists/suspension';
const MEMBER = 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const NOW = new Date('2026-11-05T12:00:00Z');
const HOUR = 3_600_000;

type Json = Record<string, unknown>;

/** Drops members set to `undefined`, which is how a test says "leave this field out". */
const defined = (document: Json): Json =>
  Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));

/** A community with a pinned key, a status list it can republish, and a recognizer that trusts it. */
function world(config: Partial<RecognizerConfig> = {}) {
  const keys = generateKeyPairSync('ed25519');
  const signer = new LocalSigner(METHOD, keys.privateKey);
  const issuer = new CommunityIssuer({
    did: COMMUNITY,
    signer,
    revocationListUrl: LIST_URL,
    clock: () => NOW,
  });
  const multikey = multikeyFromPublicKey(rawPublicKey(keys.publicKey));
  const resolveKey = createKeyResolver({
    pinned: [{ did: COMMUNITY, verificationMethods: [{ id: METHOD, publicKeyMultibase: multikey }] }],
  });
  const lists = new Map<string, unknown>();
  const fetchStatusList = jest.fn((url: string) =>
    lists.has(url) ? Promise.resolve(lists.get(url)) : Promise.reject(new Error(`no list at ${url}`)),
  );
  const publish = async (): Promise<Json> => {
    const list = (await issuer.publishRevocationList()) as Json;
    lists.set(LIST_URL, list);

    return list;
  };

  const recognize = createMembershipRecognizer({
    communities: [{ did: COMMUNITY, label: 'Example Community' }],
    resolveKey,
    fetchStatusList,
    ...config,
  });
  const sign = (document: Json, as = signer) => secureDocument(defined(document), as, { created: NOW });

  return { issuer, signer, multikey, resolveKey, lists, fetchStatusList, publish, recognize, sign };
}

/** A status list the way OpenVTC publishes one: a `validFrom` and no `validUntil` (observed 2026-11-05). */
const undatedList = (validFrom: Date, bits: Uint8Array = createBitstring()) =>
  buildStatusListCredential({ id: LIST_URL, issuer: COMMUNITY, purpose: 'revocation', bits, validFrom });

/** An unsigned membership credential, for the tests that need a shape the issuer would not produce. */
const vmc = (changes: Json = {}): Json => ({
  '@context': [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1],
  id: 'urn:uuid:11111111-2222-4333-8444-555555555555',
  type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'],
  issuer: COMMUNITY,
  issuerScope: 'public',
  validFrom: '2026-11-05T00:00:00Z',
  validUntil: '2026-12-05T00:00:00Z',
  credentialSubject: { id: MEMBER },
  credentialStatus: {
    id: `${LIST_URL}#9`,
    type: 'BitstringStatusListEntry',
    statusPurpose: 'revocation',
    statusListIndex: '9',
    statusListCredential: LIST_URL,
  },
  ...changes,
});

const entry = (purpose: string, url: string, index = 9): Json => ({
  id: `${url}#${index}`,
  type: 'BitstringStatusListEntry',
  statusPurpose: purpose,
  statusListIndex: String(index),
  statusListCredential: url,
});

describe('recognizing a membership credential', () => {
  describe('accepts', () => {
    it('a fresh credential from a recognised community whose slot is clear', async () => {
      const w = world();
      const { credential, credentialId } = await w.issuer.issueMembership(MEMBER);
      await w.publish();

      expect(await w.recognize(credential, { now: NOW })).toEqual({
        ok: true,
        community: COMMUNITY,
        label: 'Example Community',
        member: MEMBER,
        credentialId,
        expiresAt: new Date('2026-12-05T12:00:00Z'),
        subjectBound: false,
        statusChecked: true,
        personhoodHint: false,
      });
    });

    it('reports a personhood hint without treating it as anything more', async () => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER, { personhoodHint: true });
      await w.publish();

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({ ok: true, personhoodHint: true });
    });

    it('binds the credential to the presenter when the caller says who the presenter is', async () => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      await w.publish();

      expect(await w.recognize(credential, { now: NOW, expectedSubject: MEMBER })).toMatchObject({
        ok: true,
        subjectBound: true,
      });
    });

    it('a community that is itself a did:key, with no pinned configuration at all', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const did = didKeyFromPublicKey(rawPublicKey(publicKey));
      const signer = new LocalSigner(didKeyVerificationMethod(did), privateKey);
      const issuer = new CommunityIssuer({ did, signer, revocationListUrl: LIST_URL, clock: () => NOW });
      const { credential } = await issuer.issueMembership(MEMBER);
      const list = await issuer.publishRevocationList();

      const recognize = createMembershipRecognizer({
        communities: [{ did }],
        resolveKey: createKeyResolver(),
        fetchStatusList: () => Promise.resolve(list),
      });

      expect(await recognize(credential, { now: NOW })).toMatchObject({
        ok: true,
        community: did,
        label: null,
      });
    });

    it('a credential with no status entry when the config allows it, and says the status was not checked', async () => {
      const w = world({ requireStatus: false });
      const { credentialStatus: _status, ...withoutStatus } = vmc();

      const result = await w.recognize(await w.sign(withoutStatus), { now: NOW });

      expect(result).toMatchObject({ ok: true, statusChecked: false });
      expect(w.fetchStatusList).not.toHaveBeenCalled();
    });

    it('a pre-revocation list only until that list’s own validUntil, which is the bound on a replay', async () => {
      const w = world();
      const { credential, statusIndex } = await w.issuer.issueMembership(MEMBER);
      const staleList = await w.publish();
      w.issuer.revoke(statusIndex);
      await w.publish();

      // The attacker serves the list captured before the revocation.
      w.lists.set(LIST_URL, staleList);

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({ ok: true });
      expect(await w.recognize(credential, { now: new Date(NOW.getTime() + 25 * HOUR) })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
      });
    });

    it('a status list from an origin the community is configured for', async () => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      await w.publish();
      const recognize = createMembershipRecognizer({
        communities: [
          { did: COMMUNITY, statusListOrigins: ['https://other.example.net', new URL(LIST_URL).origin] },
        ],
        resolveKey: w.resolveKey,
        fetchStatusList: w.fetchStatusList,
      });

      expect(await recognize(credential, { now: NOW })).toMatchObject({ ok: true });
      expect(w.fetchStatusList).toHaveBeenCalledWith(LIST_URL);
    });

    it('a status list dated inside the clock drift, which reaches the list as well as the credential', async () => {
      const dated = (seconds: number) => undatedList(new Date(NOW.getTime() + seconds * 1000));

      const w = world();
      const credential = (await w.issuer.issueMembership(MEMBER)).credential;
      w.lists.set(LIST_URL, await w.sign(dated(60)));
      expect(await w.recognize(credential, { now: NOW })).toMatchObject({ ok: true });

      w.lists.set(LIST_URL, await w.sign(dated(61)));
      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
      });

      const strict = world({ clockSkewMs: 0 });
      const strictCredential = (await strict.issuer.issueMembership(MEMBER)).credential;
      strict.lists.set(LIST_URL, await strict.sign(dated(1)));
      expect(await strict.recognize(strictCredential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
      });
    });

    it('a lifetime exactly at the community’s cap, and not one second more', async () => {
      const w = world({ communities: [{ did: COMMUNITY, maxCredentialLifetimeMs: 10 * 24 * HOUR }] });
      await w.publish();

      const atCap = await w.sign(
        vmc({ validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-15T00:00:00Z' }),
      );
      const pastCap = await w.sign(
        vmc({ validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-15T00:00:01Z' }),
      );

      expect(await w.recognize(atCap, { now: NOW })).toMatchObject({ ok: true });
      expect(await w.recognize(pastCap, { now: NOW })).toEqual({ ok: false, reason: 'LIFETIME_TOO_LONG' });
    });

    it('the real clock when the caller names none', async () => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      await w.publish();

      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      try {
        expect(await w.recognize(credential)).toMatchObject({ ok: true });

        jest.setSystemTime(new Date(NOW.getTime() + 31 * 24 * HOUR));
        expect(await w.recognize(credential)).toMatchObject({ ok: false, reason: 'EXPIRED' });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('refuses a revoked or suspended credential', () => {
    it('after the community revokes it and republishes, and only that one', async () => {
      const w = world();
      const [revoked, kept] = [
        await w.issuer.issueMembership(MEMBER),
        await w.issuer.issueMembership(MEMBER),
      ];
      await w.publish();
      expect(await w.recognize(revoked.credential, { now: NOW })).toMatchObject({ ok: true });

      w.issuer.revoke(revoked.statusIndex);
      await w.publish();

      expect(await w.recognize(revoked.credential, { now: NOW })).toEqual({ ok: false, reason: 'REVOKED' });
      expect(await w.recognize(kept.credential, { now: NOW })).toMatchObject({ ok: true });
    });

    it('when the suspension list has its bit set, and lets it back in when the bit clears', async () => {
      const w = world();
      const credential = await w.sign(
        vmc({ credentialStatus: [entry('revocation', LIST_URL), entry('suspension', SUSPENSION_URL)] }),
      );
      await w.publish();
      const bits = createBitstring();
      const suspensionList = async () =>
        w.sign(
          buildStatusListCredential({
            id: SUSPENSION_URL,
            issuer: COMMUNITY,
            purpose: 'suspension',
            bits,
            validFrom: NOW,
            validUntil: new Date(NOW.getTime() + 24 * HOUR),
          }),
        );

      writeStatus(bits, 9, 1);
      w.lists.set(SUSPENSION_URL, await suspensionList());
      expect(await w.recognize(credential, { now: NOW })).toEqual({ ok: false, reason: 'SUSPENDED' });

      writeStatus(bits, 9, 0);
      w.lists.set(SUSPENSION_URL, await suspensionList());
      expect(await w.recognize(credential, { now: NOW })).toMatchObject({ ok: true, statusChecked: true });
    });
  });

  describe('refuses before it trusts anything in the credential', () => {
    it('one from a community that is not on the list, without fetching a status list', async () => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      const other = createMembershipRecognizer({
        communities: [{ did: 'did:webvh:other.example:abc' }],
        resolveKey: w.resolveKey,
        fetchStatusList: w.fetchStatusList,
      });

      expect(await other(credential, { now: NOW })).toEqual({ ok: false, reason: 'UNRECOGNIZED_COMMUNITY' });
      expect(w.fetchStatusList).not.toHaveBeenCalled();
    });

    it('one with a longer expiry written over a genuine signature, without fetching a status list', async () => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      await w.publish();

      const result = await w.recognize({ ...credential, validUntil: '2099-01-01T00:00:00Z' }, { now: NOW });

      expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE', detail: 'PROOF_SIGNATURE_INVALID' });
      expect(w.fetchStatusList).not.toHaveBeenCalled();
    });

    it('one a stranger signed while claiming the community’s DID and key id', async () => {
      const w = world();
      const stranger = new LocalSigner(METHOD, generateKeyPairSync('ed25519').privateKey);

      const result = await w.recognize(await w.sign(vmc(), stranger), { now: NOW });

      expect(result).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE', detail: 'PROOF_SIGNATURE_INVALID' });
      expect(w.fetchStatusList).not.toHaveBeenCalled();
    });

    it('one signed with a key the community has not pinned', async () => {
      const w = world();
      const unpinned = new LocalSigner(`${COMMUNITY}#key-1`, generateKeyPairSync('ed25519').privateKey);

      expect(await w.recognize(await w.sign(vmc(), unpinned), { now: NOW })).toMatchObject({
        ok: false,
        reason: 'BAD_SIGNATURE',
        detail: 'PROOF_KEY_UNRESOLVED',
      });
    });

    it('one with no proof at all', async () => {
      expect(await world().recognize(vmc(), { now: NOW })).toMatchObject({
        ok: false,
        reason: 'BAD_SIGNATURE',
        detail: 'PROOF_MISSING',
      });
    });

    it('a community identified by a did:keri, which this module cannot resolve', async () => {
      const sovereign = `did:keri:D${'A'.repeat(43)}`;
      const { privateKey } = generateKeyPairSync('ed25519');
      const signer = new LocalSigner(`${sovereign}#key-0`, privateKey);
      const issuer = new CommunityIssuer({
        did: sovereign,
        signer,
        revocationListUrl: LIST_URL,
        clock: () => NOW,
      });
      const { credential } = await issuer.issueMembership(MEMBER);
      const fetchStatusList = jest.fn();

      // Listing it is a configuration error, so it cannot be recognised by mistake...
      expect(() =>
        createMembershipRecognizer({
          communities: [{ did: sovereign }],
          resolveKey: createKeyResolver(),
          fetchStatusList,
        }),
      ).toThrow('did:keri is not resolved by this module');

      // ...and its credential is refused as coming from nobody on the list, before any fetch.
      const recognize = createMembershipRecognizer({
        communities: [{ did: COMMUNITY }],
        resolveKey: createKeyResolver(),
        fetchStatusList,
      });

      expect(await recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'UNRECOGNIZED_COMMUNITY',
      });
      expect(fetchStatusList).not.toHaveBeenCalled();
    });
  });

  describe('refuses a credential that is validly signed but not acceptable', () => {
    it.each([
      ['an envelope that breaks the DTG profile', { '@context': [W3C_CREDENTIALS_V2] }, 'MALFORMED'],
      [
        'a credential that is not a membership credential',
        { type: ['VerifiableCredential', 'DTGCredential', 'RelationshipCredential'] },
        'NOT_A_MEMBERSHIP_CREDENTIAL',
      ],
      [
        'a member’s acknowledgement of a membership, which names the community as its subject',
        { credentialSubject: { id: 'did:webvh:other.example.com:xyz', digestMultibase: 'uEiAbcdefghijk' } },
        'ACKNOWLEDGEMENT_NOT_A_GRANT',
      ],
      ['an issuerScope of pairwise', { issuerScope: 'pairwise' }, 'ISSUER_SCOPE_NOT_PUBLIC'],
      ['an issuerScope of directed', { issuerScope: 'directed' }, 'ISSUER_SCOPE_NOT_PUBLIC'],
      ['no validUntil', { validUntil: undefined }, 'UNBOUNDED_VALIDITY'],
      [
        'a validity period of a year',
        { validFrom: '2026-11-05T00:00:00Z', validUntil: '2027-11-05T00:00:00Z' },
        'LIFETIME_TOO_LONG',
      ],
      [
        'a validFrom beyond the allowed clock drift',
        { validFrom: '2026-11-05T12:02:00Z', validUntil: '2026-12-05T00:00:00Z' },
        'NOT_YET_VALID',
      ],
      [
        'a validUntil that has passed',
        { validFrom: '2026-10-05T12:00:00Z', validUntil: '2026-11-05T11:59:59Z' },
        'EXPIRED',
      ],
      [
        'a validUntil that is exactly now',
        { validFrom: '2026-10-05T12:00:00Z', validUntil: '2026-11-05T12:00:00Z' },
        'EXPIRED',
      ],
      ['no status entry', { credentialStatus: undefined }, 'STATUS_REQUIRED'],
      [
        'a status purpose it cannot interpret',
        { credentialStatus: { ...entry('message', LIST_URL), statusSize: 2 } },
        'STATUS_UNSUPPORTED',
      ],
      ['a refresh status purpose', { credentialStatus: entry('refresh', LIST_URL) }, 'STATUS_UNSUPPORTED'],
    ])('%s', async (_name, changes, reason) => {
      const w = world();
      await w.publish();

      const result = await w.recognize(await w.sign(vmc(changes as Json)), { now: NOW });

      expect(result).toMatchObject({ ok: false, reason });
    });

    it('allows a validFrom within the clock drift, refuses it when the drift is set to none, and allows more when widened', async () => {
      const w = world();
      await w.publish();
      const credential = await w.sign(vmc({ validFrom: '2026-11-05T12:00:30Z' }));

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({ ok: true });

      const strict = world({ clockSkewMs: 0 });
      await strict.publish();
      expect(
        await strict.recognize(await strict.sign(vmc({ validFrom: '2026-11-05T12:00:30Z' })), { now: NOW }),
      ).toEqual({
        ok: false,
        reason: 'NOT_YET_VALID',
      });

      const wide = world({ clockSkewMs: 5 * 60_000 });
      await wide.publish();
      const twoMinutesAhead = await wide.sign(vmc({ validFrom: '2026-11-05T12:02:00Z' }));
      expect(await wide.recognize(twoMinutesAhead, { now: NOW })).toMatchObject({ ok: true });
      expect(
        await w.recognize(await w.sign(vmc({ validFrom: '2026-11-05T12:02:00Z' })), { now: NOW }),
      ).toEqual({
        ok: false,
        reason: 'NOT_YET_VALID',
      });
    });

    it('accepts a longer validity period when the community is configured for it', async () => {
      const keys = world();
      await keys.publish();
      const recognize = createMembershipRecognizer({
        communities: [{ did: COMMUNITY, maxCredentialLifetimeMs: 400 * 24 * HOUR }],
        resolveKey: keys.resolveKey,
        fetchStatusList: keys.fetchStatusList,
      });

      const credential = await keys.sign(vmc({ validUntil: '2027-11-05T00:00:00Z' }));

      expect(await recognize(credential, { now: NOW })).toMatchObject({ ok: true });
    });

    it('a credential shown by someone other than the member it names', async () => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      await w.publish();

      expect(await w.recognize(credential, { now: NOW, expectedSubject: 'did:key:z6MkOther' })).toEqual({
        ok: false,
        reason: 'SUBJECT_MISMATCH',
      });
    });

    it.each([
      ['an empty string', ''],
      ['null', null],
    ])('a credential shown by someone who says they are %s', async (_name, expectedSubject) => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      await w.publish();

      expect(await w.recognize(credential, { now: NOW, expectedSubject: expectedSubject as string })).toEqual(
        {
          ok: false,
          reason: 'SUBJECT_MISMATCH',
        },
      );
    });

    it.each([undefined, null, 'credential', 42, []])('the non-object %p', async (presented) => {
      expect(await world().recognize(presented, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'MALFORMED',
      });
    });
  });

  describe('refuses when the status list cannot be trusted', () => {
    const credentialFor = async (w: ReturnType<typeof world>) =>
      (await w.issuer.issueMembership(MEMBER)).credential;

    it('is unreachable', async () => {
      const w = world();
      const credential = await credentialFor(w);

      expect(await w.recognize(credential, { now: NOW })).toEqual({
        ok: false,
        reason: 'STATUS_UNAVAILABLE',
      });
    });

    it('is not a list at all', async () => {
      const w = world();
      const credential = await credentialFor(w);
      w.lists.set(LIST_URL, 'not a credential');

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
      });
    });

    it('is unsigned', async () => {
      const w = world();
      const credential = await credentialFor(w);
      const { proof: _proof, ...unsigned } = await w.publish();
      w.lists.set(LIST_URL, unsigned);

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
        detail: 'PROOF_MISSING',
      });
    });

    it('is signed by someone other than the community', async () => {
      const w = world();
      const credential = await credentialFor(w);
      const stranger = new LocalSigner(METHOD, generateKeyPairSync('ed25519').privateKey);
      w.lists.set(
        LIST_URL,
        await w.sign(
          buildStatusListCredential({
            id: LIST_URL,
            issuer: COMMUNITY,
            purpose: 'revocation',
            bits: createBitstring(),
            validFrom: NOW,
            validUntil: new Date(NOW.getTime() + 24 * HOUR),
          }),
          stranger,
        ),
      );

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
        detail: 'PROOF_SIGNATURE_INVALID',
      });
    });

    it('names a different issuer than the credential does, whatever its signature says', async () => {
      const w = world();
      const credential = await credentialFor(w);
      const list = await w.publish();

      w.lists.set(LIST_URL, { ...list, issuer: 'did:webvh:other.example:abc' });

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
        detail: expect.stringContaining('not issued by'),
      });
    });

    it('is genuinely signed by another community the box also recognises', async () => {
      const other = 'did:webvh:other.example.com:xyz';
      const otherKeys = generateKeyPairSync('ed25519');
      const otherSigner = new LocalSigner(`${other}#key-0`, otherKeys.privateKey);
      const w = world();
      const recognize = createMembershipRecognizer({
        communities: [{ did: COMMUNITY }, { did: other }],
        resolveKey: createKeyResolver({
          pinned: [
            { did: COMMUNITY, verificationMethods: [{ id: METHOD, publicKeyMultibase: w.multikey }] },
            {
              did: other,
              verificationMethods: [
                {
                  id: `${other}#key-0`,
                  publicKeyMultibase: multikeyFromPublicKey(rawPublicKey(otherKeys.publicKey)),
                },
              ],
            },
          ],
        }),
        fetchStatusList: w.fetchStatusList,
      });
      const credential = await credentialFor(w);

      // The other community, whose key is trusted for it, signs a clean list at the URL this
      // community's credential names. Everything about the list is valid except whose it is.
      w.lists.set(
        LIST_URL,
        await secureDocument(
          buildStatusListCredential({
            id: LIST_URL,
            issuer: other,
            purpose: 'revocation',
            bits: createBitstring(),
            validFrom: NOW,
            validUntil: new Date(NOW.getTime() + 24 * HOUR),
          }),
          otherSigner,
          { created: NOW },
        ),
      );

      expect(await recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
        detail: expect.stringContaining('not issued by'),
      });

      // Control: the same list, signed by the credential's own community, is accepted.
      await w.publish();
      expect(await recognize(credential, { now: NOW })).toMatchObject({ ok: true });
    });

    describe('is too old', () => {
      const DAY = 24 * HOUR;

      it('and a copy saved before a revocation is refused once it ages past the limit', async () => {
        const w = world();
        const { credential, statusIndex } = await w.issuer.issueMembership(MEMBER);
        const savedBeforeRevocation = await w.sign(undatedList(NOW));
        const later = new Date(NOW.getTime() + 2 * DAY);

        w.issuer.revoke(statusIndex);
        w.lists.set(LIST_URL, await w.sign(undatedList(later, w.issuer.revocation.bits())));
        expect(await w.recognize(credential, { now: later })).toEqual({ ok: false, reason: 'REVOKED' });

        // The saved copy has no validUntil, so only its age stands between it and acceptance.
        w.lists.set(LIST_URL, savedBeforeRevocation);
        expect(await w.recognize(credential, { now: later })).toEqual({
          ok: false,
          reason: 'STATUS_LIST_INVALID',
          detail: 'STATUS_VERIFICATION_ERROR',
        });
      });

      it('at 24 hours by default: accepted up to the limit, refused a millisecond past it', async () => {
        const w = world();
        const { credential } = await w.issuer.issueMembership(MEMBER);
        w.lists.set(LIST_URL, await w.sign(undatedList(NOW)));

        expect(await w.recognize(credential, { now: new Date(NOW.getTime() + DAY) })).toMatchObject({
          ok: true,
        });
        expect(await w.recognize(credential, { now: new Date(NOW.getTime() + DAY + 1) })).toMatchObject({
          ok: false,
          reason: 'STATUS_LIST_INVALID',
        });
      });

      it('at the limit the box sets', async () => {
        const w = world({ statusListMaxAgeMs: 2 * HOUR });
        const { credential } = await w.issuer.issueMembership(MEMBER);
        w.lists.set(LIST_URL, await w.sign(undatedList(NOW)));

        expect(await w.recognize(credential, { now: new Date(NOW.getTime() + 2 * HOUR) })).toMatchObject({
          ok: true,
        });
        expect(await w.recognize(credential, { now: new Date(NOW.getTime() + 2 * HOUR + 1) })).toMatchObject({
          ok: false,
          reason: 'STATUS_LIST_INVALID',
        });
      });

      it('even though its validUntil is still ahead', async () => {
        const w = world();
        const { credential } = await w.issuer.issueMembership(MEMBER);
        w.lists.set(
          LIST_URL,
          await w.sign(
            buildStatusListCredential({
              id: LIST_URL,
              issuer: COMMUNITY,
              purpose: 'revocation',
              bits: createBitstring(),
              validFrom: NOW,
              validUntil: new Date(NOW.getTime() + 7 * DAY),
            }),
          ),
        );

        expect(await w.recognize(credential, { now: new Date(NOW.getTime() + 2 * DAY) })).toMatchObject({
          ok: false,
          reason: 'STATUS_LIST_INVALID',
        });
      });

      it('because it states no validFrom, so its age cannot be known', async () => {
        const w = world();
        const { credential } = await w.issuer.issueMembership(MEMBER);
        const { validFrom: _omitted, ...withoutValidFrom } = undatedList(NOW);
        w.lists.set(LIST_URL, await w.sign(withoutValidFrom));

        expect(await w.recognize(credential, { now: NOW })).toMatchObject({
          ok: false,
          reason: 'STATUS_LIST_INVALID',
          detail: 'STATUS_VERIFICATION_ERROR',
        });
      });
    });

    it('has had a revoked slot cleared by hand, which breaks its signature', async () => {
      const w = world();
      const { credential, statusIndex } = await w.issuer.issueMembership(MEMBER);
      w.issuer.revoke(statusIndex);
      const list = await w.publish();
      const subject = list.credentialSubject as Json;
      const bits = expandBitstring(subject.encodedList);
      writeStatus(bits, statusIndex, 0);

      w.lists.set(LIST_URL, {
        ...list,
        credentialSubject: { ...subject, encodedList: encodeBitstring(bits) },
      });

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
        detail: 'PROOF_SIGNATURE_INVALID',
      });
    });

    it('is shorter than the 131,072-entry floor', async () => {
      const w = world();
      const credential = await credentialFor(w);
      w.lists.set(
        LIST_URL,
        await w.sign(
          buildStatusListCredential({
            id: LIST_URL,
            issuer: COMMUNITY,
            purpose: 'revocation',
            bits: new Uint8Array(8192),
            validFrom: NOW,
            validUntil: new Date(NOW.getTime() + 24 * HOUR),
          }),
        ),
      );

      expect(await w.recognize(credential, { now: NOW })).toEqual({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
        detail: 'STATUS_LIST_LENGTH_ERROR',
      });
    });

    it('has no slot for the credential', async () => {
      const w = world();
      await w.publish();
      const credential = await w.sign(vmc({ credentialStatus: entry('revocation', LIST_URL, 999_999) }));

      expect(await w.recognize(credential, { now: NOW })).toEqual({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
        detail: 'RANGE_ERROR',
      });
    });

    it('answers for a different purpose', async () => {
      const w = world();
      const credential = await credentialFor(w);
      w.lists.set(
        LIST_URL,
        await w.sign(
          buildStatusListCredential({
            id: LIST_URL,
            issuer: COMMUNITY,
            purpose: 'suspension',
            bits: createBitstring(),
            validFrom: NOW,
            validUntil: new Date(NOW.getTime() + 24 * HOUR),
          }),
        ),
      );

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
      });
    });

    it('has no validUntil, when the box requires one', async () => {
      const w = world({ requireStatusListExpiry: true });
      const credential = await credentialFor(w);
      w.lists.set(
        LIST_URL,
        await w.sign(
          buildStatusListCredential({
            id: LIST_URL,
            issuer: COMMUNITY,
            purpose: 'revocation',
            bits: createBitstring(),
            validFrom: NOW,
          }),
        ),
      );

      expect(await w.recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
      });

      const lenient = world();
      const lenientCredential = await credentialFor(lenient);
      lenient.lists.set(
        LIST_URL,
        await lenient.sign(
          buildStatusListCredential({
            id: LIST_URL,
            issuer: COMMUNITY,
            purpose: 'revocation',
            bits: createBitstring(),
            validFrom: NOW,
          }),
        ),
      );
      expect(await lenient.recognize(lenientCredential, { now: NOW })).toMatchObject({ ok: true });
    });

    it('is served from an origin the community is not configured for, without fetching it', async () => {
      const w = world();
      const credential = await credentialFor(w);
      await w.publish();
      const recognize = createMembershipRecognizer({
        communities: [{ did: COMMUNITY, statusListOrigins: ['https://lists.example.net'] }],
        resolveKey: w.resolveKey,
        fetchStatusList: w.fetchStatusList,
      });

      expect(await recognize(credential, { now: NOW })).toMatchObject({
        ok: false,
        reason: 'STATUS_LIST_INVALID',
      });
      expect(w.fetchStatusList).not.toHaveBeenCalled();
    });
  });

  it('turns an unexpected failure into a refusal instead of throwing', async () => {
    const throwing: KeyResolver = () => {
      throw new Error('custody exploded');
    };

    const w = world({ resolveKey: throwing });
    const { credential } = await w.issuer.issueMembership(MEMBER);

    expect(await w.recognize(credential, { now: NOW })).toEqual({
      ok: false,
      reason: 'VERIFIER_ERROR',
      detail: 'custody exploded',
    });
  });

  describe('does not let a clock or an allowance that is not a number pass a time check', () => {
    it.each([
      ['an invalid Date', new Date(Number.NaN)],
      ['a number in place of a Date', 1_762_344_000_000],
      ['a string in place of a Date', '2026-11-05T12:00:00Z'],
    ])('refuses to decide with %s as the clock, before fetching anything', async (_name, now) => {
      const w = world();
      const { credential } = await w.issuer.issueMembership(MEMBER);
      await w.publish();

      expect(await w.recognize(credential, { now: now as Date })).toEqual({
        ok: false,
        reason: 'VERIFIER_ERROR',
        detail: 'context.now is not a valid time',
      });
      expect(w.fetchStatusList).not.toHaveBeenCalled();
    });

    it('does not accept an expired credential just because the clock is invalid', async () => {
      const w = world();
      const expired = await w.sign(
        vmc({ validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z' }),
      );
      await w.publish();

      expect(await w.recognize(expired, { now: NOW })).toEqual({ ok: false, reason: 'EXPIRED' });
      expect(await w.recognize(expired, { now: new Date(Number.NaN) })).toMatchObject({ ok: false });
    });
  });

  describe('rejects a bad configuration when it is built', () => {
    const base = { resolveKey: createKeyResolver(), fetchStatusList: () => Promise.resolve({}) };
    const community = { did: COMMUNITY };
    const notPositive = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1];
    type BadConfig = Pick<RecognizerConfig, 'communities'> & Partial<RecognizerConfig>;
    const table: Array<[string, BadConfig]> = [
      ['a community that is not a DID', { communities: [{ did: 'community.example.com' }] }],
      ['the same community twice', { communities: [{ did: COMMUNITY }, { did: COMMUNITY }] }],
      ['a did:keri community', { communities: [{ did: `did:keri:D${'A'.repeat(43)}` }] }],
      [
        'an http status list origin',
        { communities: [{ did: COMMUNITY, statusListOrigins: ['http://community.example.com'] }] },
      ],
      [
        'an origin with a path',
        { communities: [{ did: COMMUNITY, statusListOrigins: ['https://community.example.com/lists'] }] },
      ],
      ...notPositive.map((value): [string, BadConfig] => [
        `a community lifetime cap of ${value}`,
        { communities: [{ did: COMMUNITY, maxCredentialLifetimeMs: value }] },
      ]),
      ...[Number.NaN, Number.POSITIVE_INFINITY, -1].map((value): [string, BadConfig] => [
        `a clock allowance of ${value}`,
        { communities: [community], clockSkewMs: value },
      ]),
      ...notPositive.map((value): [string, BadConfig] => [
        `a status list age limit of ${value}`,
        { communities: [community], statusListMaxAgeMs: value },
      ]),
    ];

    it.each(table)('%s', (_name, config) => {
      expect(() => createMembershipRecognizer({ ...base, ...config })).toThrow();
    });

    it('accepts a zero clock allowance, which means no drift is tolerated', () => {
      expect(() =>
        createMembershipRecognizer({ ...base, communities: [community], clockSkewMs: 0 }),
      ).not.toThrow();
    });
  });
});
