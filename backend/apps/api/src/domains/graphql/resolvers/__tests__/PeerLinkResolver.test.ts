import { NotFoundException } from '@nestjs/common';

import type { Person } from '@ci/domains/memory';
import type { PeerLink } from '@ci/domains/peers';

import { GlobalUID } from '../../types/GlobalUID';
import { PeerLinkType, PeerTrustTierEnum } from '../../types/PeerLinkType';
import { PeerLinkResolver } from '../PeerLinkResolver';

/**
 * The peer-link management surface.
 *
 * A peer link is the trust anchor for every federated disclosure: its
 * `trustTier` is the ceiling on everything that peer can ever be told. So the
 * two properties worth pinning are (a) an owner can only ever see and change
 * THEIR OWN links, and (b) adding somebody defaults to the NARROWEST tier
 * rather than the service-layer default.
 *
 * Both are asserted against the resolver's real code path with a stubbed
 * service — the service's own owner scoping has its own DB-backed tests, and
 * what is unproven here is the resolver's use of it.
 */

const OWNER = 'owner-1';

function makeLink(overrides: Partial<PeerLink> = {}): PeerLink {
  return {
    id: '01a0-link',
    ownerUserId: OWNER,
    peerHandle: 'ada',
    displayName: 'Ada',
    memoryEndpoint: 'https://ada.example/agent',
    peerIssuer: 'https://portal.example',
    peerSubject: 'sub-ada',
    personEntityId: null,
    trustTier: 'peer',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    revokedAt: null,
    ...overrides,
  } as PeerLink;
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-ada',
    name: 'Ada',
    properties: {},
    ...overrides,
  } as unknown as Person;
}

function build(overrides: Record<string, unknown> = {}, personOverrides: Record<string, unknown> = {}) {
  const service = {
    findAll: jest.fn().mockResolvedValue([makeLink()]),
    findById: jest.fn().mockResolvedValue(makeLink()),
    upsert: jest.fn().mockImplementation((_ctx, dto) => Promise.resolve(makeLink({ ...dto }))),
    revoke: jest.fn().mockResolvedValue(makeLink({ status: 'revoked', revokedAt: new Date() })),
    ...overrides,
  };

  // Unrelated to `PeerLinkService` above — `avatarUrl` reads through
  // `PersonService.findById` instead. Defaults to "nothing found", same as a
  // real owner-scoped miss.
  const personService = {
    findById: jest.fn().mockResolvedValue(null),
    ...personOverrides,
  };

  const resolver = new PeerLinkResolver(service as never, personService as never);
  const context = { userId: OWNER } as never;

  return { resolver, service, personService, context };
}

describe('PeerLinkResolver', () => {
  describe('scoping', () => {
    it('SECURITY: reads links through the owner-scoped finder, never unscoped', async () => {
      const { resolver, service, context } = build();

      await resolver.myPeerLinks(context);

      expect(service.findAll).toHaveBeenCalledTimes(1);
      // The service context — not a raw id and not `undefined` — is what carries
      // the owner. Passing anything else here is how a scoped query becomes a
      // global one.
      expect(service.findAll.mock.calls[0][0]).toMatchObject({ userId: OWNER });
    });

    it('SECURITY: refuses to update a link the owner cannot read, without writing', async () => {
      // `upsert` keys on (ownerUserId, peerHandle), so calling it for a link the
      // caller does not own would silently CREATE one rather than touch theirs.
      // The explicit read is what turns that into an honest refusal.
      const { resolver, service, context } = build({
        findById: jest.fn().mockResolvedValue(null),
      });

      await expect(
        resolver.updatePeerLink(context, {
          id: GlobalUID.encode('peer-link', 'someone-elses'),
          trustTier: PeerTrustTierEnum.family,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(service.upsert).not.toHaveBeenCalled();
    });

    it('SECURITY: refuses to revoke a link the owner cannot read, without writing', async () => {
      const { resolver, service, context } = build({
        findById: jest.fn().mockResolvedValue(null),
      });

      await expect(
        resolver.revokePeerLink(context, GlobalUID.encode('peer-link', 'someone-elses')),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(service.revoke).not.toHaveBeenCalled();
    });
  });

  describe('trust tier', () => {
    it('SECURITY: defaults a new link to `stranger`, the narrowest tier', async () => {
      // The service falls back to `peer`, which is two rungs more permissive.
      // Adding someone is not the same gesture as trusting them.
      const { resolver, service, context } = build();

      await resolver.createPeerLink(context, {
        peerHandle: 'ada',
        memoryEndpoint: 'https://ada.example/agent',
      });

      expect(service.upsert.mock.calls[0][1]).toMatchObject({ trustTier: 'stranger' });
    });

    it('honours an explicitly chosen tier', async () => {
      const { resolver, service, context } = build();

      await resolver.createPeerLink(context, {
        peerHandle: 'ada',
        memoryEndpoint: 'https://ada.example/agent',
        trustTier: PeerTrustTierEnum.family,
      });

      expect(service.upsert.mock.calls[0][1]).toMatchObject({ trustTier: 'family' });
    });

    it('preserves the existing tier when an update does not mention it', async () => {
      const { resolver, service, context } = build({
        findById: jest.fn().mockResolvedValue(makeLink({ trustTier: 'trusted' })),
      });

      await resolver.updatePeerLink(context, {
        id: GlobalUID.encode('peer-link', '01a0-link'),
        displayName: 'Ada L.',
      });

      // A rename must never silently re-tier the peer.
      expect(service.upsert.mock.calls[0][1]).toMatchObject({ trustTier: 'trusted' });
    });
  });

  describe('projection', () => {
    it('SECURITY: never puts the (iss, sub) binding on the wire', async () => {
      // That pair is what an inbound token is matched against — the thing that
      // stops one box impersonating another. It is infrastructure, not something
      // the owner acts on.
      const { resolver, context } = build();

      const [link] = await resolver.myPeerLinks(context);

      expect(link).not.toHaveProperty('peerIssuer');
      expect(link).not.toHaveProperty('peerSubject');
      expect(JSON.stringify(link)).not.toContain('sub-ada');
    });

    it('returns revoked links rather than hiding them', async () => {
      // A revocation the owner cannot see is one they cannot verify happened.
      const revoked = makeLink({ status: 'revoked', revokedAt: new Date('2026-02-01T00:00:00Z') });
      const { resolver, context } = build({
        findAll: jest.fn().mockResolvedValue([revoked]),
      });

      const [link] = await resolver.myPeerLinks(context);

      expect(link.status).toBe('revoked');
      expect(link.revokedAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    });

    it('encodes ids as global ids, not raw uuids', async () => {
      const { resolver, context } = build();

      const [link] = await resolver.myPeerLinks(context);

      expect(link.id).toBe(GlobalUID.encode('peer-link', '01a0-link'));
      expect(link.id).not.toBe('01a0-link');
    });
  });

  /**
   * `avatarUrl` — the avatar of the Person in the OWNER's own memory this peer
   * is linked to, not anything the peer claims about themselves.
   */
  describe('avatarUrl', () => {
    it("returns the linked Person's avatarUrl when personEntityId is set", async () => {
      const link = PeerLinkType.toType(makeLink({ personEntityId: 'person-ada' }));
      const { resolver, personService, context } = build(
        {},
        {
          findById: jest
            .fn()
            .mockResolvedValue(makePerson({ properties: { avatar_url: 'https://x/ada.png' } })),
        },
      );

      const result = await resolver.avatarUrl(context, link);

      expect(result).toBe('https://x/ada.png');
      // The decoded raw id, not the global id on the wire — and the caller's
      // own scope, not the link's `ownerUserId` — is what goes into the lookup.
      expect(personService.findById).toHaveBeenCalledWith({ userId: OWNER }, 'person-ada');
    });

    it('returns null when personEntityId is not set, without querying PersonService', async () => {
      const link = PeerLinkType.toType(makeLink({ personEntityId: null }));
      const { resolver, personService, context } = build();

      const result = await resolver.avatarUrl(context, link);

      expect(result).toBeNull();
      expect(personService.findById).not.toHaveBeenCalled();
    });

    it('returns null cleanly when the linked Person has no avatar', async () => {
      const link = PeerLinkType.toType(makeLink({ personEntityId: 'person-ada' }));
      const { resolver, context } = build(
        {},
        { findById: jest.fn().mockResolvedValue(makePerson({ properties: {} })) },
      );

      const result = await resolver.avatarUrl(context, link);

      expect(result).toBeNull();
    });

    it('SECURITY: a peer link naming a Person owned by someone else never leaks that avatar', async () => {
      // Faithful to `PersonService.findById` (`EntityService.findById`), which
      // is OWNER-SCOPED — the where clause is `{ id, userId }`, not `{ id }`.
      // A mock that ignored the owner would hide the one case this field has
      // to fail closed on: `personEntityId` decoding to a real Person id that
      // does not belong to the CALLING owner.
      const MALLORYS_PERSON_ID = 'person-mallory';
      const link = PeerLinkType.toType(makeLink({ personEntityId: MALLORYS_PERSON_ID }));
      const { resolver, context } = build(
        {},
        {
          findById: jest.fn(async (ctx: { userId: string }, id: string) =>
            id === MALLORYS_PERSON_ID && ctx.userId === 'someone-else'
              ? makePerson({ id, properties: { avatar_url: 'https://x/mallory.png' } })
              : null,
          ),
        },
      );

      // `context` carries OWNER, not 'someone-else' — this is the caller the
      // link's `personEntityId` does not actually belong to.
      const result = await resolver.avatarUrl(context, link);

      expect(result).toBeNull();
    });

    it("does not leak the rest of the linked Person's properties — only avatarUrl crosses", async () => {
      const link = PeerLinkType.toType(makeLink({ personEntityId: 'person-ada' }));
      const { resolver, context } = build(
        {},
        {
          findById: jest.fn().mockResolvedValue(
            makePerson({
              properties: {
                avatar_url: 'https://x/ada.png',
                vendor_notes: 'ada@example.com',
                ssn: 'do-not-leak',
              },
            }),
          ),
        },
      );

      const result = await resolver.avatarUrl(context, link);

      expect(result).toBe('https://x/ada.png');
      // The PeerLinkType object itself never picked up the Person's jsonb bag —
      // `avatarUrl` is a string return value, not a field stamped onto `link`.
      expect(link).not.toHaveProperty('properties');
      expect(link).not.toHaveProperty('vendor_notes');
      expect(JSON.stringify(link)).not.toContain('ssn');
      expect(JSON.stringify(link)).not.toContain('do-not-leak');
      expect(JSON.stringify(result)).not.toContain('do-not-leak');
    });
  });
});
