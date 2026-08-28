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
 * "I REVOKED THIS PEER" — PROVED AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/peer-federation.md` lists "revocation is immediate" as a security
 * property. `PeerLinkService.spec.ts` pins the two WHERE clauses that deliver
 * it over a fake repository that evaluates the clause it is handed — that test
 * runs everywhere, with or without a database, and is the one a developer sees
 * go red.
 *
 * This suite proves the same sentence one layer lower, where the fake cannot
 * reach: against a real `ci.peer_links` table, a real `UPDATE`, and TypeORM's
 * real SQL generation. The fake models `IsNull()` as `actual == null` because
 * that is what the operator means; only Postgres can show that the SQL TypeORM
 * emits for it is `revoked_at IS NULL` and not, say, `revoked_at = NULL` —
 * which is never true for any row and would silently deny every peer, or its
 * mirror image, which would admit every one.
 *
 * The two together are the belt and the braces: the unit suite catches a
 * deleted clause on any machine; this one catches a clause that survives but
 * stops meaning what it says.
 *
 * Opt-in: set `PEERS_TEST_DATABASE_URL` (or `DATABASE_URL` / `DATABASE_PASSWORD`,
 * as `yarn test` already does from the repo-root `.env`) to a database with
 * migrations applied. `.github/workflows/consent-path-gate.yml` supplies one and
 * FAILS if this suite skips.
 */
const availability = databaseAvailability({ urlEnvVar: 'PEERS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[peers/PeerLinkRevocation.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`peer revocation is immediate — against real Postgres (${availability.target})`, () => {
  const owner = uuidv7();
  const otherOwner = uuidv7();
  const ISSUER = 'https://peer-revocation.test';

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

  /**
   * A fresh link per test, so one test's revoke cannot reach another's row.
   *
   * The whole uuid goes into the handle and the subject, not a prefix: uuidv7
   * is timestamp-ordered, so two links minted in the same millisecond share
   * their leading characters and collide on `peer_links_owner_handle_uniq`.
   */
  async function freshLink(
    ownerUserId: string = owner,
    overrides: { status?: string; revokedAt?: Date | null } = {},
  ): Promise<{ id: string; handle: string; subject: string }> {
    const id = uuidv7();
    const handle = `devon-${id}`;
    const subject = `sub-${id}`;

    await dataSource.query(
      `INSERT INTO ci.peer_links (id, owner_user_id, peer_handle, display_name, memory_endpoint,
                                  peer_issuer, peer_subject, trust_tier, status, revoked_at)
       VALUES ($1, $2, $3, 'Devon', 'https://devon.test', $4, $5, 'family', $6, $7)`,
      [id, ownerUserId, handle, ISSUER, subject, overrides.status ?? 'active', overrides.revokedAt ?? null],
    );

    return { id, handle, subject };
  }

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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'peer revocation');

    for (const [id, label] of [
      [owner, 'PeerRevocationOwner'],
      [otherOwner, 'PeerRevocationOther'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded)
         VALUES ($1, $2, $3, 'x', true)
         ON CONFLICT (id) DO NOTHING`,
        [id, label, `peer.revocation.${id}@example.test`],
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
   * The positive case first, and deliberately: every assertion below is that
   * something is ABSENT, and an absent row is also what a broken query, an
   * empty table or a wrong search_path produces. Without this test the whole
   * suite would pass against a database that returns nothing at all.
   */
  it('resolves an active peer — the suite is not vacuously empty', async () => {
    const { id, subject } = await freshLink();

    const found = await service.findActiveByPeerIdentity(ISSUER, subject);

    expect(found.map((row) => row.id)).toEqual([id]);
    expect(await service.findActiveByIssuerSubject(owner, ISSUER, subject)).not.toBeNull();
  });

  it('SECURITY: a revoked peer stops resolving on the very next inbound ask', async () => {
    const { handle, subject } = await freshLink();

    expect(await service.findActiveByPeerIdentity(ISSUER, subject)).toHaveLength(1);

    // The owner-facing action, through the same method the resolver calls.
    const revoked = await service.revoke({ userId: owner } as never, handle);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toBeInstanceOf(Date);

    // `resolveLink` throws ForbiddenException('No peer link') on an empty list,
    // so this is the ask being refused before any policy runs.
    expect(await service.findActiveByPeerIdentity(ISSUER, subject)).toEqual([]);
    expect(await service.findActiveByIssuerSubject(owner, ISSUER, subject)).toBeNull();
  });

  it('keeps the revoked row readable — revocation is not deletion', async () => {
    const { id, handle } = await freshLink();

    await service.revoke({ userId: owner } as never, handle);

    // The owner must still be able to see that the relationship existed.
    const [row] = await dataSource.query('SELECT id, status, revoked_at FROM ci.peer_links WHERE id = $1', [
      id,
    ]);

    expect(row).toMatchObject({ id, status: 'revoked' });
    expect(row.revoked_at).not.toBeNull();
  });

  /**
   * Each clause pinned on its own, in SQL. A row that trips both is still
   * excluded when only one clause survives, so a combined fixture would let
   * half the filter be deleted without a red test.
   */
  it('excludes on `revoked_at` alone, even where the status still reads active', async () => {
    const { subject } = await freshLink(owner, { status: 'active', revokedAt: new Date() });

    expect(await service.findActiveByPeerIdentity(ISSUER, subject)).toEqual([]);
    expect(await service.findActiveByIssuerSubject(owner, ISSUER, subject)).toBeNull();
  });

  it('excludes on `status` alone, even where revoked_at was never stamped', async () => {
    const { subject } = await freshLink(owner, { status: 'revoked', revokedAt: null });

    expect(await service.findActiveByPeerIdentity(ISSUER, subject)).toEqual([]);
    expect(await service.findActiveByIssuerSubject(owner, ISSUER, subject)).toBeNull();
  });

  it('never resolves a `pending` link — a link is not consent until it is active', async () => {
    const { subject } = await freshLink(owner, { status: 'pending', revokedAt: null });

    expect(await service.findActiveByPeerIdentity(ISSUER, subject)).toEqual([]);
  });

  /**
   * `findActiveByPeerIdentity` is deliberately NOT owner-scoped — an inbound
   * ask is addressed to the box, and the caller disambiguates. So a revoked row
   * leaking back does not merely widen access: `resolveLink` refuses on
   * `links.length > 1` as an ambiguous household, which would DENY the peer
   * that is still legitimately linked.
   */
  it('a revoked link does not resurface to make a surviving link ambiguous', async () => {
    const id = uuidv7();
    const sharedSubject = `sub-shared-${id}`;

    await dataSource.query(
      `INSERT INTO ci.peer_links (id, owner_user_id, peer_handle, display_name, memory_endpoint,
                                  peer_issuer, peer_subject, trust_tier, status, revoked_at)
       VALUES ($1, $2, $3, 'Devon', 'https://devon.test', $4, $5, 'family', 'revoked', now())`,
      [id, owner, `devon-revoked-${id}`, ISSUER, sharedSubject],
    );

    const survivorId = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.peer_links (id, owner_user_id, peer_handle, display_name, memory_endpoint,
                                  peer_issuer, peer_subject, trust_tier, status, revoked_at)
       VALUES ($1, $2, $3, 'Devon', 'https://devon.test', $4, $5, 'family', 'active', NULL)`,
      [survivorId, otherOwner, `devon-active-${survivorId}`, ISSUER, sharedSubject],
    );

    const found = await service.findActiveByPeerIdentity(ISSUER, sharedSubject);

    expect(found.map((row) => row.id)).toEqual([survivorId]);
  });

  it('findActiveByIssuerSubject stays scoped to the owner', async () => {
    const { subject } = await freshLink(otherOwner);

    // Active, and resolvable by its own owner — but not attributable to another.
    expect(await service.findActiveByIssuerSubject(otherOwner, ISSUER, subject)).not.toBeNull();
    expect(await service.findActiveByIssuerSubject(owner, ISSUER, subject)).toBeNull();
  });
});
