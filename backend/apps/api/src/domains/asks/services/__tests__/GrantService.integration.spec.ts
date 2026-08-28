import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { AskEntity, type Ask } from '../../entities/AskEntity';
import { AskGrantEntity } from '../../entities/AskGrantEntity';
import { GrantService } from '../GrantService';

/**
 * `GrantService.evaluate` — the WHERE clause IS the authorization boundary,
 * proved against real Postgres.
 *
 * `evaluateGrant` (grantMatch.spec.ts) is exhaustively tested as a pure
 * function, but it trusts its caller completely — its own docstring says so:
 * "grants MUST already be scoped to (owner = responder, grantee = asker); this
 * function does not re-check ownership." `GrantService.evaluate` is that
 * caller, and the scoping lives entirely in one `repository.find({ where: {
 * ownerUserId, granteeUserId, revokedAt: IsNull() } })`. A mocked repository
 * cannot show that a swapped field or a dropped clause leaks a grant across
 * users — it can only show the service calls `.find()` with SOME object. Only
 * real rows, real other users, and a real query can show the WHERE clause
 * actually excludes them.
 *
 * Opt-in: set `ASKS_TEST_DATABASE_URL` (or `DATABASE_URL` / `DATABASE_PASSWORD`,
 * as `yarn test` already does from the repo-root `.env`) to a database with
 * migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'ASKS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[asks/GrantService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`GrantService.evaluate — against real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let grantService: GrantService;

  // Four distinct people. `owner` is the ask's RESPONDER (the one whose memory
  // is being asked about and who owns the grant); `grantee` is the ask's ASKER
  // the owner actually granted to; `strangerAsker` and `strangerOwner` are two
  // unrelated users who must see none of owner/grantee's grant.
  const owner = { userId: uuidv7() };
  const grantee = { userId: uuidv7() };
  const strangerAsker = { userId: uuidv7() };
  const strangerOwner = { userId: uuidv7() };

  const noopLogger = { setContext: () => undefined, log: () => undefined } as unknown as LoggerService;

  function askBetween(askerUserId: string, responderUserId: string, overrides: Partial<Ask> = {}): Ask {
    return {
      id: uuidv7(),
      askerUserId,
      responderUserId,
      // The ask NAMES a data class, and so does every grant below: an `auto`
      // grant now requires BOTH sides to name one (see `autoGrantNamesQueryClass`),
      // so a class-less fixture would prove the WHERE clauses these tests are
      // about against a decision that had already fallen through to review.
      query: { queryType: 'photos', dataClass: 'photos', prompt: 'do you have photos of us?' },
      status: 'delivered',
      consentBasis: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
      ...overrides,
    } as Ask;
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'ASKS_TEST_DATABASE_URL' });

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
      entities: [AskGrantEntity, AskEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real ci.users / ci.ask_grants rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'GrantService.evaluate');

    for (const [{ userId }, name] of [
      [owner, 'Owner'],
      [grantee, 'Grantee'],
      [strangerAsker, 'StrangerAsker'],
      [strangerOwner, 'StrangerOwner'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded)
         VALUES ($1, $2, $3, 'x', true)
         ON CONFLICT (id) DO NOTHING`,
        [userId, name, `grantservice.${name.toLowerCase()}.${userId}@example.test`],
      );
    }

    grantService = new GrantService(
      dataSource.getRepository(AskGrantEntity),
      dataSource.getRepository(AskEntity),
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the grants with the users.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [
        [owner.userId, grantee.userId, strangerAsker.userId, strangerOwner.userId],
      ]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('auto-answers the grantee the owner actually granted to, and no one else', async () => {
    const grant = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'photos',
      dataClass: 'photos',
      mode: 'auto',
    });

    // The intended pair: owner granted, grantee asks → auto.
    await expect(grantService.evaluate(askBetween(grantee.userId, owner.userId))).resolves.toEqual({
      decision: 'auto',
      grantId: grant.id,
    });

    // Same queryType, but a DIFFERENT asker the owner never granted to → the
    // WHERE clause's granteeUserId filter must exclude them. If it only scoped
    // on ownerUserId this would wrongly auto-answer a stranger.
    await expect(grantService.evaluate(askBetween(strangerAsker.userId, owner.userId))).resolves.toEqual({
      decision: 'review',
    });

    // Same grantee, but asking a DIFFERENT owner who never granted anything →
    // the WHERE clause's ownerUserId filter must exclude them. If it only
    // scoped on granteeUserId this would wrongly auto-answer through a grant
    // that belongs to someone else's memory entirely.
    await expect(grantService.evaluate(askBetween(grantee.userId, strangerOwner.userId))).resolves.toEqual({
      decision: 'review',
    });

    // The relationship is directional: owner granted TO grantee, not the
    // reverse. If the ask were (asker=owner, responder=grantee) this must NOT
    // pick up the same grant row.
    await expect(grantService.evaluate(askBetween(owner.userId, grantee.userId))).resolves.toEqual({
      decision: 'review',
    });

    await grantService.revoke(owner, grant.id);
  });

  it('excludes a revoked grant — a revoked grant must not keep auto-answering', async () => {
    const grant = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'calendar',
      dataClass: 'events',
      mode: 'auto',
    });

    await expect(
      grantService.evaluate(
        askBetween(grantee.userId, owner.userId, {
          query: { queryType: 'calendar', dataClass: 'events', prompt: 'q' },
        }),
      ),
    ).resolves.toEqual({ decision: 'auto', grantId: grant.id });

    await grantService.revoke(owner, grant.id);

    await expect(
      grantService.evaluate(
        askBetween(grantee.userId, owner.userId, {
          query: { queryType: 'calendar', dataClass: 'events', prompt: 'q' },
        }),
      ),
    ).resolves.toEqual({ decision: 'review' });
  });

  it('a block grant denies only the (owner, grantee) pair it was written for', async () => {
    const block = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'health',
      mode: 'block',
    });

    await expect(
      grantService.evaluate(
        askBetween(grantee.userId, owner.userId, { query: { queryType: 'health', prompt: 'q' } }),
      ),
    ).resolves.toEqual({ decision: 'deny', grantId: block.id });

    // The stranger asker is unaffected by a block that names only `grantee`.
    await expect(
      grantService.evaluate(
        askBetween(strangerAsker.userId, owner.userId, { query: { queryType: 'health', prompt: 'q' } }),
      ),
    ).resolves.toEqual({ decision: 'review' });

    await grantService.revoke(owner, block.id);
  });

  /**
   * The grant LIFECYCLE columns, against the real DDL.
   *
   * These four facts are all schema-shaped — an expiry column that exists and is
   * honoured, a supersede chain that a self-referencing FK will actually accept,
   * a history read with no liveness clause, and a cascade that writes to
   * `ci.asks`. None of them can be proved by a mocked repository: the unit specs
   * next door show the service's INTENT, and only real DDL shows that the
   * columns, constraints and cross-table write behave.
   */
  async function insertAsk(askerUserId: string, responderUserId: string, consentBasis: string) {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.asks (id, asker_user_id, responder_user_id, query, status, consent_basis, direction)
       VALUES ($1, $2, $3, $4::jsonb, 'delivered', $5, 'local')`,
      [id, askerUserId, responderUserId, JSON.stringify({ queryType: 'photos', prompt: 'q' }), consentBasis],
    );

    return id;
  }

  async function readAsk(id: string): Promise<{ status: string; consent_basis: string | null }> {
    const [row] = await dataSource.query('SELECT status, consent_basis FROM ci.asks WHERE id = $1', [id]);

    return row;
  }

  it('SECURITY: revoking a grant retroactively withdraws pre-authorization from a delivered ask', async () => {
    const grant = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'photos',
      mode: 'auto',
    });
    const askId = await insertAsk(grantee.userId, owner.userId, grant.id);

    await grantService.revoke(owner, grant.id);

    // `delivered` + a consent basis is the shape `isAnswerable` accepts, so the
    // ask must lose the basis, not merely stop matching for FUTURE asks.
    const after = await readAsk(askId);
    expect(after.consent_basis).toBeNull();
    expect(after.status).toBe('under_review');

    await dataSource.query('DELETE FROM ci.asks WHERE id = $1', [askId]);
  });

  it('SECURITY: a lapsed grant (expires_at in the past) stops auto-answering', async () => {
    const grant = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'lapsing',
      dataClass: 'photos',
      mode: 'auto',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const query = { queryType: 'lapsing', dataClass: 'photos', prompt: 'q' };

    await expect(grantService.evaluate(askBetween(grantee.userId, owner.userId, { query }))).resolves.toEqual(
      { decision: 'auto', grantId: grant.id },
    );

    // Same row, evaluated after the expiry — nothing was revoked, and the row is
    // still `revoked_at IS NULL`, so only the expiry can be excluding it.
    await expect(
      grantService.evaluate(
        askBetween(grantee.userId, owner.userId, { query }),
        new Date(Date.now() + 120_000),
      ),
    ).resolves.toEqual({ decision: 'review' });

    await grantService.revoke(owner, grant.id);
  });

  it('a change writes a supersede chain the FK accepts, and cascades like a revoke', async () => {
    const original = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'superseding',
      dataClass: 'beach',
      mode: 'auto',
    });
    const askId = await insertAsk(grantee.userId, owner.userId, original.id);

    const replacement = await grantService.supersede(owner, original.id, { mode: 'review' });

    expect(replacement.id).not.toBe(original.id);
    expect(replacement.version).toBe(2);
    expect(replacement.supersedesGrantId).toBe(original.id);
    expect(replacement.dataClass).toBe('beach');

    const previous = await grantService.findByIdForOwner(owner, original.id);
    expect(previous?.revokedAt).not.toBeNull();
    expect(previous?.revocationReason).toBe('superseded');
    // The old posture survives on the old row — that is the whole point of not
    // UPDATE-ing in place.
    expect(previous?.mode).toBe('auto');

    const after = await readAsk(askId);
    expect(after.consent_basis).toBeNull();
    expect(after.status).toBe('under_review');

    // Both rows are in history; only the replacement is in the active list.
    const history = await grantService.listHistoryForOwner(owner);
    expect(history.map((g) => g.id)).toEqual(expect.arrayContaining([original.id, replacement.id]));

    const active = await grantService.listForOwner(owner);
    expect(active.map((g) => g.id)).toContain(replacement.id);
    expect(active.map((g) => g.id)).not.toContain(original.id);

    await dataSource.query('DELETE FROM ci.asks WHERE id = $1', [askId]);
    await grantService.revoke(owner, replacement.id);
  });

  /**
   * ═══ THE DISCLOSURE CEILING, THROUGH THE JSONB COLUMN AND BACK ═══
   *
   * `scope.maxDisclosure` had three readers and no writer, so nothing ever
   * proved it survives a round trip. Two things this cannot be shown with a
   * mocked repository:
   *
   *  - `scope` is jsonb. A ceiling that serializes but does not deserialize
   *    (or arrives back as a string when a rung was written) reads as
   *    unrecognised, and `ceilingOf` fails CLOSED to `none` — so the grant
   *    would answer nothing forever and look, from the service layer, exactly
   *    like a grant with no ceiling.
   *  - `supersede` writes the merged scope through the SAME column. A mock
   *    returns whatever object it was handed; only a real round trip shows the
   *    merge is what landed in the row.
   */
  it('SECURITY: a grant ceiling survives the jsonb round trip, and a narrowing change does not drop it', async () => {
    const grant = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'capped',
      dataClass: 'photos',
      mode: 'auto',
      scope: { dataClasses: ['photos', 'events'], maxDisclosure: 'summary' },
    });
    const query = { queryType: 'capped', dataClass: 'photos', prompt: 'q' };

    // Read back out of Postgres by the evaluator, not out of the object we
    // just built.
    await expect(grantService.evaluate(askBetween(grantee.userId, owner.userId, { query }))).resolves.toEqual(
      { decision: 'auto', grantId: grant.id, maxDisclosure: 'summary' },
    );

    // The owner NARROWS the class list. This is the reproduction: the change
    // mentions `dataClasses` only, and used to replace the scope wholesale —
    // deleting the ceiling, so the next answer under a *tightened* grant
    // disclosed MORE than it did before the tightening.
    const narrowed = await grantService.supersede(owner, grant.id, {
      scope: { dataClasses: ['photos'] },
    });

    expect(narrowed.scope).toEqual({ dataClasses: ['photos'], maxDisclosure: 'summary' });
    await expect(grantService.evaluate(askBetween(grantee.userId, owner.userId, { query }))).resolves.toEqual(
      { decision: 'auto', grantId: narrowed.id, maxDisclosure: 'summary' },
    );

    // And the narrowing did take effect on the dimension the owner touched.
    await expect(
      grantService.evaluate(
        askBetween(grantee.userId, owner.userId, {
          query: { queryType: 'capped', dataClass: 'events', prompt: 'q' },
        }),
      ),
    ).resolves.toEqual({ decision: 'review' });

    await grantService.revoke(owner, narrowed.id);
  });

  it('a revoked grant is still resolvable by id — the History surface depends on it', async () => {
    const grant = await grantService.create(owner, {
      granteeUserId: grantee.userId,
      queryType: 'resolvable',
      mode: 'auto',
    });
    await grantService.revoke(owner, grant.id);

    const found = await grantService.findByIdForOwner(owner, grant.id);
    expect(found?.id).toBe(grant.id);
    expect(found?.revocationReason).toBe('revoked');

    // …but it must not leak to another owner, and must not come back as active.
    await expect(grantService.findByIdForOwner(strangerOwner, grant.id)).resolves.toBeNull();
    expect((await grantService.listForOwner(owner)).map((g) => g.id)).not.toContain(grant.id);
  });
});
