import { generateKeyPairSync } from 'node:crypto';

import { BadRequestException, ConflictException } from '@nestjs/common';
import { FindOperator, IsNull } from 'typeorm';

import { base58btcEncode, didKeyIdFor } from '../didKeyId';
import { sovereignKeyIdFor } from '../sovereignKeyId';

import { PeerLinkService } from './PeerLinkService';

type Row = Record<string, unknown>;

const OWNER = 'owner-1';
const CTX = { userId: OWNER };
const DTO = { peerHandle: 'alice@alice.example', memoryEndpoint: 'https://memory.alice.example/agent/v1' };

const newKey = () =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
const didFor = (jwk: Record<string, unknown>) => didKeyIdFor(jwk) as string;
const keriFor = (jwk: Record<string, unknown>) => sovereignKeyIdFor(jwk) as string;

function row(overrides: Row = {}): Row {
  return {
    id: 'link-1',
    ownerUserId: OWNER,
    peerHandle: DTO.peerHandle,
    displayName: null,
    memoryEndpoint: DTO.memoryEndpoint,
    peerIssuer: null,
    peerSubject: null,
    personEntityId: null,
    trustTier: 'stranger',
    status: 'active',
    revokedAt: null,
    ...overrides,
  };
}

/**
 * `current` is what a lookup by handle finds (the link being edited); `live` is the owner's rows the twin
 * lookup can find. `find` answers by the shape of the question; `findOne` answers the way the database
 * would: the owner's row with exactly that issuer and subject, and live when the query says `IsNull()`.
 */
function makeService(opts: { current?: Row[]; live?: Row[] } = {}) {
  const repository = {
    find: jest.fn(async ({ where }: { where: Row }) =>
      where.peerHandle !== undefined ? (opts.current ?? []) : (opts.live ?? []),
    ),
    findOne: jest.fn(
      async ({ where }: { where: Row }) =>
        (opts.live ?? []).find(
          (candidate) =>
            candidate.ownerUserId === where.ownerUserId &&
            candidate.peerIssuer === where.peerIssuer &&
            candidate.peerSubject === where.peerSubject &&
            (where.revokedAt === undefined || candidate.revokedAt == null),
        ) ?? null,
    ),
    create: jest.fn().mockImplementation((value: unknown) => value),
    save: jest.fn().mockImplementation((value: unknown) => Promise.resolve({ ...(value as object) })),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };
  const grantService = { revokeForPeerLink: jest.fn().mockResolvedValue(0) };
  const service = new PeerLinkService(repository as never, logger as never, grantService as never);

  return { service, repository };
}

describe('PeerLinkService.upsert — a did:key identity', () => {
  it('writes a canonical Ed25519 did:key under the did:key issuer', async () => {
    const { service, repository } = makeService();
    const did = didFor(newKey());

    await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: did });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ peerIssuer: 'did:key', peerSubject: did }),
    );
  });

  it.each([
    ['a free-text subject', 'alice'],
    ['a did:keri subject', 'did:keri:D6Zwb8HfPqmyZXwMt1k0fKQPwoSTmN2GqmXdB2eyd1Mq'],
    ['a did:web subject', 'did:web:local.pub'],
    ['a DID URL', `${didFor(newKey())}#frag`],
    ['an X25519 did:key', 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'],
    ['an empty subject', ''],
  ])('refuses %s, in front of the insert: it could never match an inbound ask', async (_name, subject) => {
    const { service, repository } = makeService();

    await expect(
      service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: subject }),
    ).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });

  // A did:key can be well formed (the right shape, a canonical string) and still not a key: these are built
  // by hand so that only the link guard is under test, and a shape check would let both through.
  const spell = (key: Uint8Array) => `did:key:z${base58btcEncode(Uint8Array.of(0xed, 0x01, ...key))}`;
  const point = (y: number) => Uint8Array.from([y, ...Array.from({ length: 31 }, () => 0)]);

  it.each([
    ['is not a point on the curve (y = 2)', spell(point(2))],
    ['is the identity point (a weak key)', spell(point(1))],
  ])('refuses a well-formed did:key that %s, with a bad request', async (_name, subject) => {
    const { service, repository } = makeService();

    await expect(
      service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: subject }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('accepts the point next to those (y = 3), so the refusals above are the curve and the weak-key rules', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: spell(point(3)) });

    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it.each(['DID:KEY', 'did:key:', 'did:keri', 'did:web'])(
    'refuses a valid did:key bound under the issuer %j, which nothing would ever answer',
    async (issuer) => {
      const { service, repository } = makeService();

      await expect(
        service.upsert(CTX as never, { ...DTO, peerIssuer: issuer, peerSubject: didFor(newKey()) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    },
  );

  it('refuses a did:keri:D<x> subject bound under the did:key issuer or an unrelated DID issuer', async () => {
    const { service, repository } = makeService();
    const aid = keriFor(newKey());

    for (const issuer of ['did:key', 'did:web']) {
      await expect(
        service.upsert(CTX as never, { ...DTO, peerIssuer: issuer, peerSubject: aid }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('leaves a Portal identity alone even when its subject looks like a did:key', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, {
      ...DTO,
      peerIssuer: 'https://portal.example',
      peerSubject: didFor(newKey()),
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('refuses an issuer of did:key given with no subject at all', async () => {
    const { service, repository } = makeService();

    await expect(service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key' })).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('leaves every other issuer alone', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, {
      ...DTO,
      peerIssuer: 'https://portal.example',
      peerSubject: 'not-a-did',
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
    // No self-certifying identity, so no search for another spelling of its key.
    expect(repository.find).toHaveBeenCalledTimes(1);
  });
});

describe('PeerLinkService.upsert — the did:key rule applies to the merged row, not only to the input', () => {
  const did = didFor(newKey());
  const existing = () => row({ peerIssuer: 'did:key', peerSubject: did });

  it.each([
    ['free text', 'alice'],
    ['a did:keri', 'did:keri:D6Zwb8HfPqmyZXwMt1k0fKQPwoSTmN2GqmXdB2eyd1Mq'],
    ['a DID URL', `${did}#frag`],
    ['an X25519 did:key', 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'],
  ])('refuses rewriting only the subject of a did:key link to %s', async (_name, subject) => {
    const { service, repository } = makeService({ current: [existing()] });

    await expect(service.upsert(CTX as never, { ...DTO, peerSubject: subject })).rejects.toThrow(
      /canonical Ed25519 did:key/,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('refuses turning a Portal link into a did:key link without a did:key subject', async () => {
    const portal = row({ peerIssuer: 'https://portal.example', peerSubject: 'portal-sub-1' });
    const { service, repository } = makeService({ current: [portal] });

    await expect(service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key' })).rejects.toThrow(
      /canonical Ed25519 did:key/,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('allows re-pointing a did:key link at another canonical did:key', async () => {
    const next = didFor(newKey());
    const { service, repository } = makeService({ current: [existing()] });

    await service.upsert(CTX as never, { ...DTO, peerSubject: next });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ peerIssuer: 'did:key', peerSubject: next }),
    );
  });

  describe('a legacy row whose identity was written by hand', () => {
    const legacy = () => row({ peerIssuer: 'did:key', peerSubject: 'written-by-hand' });

    // `PeerLinkResolver.updatePeerLink` sends the stored pair back with every edit, so this is the
    // call shape a real edit has. Keyed on "an identity was supplied" the guard refused it.
    it('does not stop a tier or name edit that sends the stored pair back unchanged', async () => {
      const { service, repository } = makeService({ current: [legacy()] });

      await service.upsert(CTX as never, {
        ...DTO,
        peerIssuer: 'did:key',
        peerSubject: 'written-by-hand',
        displayName: 'Alice',
        trustTier: 'trusted',
      });

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: 'Alice',
          trustTier: 'trusted',
          peerSubject: 'written-by-hand',
        }),
      );
    });

    it('does not stop an edit that sends no identity at all', async () => {
      const { service, repository } = makeService({ current: [legacy()] });

      await service.upsert(CTX as never, { ...DTO, displayName: 'Alice' });

      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Alice' }));
    });

    it('still refuses a write that CHANGES the binding to something that is not a did:key', async () => {
      const { service, repository } = makeService({ current: [legacy()] });

      await expect(
        service.upsert(CTX as never, {
          ...DTO,
          peerIssuer: 'did:key',
          peerSubject: 'written-by-another-hand',
        }),
      ).rejects.toThrow(/canonical Ed25519 did:key/);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });
});

describe('PeerLinkService.upsert — one key, one live link, across its spellings', () => {
  const jwk = newKey();
  const live = (overrides: Row) => row({ id: 'link-other', peerHandle: 'other@alice.example', ...overrides });
  const keriTwin = (overrides: Row = {}) =>
    live({ peerIssuer: 'did:keri', peerSubject: keriFor(jwk), ...overrides });
  const keyTwin = (overrides: Row = {}) =>
    live({ peerIssuer: 'did:key', peerSubject: didFor(jwk), ...overrides });

  it('refuses a did:key link for a key the owner already holds live as did:keri:D<x>, with a conflict', async () => {
    const { service, repository } = makeService({ live: [keriTwin({ trustTier: 'family' })] });

    const attempt = service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(/already names that key under a different spelling/);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('refuses a did:keri:D<x> link for a key the owner already holds live as a did:key, with a conflict', async () => {
    const { service, repository } = makeService({ live: [keyTwin()] });

    const attempt = service.upsert(CTX as never, {
      ...DTO,
      peerIssuer: 'did:keri',
      peerSubject: keriFor(jwk),
    });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(/already names that key under a different spelling/);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('asks the database ONE question: the owner, the twin issuer, the twin subject, and live', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) });

    expect(repository.findOne).toHaveBeenCalledTimes(1);
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { ownerUserId: OWNER, peerIssuer: 'did:keri', peerSubject: keriFor(jwk), revokedAt: IsNull() },
    });

    repository.findOne.mockClear();
    await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:keri', peerSubject: keriFor(jwk) });

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { ownerUserId: OWNER, peerIssuer: 'did:key', peerSubject: didFor(jwk), revokedAt: IsNull() },
    });
  });

  describe('only a write that changes the binding is checked', () => {
    // Two links already name one key (written one after the other before the check existed, or by two
    // writes racing). The owner has to be able to lower either one, and the resolver sends the stored
    // pair back with every edit.
    const mine = () =>
      row({ id: 'link-1', peerIssuer: 'did:key', peerSubject: didFor(jwk), trustTier: 'family' });

    it('lets the tier of either link be lowered, with the stored pair sent back unchanged', async () => {
      const { service, repository } = makeService({
        current: [mine()],
        live: [mine(), keriTwin({ trustTier: 'family' })],
      });

      await service.upsert(CTX as never, {
        ...DTO,
        peerIssuer: 'did:key',
        peerSubject: didFor(jwk),
        trustTier: 'stranger',
      });

      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ trustTier: 'stranger' }));
      // Nothing changed hands, so nothing was searched for.
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('still refuses moving a link onto the spelling the twin holds', async () => {
      const bound = row({ id: 'link-1', peerIssuer: 'https://portal.example', peerSubject: 'portal-sub-1' });
      const { service, repository } = makeService({ current: [bound], live: [bound, keriTwin()] });

      await expect(
        service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) }),
      ).rejects.toThrow(/already names that key under a different spelling/);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('an ended link', () => {
    const ended = (overrides: Row = {}) =>
      row({ id: 'link-1', revokedAt: new Date('2026-10-01T00:00:00Z'), status: 'revoked', ...overrides });

    it('is not refused for a live twin when it is edited: it answers nothing', async () => {
      const { service, repository } = makeService({ current: [ended()], live: [keriTwin()] });

      await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) });

      expect(repository.findOne).not.toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('is a NEW link when it is added back, so the did:key rule applies to it', async () => {
      const { service, repository } = makeService({ current: [ended()] });

      await expect(
        service.upsert(CTX as never, {
          ...DTO,
          status: 'active',
          peerIssuer: 'did:key',
          peerSubject: 'alice',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('is a NEW link when it is added back, so a live twin refuses it', async () => {
      const { service, repository } = makeService({ current: [ended()], live: [keriTwin()] });

      await expect(
        service.upsert(CTX as never, {
          ...DTO,
          status: 'active',
          peerIssuer: 'did:key',
          peerSubject: didFor(jwk),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  it('does not take a link that names the SAME did:key for a different spelling: the database decides that one', async () => {
    const { service, repository } = makeService({ live: [keyTwin()] });
    repository.save.mockRejectedValueOnce({
      code: '23505',
      constraint: 'peer_links_owner_identity_live_uniq',
    });

    const attempt = service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(/already claims that \(peerIssuer, peerSubject\)/);
    await expect(attempt).rejects.not.toThrow(/different spelling/);
  });

  it('allows a different key under the twin issuer, and a twin that has been ended', async () => {
    const { service, repository } = makeService({
      live: [
        live({ peerIssuer: 'did:keri', peerSubject: keriFor(newKey()) }),
        keriTwin({ id: 'link-ended', revokedAt: new Date('2026-10-01T00:00:00Z') }),
      ],
    });

    await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) });

    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('is not blocked by a row that cannot answer: a did:keri issuer holding a did:key subject', async () => {
    const { service, repository } = makeService({
      live: [live({ peerIssuer: 'did:keri', peerSubject: didFor(jwk) })],
    });

    await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) });

    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('lets a link be re-bound to another spelling of its OWN key', async () => {
    const own = row({ id: 'link-1', peerIssuer: 'did:keri', peerSubject: keriFor(jwk) });
    const { service, repository } = makeService({ current: [own], live: [own] });

    await service.upsert(CTX as never, { ...DTO, peerIssuer: 'did:key', peerSubject: didFor(jwk) });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'link-1', peerIssuer: 'did:key', peerSubject: didFor(jwk) }),
    );
  });

  it('asks nothing for a Portal identity, whatever its subject looks like', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, {
      ...DTO,
      peerIssuer: 'https://portal.example',
      peerSubject: didFor(jwk),
    });

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('asks nothing for a key it cannot spell both ways (a well-formed did:key that is not a point is refused first)', async () => {
    const { service, repository } = makeService();

    await expect(
      service.upsert(CTX as never, {
        ...DTO,
        peerIssuer: 'did:key',
        peerSubject: `did:key:z${base58btcEncode(Uint8Array.of(0xed, 0x01, 2, ...Array.from({ length: 31 }, () => 0)))}`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.findOne).not.toHaveBeenCalled();
  });
});

describe('PeerLinkService.findActiveByKeyThumbprint — a did:key keyid', () => {
  const clauses = (repository: { find: jest.Mock }) =>
    (repository.find.mock.calls[0][0] as { where: Array<Record<string, unknown>> }).where;

  it('also finds the link that names the did:key, whether or not it records the key', async () => {
    const { service, repository } = makeService();
    const did = didFor(newKey());

    await service.findActiveByKeyThumbprint(did);

    const where = clauses(repository);
    expect(where).toHaveLength(2);
    expect(where[0]).toMatchObject({ peerKeyThumbprint: did, status: 'active' });
    expect(where[1]).toMatchObject({ peerIssuer: 'did:key', peerSubject: did, status: 'active' });
    expect(where[1].revokedAt).toBeInstanceOf(FindOperator);
  });

  it('looks under did:keri for a sovereign AID, exactly as before', async () => {
    const { service, repository } = makeService();
    const aid = keriFor(newKey());

    await service.findActiveByKeyThumbprint(aid);

    expect(clauses(repository)[1]).toMatchObject({ peerIssuer: 'did:keri', peerSubject: aid });
  });

  it('adds no identity clause for a thumbprint or for a DID it does not understand', async () => {
    for (const keyid of [
      'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
      'did:web:local.pub',
      `${didFor(newKey())}#frag`,
    ]) {
      const { service, repository } = makeService();

      await service.findActiveByKeyThumbprint(keyid);

      expect(clauses(repository)).toHaveLength(1);
    }
  });
});
