import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { PeerLinkEntity } from '../entities/PeerLinkEntity';
import { PeerLinkService } from '../services/PeerLinkService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BINDING A LINK TO A PEER'S OIDC IDENTITY — PROVED AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `peer_links.peer_issuer` / `peer_subject` are what `PeerAskService.resolveLink`
 * matches every INBOUND ask on. `PeerLinkService.upsert` always accepted the
 * pair; nothing in production ever passed it, so a link created the supported
 * way came out with a NULL identity and was inert — the operator's only recourse
 * was hand-written SQL (`docs/peer-federation.md`). `CreatePeerLinkInput`,
 * `UpdatePeerLinkInput` and `ci-memory peers add` now carry it.
 *
 * ═══ WHY THIS SUITE HAS TO TOUCH POSTGRES ═══
 *
 * The dangerous half of that change is not the plumbing, it is UNIQUENESS, and
 * uniqueness is the one rule that cannot be proved over a fake repository. A
 * read-then-write check races — two concurrent binds both read "nothing claims
 * it" and both insert — so the rule lives in a partial unique index,
 * `peer_links_owner_identity_live_uniq`, and only a real `INSERT` can show that
 * the index exists, spans the right columns, and is partial in the three ways
 * it has to be.
 *
 * What the duplicate case would cost if the index were absent is specific:
 * `findActiveByIssuerSubject` is a `findOne` with NO ordering, so two live links
 * of one owner naming the same identity would let HEAP ORDER decide which
 * `trust_tier` ceiling that remote identity inherits.
 *
 * Opt-in exactly like `PeerLinkRevocation.integration.spec.ts`, and for the same
 * reason: set `PEERS_TEST_DATABASE_URL` (or `DATABASE_URL` / `DATABASE_PASSWORD`)
 * to a database with migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'PEERS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[peers/PeerLinkIdentityBinding.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`peer identity binding — against real Postgres (${availability.target})`, () => {
  const owner = uuidv7();
  const otherOwner = uuidv7();
  const ISSUER = 'https://peer-identity-binding.test';

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PeerLinkService;

  /** A handle nothing else in this suite can collide with on `peer_links_owner_handle_uniq`. */
  const handle = (label: string) => `${label}-${uuidv7()}`;

  const dto = (peerHandle: string, extra: Record<string, unknown> = {}) => ({
    peerHandle,
    memoryEndpoint: 'https://devon.test/agent/v1',
    ...extra,
  });

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'PEERS_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [UserEntity, PeerLinkEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real ci.users / ci.peer_links rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'peer identity binding');

    for (const [id, label] of [
      [owner, 'PeerIdentityOwner'],
      [otherOwner, 'PeerIdentityOther'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded)
         VALUES ($1, $2, $3, 'x', true)
         ON CONFLICT (id) DO NOTHING`,
        [id, label, `peer.identity.${id}@example.test`],
      );
    }

    service = new PeerLinkService(dataSource.getRepository(PeerLinkEntity), noopLogger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the peer links.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [[owner, otherOwner]]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /**
   * The whole point of the change, end to end and in one test: a link created
   * through the SUPPORTED path is now findable by the identity an inbound ask
   * presents. Before this change the same sequence returned `[]`, which is the
   * `ForbiddenException('No peer link')` two real boxes hit.
   */
  it('a link created through upsert is resolvable by the identity an inbound ask presents', async () => {
    const subject = `sub-${uuidv7()}`;

    const created = await service.upsert({ userId: owner } as never, {
      ...dto(handle('devon'), { peerIssuer: ISSUER, peerSubject: subject, trustTier: 'family' }),
    });

    const found = await service.findActiveByPeerIdentity(ISSUER, subject);

    expect(found.map((row) => row.id)).toEqual([created.id]);
    expect(await service.findActiveByIssuerSubject(owner, ISSUER, subject)).toMatchObject({
      id: created.id,
      trustTier: 'family',
    });
  });

  it('an update binds a link that was created without an identity', async () => {
    const peerHandle = handle('devon');
    const subject = `sub-${uuidv7()}`;

    const unbound = await service.upsert({ userId: owner } as never, dto(peerHandle));

    expect(unbound.peerIssuer).toBeNull();
    expect(await service.findActiveByPeerIdentity(ISSUER, subject)).toEqual([]);

    await service.upsert({ userId: owner } as never, {
      ...dto(peerHandle, { peerIssuer: ISSUER, peerSubject: subject }),
    });

    expect((await service.findActiveByPeerIdentity(ISSUER, subject)).map((row) => row.id)).toEqual([
      unbound.id,
    ]);
  });

  it('a later edit that omits the pair does not unbind the peer', async () => {
    // The failure this rules out is silent and total: a rename that dropped the
    // binding would 403 every subsequent inbound ask with "No peer link", and
    // nothing on the owner's screen would say why.
    const peerHandle = handle('devon');
    const subject = `sub-${uuidv7()}`;

    await service.upsert({ userId: owner } as never, {
      ...dto(peerHandle, { peerIssuer: ISSUER, peerSubject: subject }),
    });
    await service.upsert({ userId: owner } as never, dto(peerHandle, { displayName: 'Devon L.' }));

    expect(await service.findActiveByPeerIdentity(ISSUER, subject)).toHaveLength(1);
  });

  it('SECURITY: refuses half a pair against the real table, writing nothing', async () => {
    const peerHandle = handle('devon');

    await expect(
      service.upsert({ userId: owner } as never, dto(peerHandle, { peerIssuer: ISSUER })),
    ).rejects.toBeInstanceOf(BadRequestException);

    const rows = await dataSource.query('SELECT id FROM ci.peer_links WHERE peer_handle = $1', [peerHandle]);

    expect(rows).toEqual([]);
  });

  /**
   * ═══ THE DUPLICATE-IDENTITY DECISION, IN SQL ═══
   *
   * One LIVE link per (owner, identity). Not a global uniqueness rule — see the
   * cross-owner test below for why that would be worse, not stricter.
   */
  describe('one live link per (owner, identity)', () => {
    it('SECURITY: a second live link of the same owner cannot claim the same identity', async () => {
      const subject = `sub-${uuidv7()}`;

      await service.upsert({ userId: owner } as never, {
        ...dto(handle('devon-first'), { peerIssuer: ISSUER, peerSubject: subject, trustTier: 'stranger' }),
      });

      // Same identity, DIFFERENT handle — so `peer_links_owner_handle_uniq`
      // does not catch it — and a wider trust tier, which is what makes the
      // duplicate worth having: with both rows live, `findActiveByIssuerSubject`
      // is a `findOne` with no ordering and the ceiling that applies to this
      // remote identity would be whichever row Postgres returned first.
      await expect(
        service.upsert({ userId: owner } as never, {
          ...dto(handle('devon-second'), { peerIssuer: ISSUER, peerSubject: subject, trustTier: 'family' }),
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      const rows = await dataSource.query(
        `SELECT trust_tier FROM ci.peer_links
          WHERE owner_user_id = $1 AND peer_issuer = $2 AND peer_subject = $3 AND revoked_at IS NULL`,
        [owner, ISSUER, subject],
      );

      // Exactly one survivor, and it is the tier the owner actually chose —
      // not a coin flip between `stranger` and `family`.
      expect(rows).toEqual([{ trust_tier: 'stranger' }]);
    });

    it('re-binding the SAME link to the identity it already holds is not a conflict', async () => {
      // The index is on the row, not on the write: `upsert` is documented as
      // idempotent on (owner, handle), and re-running a bind must stay so.
      const peerHandle = handle('devon');
      const subject = `sub-${uuidv7()}`;
      const identity = { peerIssuer: ISSUER, peerSubject: subject };

      const first = await service.upsert({ userId: owner } as never, dto(peerHandle, identity));
      const second = await service.upsert({ userId: owner } as never, dto(peerHandle, identity));

      expect(second.id).toBe(first.id);
    });

    it('a REVOKED link never blocks re-binding the same peer', async () => {
      // Partial on `revoked_at IS NULL` for exactly this: revocation must not
      // become a permanent ban on ever linking that peer again.
      const subject = `sub-${uuidv7()}`;
      const firstHandle = handle('devon-revoked');

      await service.upsert(
        { userId: owner } as never,
        dto(firstHandle, {
          peerIssuer: ISSUER,
          peerSubject: subject,
        }),
      );
      await service.revoke({ userId: owner } as never, firstHandle);

      const replacement = await service.upsert({ userId: owner } as never, {
        ...dto(handle('devon-replacement'), { peerIssuer: ISSUER, peerSubject: subject }),
      });

      // And the revoked row does not resurface to make the survivor ambiguous.
      expect((await service.findActiveByPeerIdentity(ISSUER, subject)).map((row) => row.id)).toEqual([
        replacement.id,
      ]);
    });

    it('any number of UNBOUND links coexist — the index spans only bound, live rows', async () => {
      const first = await service.upsert({ userId: owner } as never, dto(handle('unbound')));
      const second = await service.upsert({ userId: owner } as never, dto(handle('unbound')));

      expect(first.id).not.toBe(second.id);
    });

    /**
     * ═══ WHY PER-OWNER AND NOT GLOBAL ═══
     *
     * `findActiveByPeerIdentity` is deliberately box-wide: an inbound ask is
     * addressed to the box, not to a member. A GLOBAL unique index would let
     * whichever member binds an identity first permanently deny every other
     * member the ability to link that same peer — and, because a lone row is
     * never ambiguous, would make that first link SILENTLY the box's responder
     * for the peer, answering out of that member's memory under that member's
     * trust tier.
     *
     * Per-owner keeps the cross-owner collision REACHABLE, which keeps it
     * failing closed at `PeerAskService.resolveLink`'s `links.length > 1`
     * ("Ambiguous peer link") instead of failing silently open.
     */
    it('two DIFFERENT owners may each link the same peer, and the box then refuses to guess', async () => {
      const subject = `sub-${uuidv7()}`;

      const mine = await service.upsert({ userId: owner } as never, {
        ...dto(handle('devon'), { peerIssuer: ISSUER, peerSubject: subject }),
      });
      const theirs = await service.upsert({ userId: otherOwner } as never, {
        ...dto(handle('devon'), { peerIssuer: ISSUER, peerSubject: subject }),
      });

      const found = await service.findActiveByPeerIdentity(ISSUER, subject);

      // Two rows is what `resolveLink` reads as an ambiguous household and
      // refuses on — fail-closed, and diagnosable, which a global index would
      // have replaced with a silent first-writer-wins.
      expect(found.map((row) => row.id).sort()).toEqual([mine.id, theirs.id].sort());

      // Each owner still attributes the identity to their OWN link.
      expect(await service.findActiveByIssuerSubject(owner, ISSUER, subject)).toMatchObject({ id: mine.id });
      expect(await service.findActiveByIssuerSubject(otherOwner, ISSUER, subject)).toMatchObject({
        id: theirs.id,
      });
    });
  });
});
