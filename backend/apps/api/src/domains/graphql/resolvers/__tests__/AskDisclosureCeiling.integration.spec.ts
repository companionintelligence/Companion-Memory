import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import {
  AskAnswerEntity,
  AskAnswerService,
  AskAuditEntity,
  AskAuditService,
  AskEntity,
  AskGrantEntity,
  AskService,
  GrantService,
} from '@ci/domains/asks';
import { EventEntity } from '@ci/domains/memory';
import { PeerAskCorrelationEntity, PeerAskService, PeerLinkEntity } from '@ci/domains/peers';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GlobalUID } from '../../types/GlobalUID';
import { AskResolver } from '../AskResolver';

/**
 * The disclosure ceiling, against real Postgres — because the bug WAS the SQL.
 *
 * Both defects proved here are invisible to a mocked repository, for the same
 * reason: they are properties of what a query RETURNS, not of what a service
 * intends.
 *
 *  - A revoked grant is not a stale row to the answer path. Every read path
 *    filters `revoked_at IS NULL`, so it is a row that has ceased to exist. A
 *    mock returning `{ decision: 'review' }` is a fair model of that once you
 *    already know it — but only real rows and a real revoke show that
 *    withdrawing consent is what produces it.
 *  - The federated availability answer reads the owner's calendar directly.
 *    Whether a ceiling reaches that read is a question about the code path
 *    between the two, and the fixture that would prove it in a unit test is the
 *    same fixture that hid it.
 *
 * Opt-in: set `ASKS_TEST_DATABASE_URL` (or `DATABASE_URL` / `DATABASE_PASSWORD`,
 * as `yarn test` already does from the repo-root `.env`) to a database with
 * migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'ASKS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[asks/AskDisclosureCeiling.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`ask disclosure ceilings — against real Postgres (${availability.target})`, () => {
  const owner = uuidv7();
  const asker = uuidv7();

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let grantService: GrantService;
  let askService: AskService;
  let answerService: AskAnswerService;
  let auditService: AskAuditService;

  /** The resolver with everything real except the search index. */
  function resolverOver(matches: { id: string; type: string }[]) {
    return new AskResolver(
      askService as never,
      grantService as never,
      auditService as never,
      { consume: jest.fn() } as never,
      { execute: jest.fn().mockResolvedValue(matches) } as never,
      answerService as never,
      { findById: jest.fn().mockResolvedValue(null) } as never,
      { send: jest.fn() } as never,
      {
        // The household-tier service. `resolveTier` consults it for a LOCAL
        // asker; undefined member means the default (`household`) still applies.
        tierFor: jest.fn().mockResolvedValue('household'),
        listForOwner: jest.fn().mockResolvedValue([]),
        setTier: jest.fn(),
      } as never,
      {
        // The broadcast service. `createAskBroadcast` / `myAskBroadcasts` are the
        // only callers; every other operation here never touches it.
        create: jest.fn(),
        listForAsker: jest.fn().mockResolvedValue([]),
        asksForBroadcasts: jest.fn().mockResolvedValue(new Map()),
        findForAsker: jest.fn(),
      } as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
    );
  }

  async function storedAnswer(askId: string) {
    const [row] = await dataSource.query(
      'SELECT summary, disclosed_entities FROM ci.ask_answers WHERE ask_id = $1',
      [askId],
    );

    return row as { summary: string; disclosed_entities: { id: string }[] };
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
      entities: [
        AskEntity,
        AskGrantEntity,
        AskAuditEntity,
        AskAnswerEntity,
        UserEntity,
        PeerLinkEntity,
        // `PeerAskService.handle` reads the correlation table before it creates
        // an ask — `askId` is an idempotency key, and a repeat must replay
        // rather than create a second ask. This DataSource lists its entities
        // explicitly, so the repository has no metadata without it.
        PeerAskCorrelationEntity,
        EventEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real ci.users / ci.asks rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'ask disclosure ceilings');

    for (const [id, name] of [
      [owner, 'CeilingOwner'],
      [asker, 'CeilingAsker'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded)
         VALUES ($1, $2, $3, 'x', true)
         ON CONFLICT (id) DO NOTHING`,
        [id, name, `ceiling.${name.toLowerCase()}.${id}@example.test`],
      );
    }

    grantService = new GrantService(
      dataSource.getRepository(AskGrantEntity),
      dataSource.getRepository(AskEntity),
      noopLogger,
    );
    answerService = new AskAnswerService(dataSource.getRepository(AskAnswerEntity), noopLogger);
    auditService = new AskAuditService(dataSource.getRepository(AskAuditEntity), noopLogger);
    askService = new AskService(
      dataSource.getRepository(AskEntity),
      dataSource.getRepository(UserEntity),
      grantService,
      auditService,
      answerService,
      dataSource,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the asks, answers, audits and grants with them.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [[owner, asker]]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /**
   * SECURITY: revoking a grant used to make the answer BIGGER.
   *
   * The full owner-review round trip, twice, differing only in whether the
   * grant is revoked between the approval and the answer. Reproduced on
   * `origin/main` at 79a60a1: the control disclosed "3 matching items." with no
   * references, and the revoked run disclosed all three entity references —
   * readable by the asker through `askAnswer`.
   */
  it('SECURITY: revoking the capping grant cannot widen an ask the owner already approved', async () => {
    const matches = [
      { id: uuidv7(), type: 'file' },
      { id: uuidv7(), type: 'file' },
      { id: uuidv7(), type: 'file' },
    ];
    const resolver = resolverOver(matches);
    const grant = await grantService.create(
      { userId: owner },
      {
        granteeUserId: asker,
        queryType: 'photos',
        dataClass: 'photos',
        mode: 'review',
        scope: { maxDisclosure: 'count' },
      },
    );

    const submit = async () => {
      const { ask } = await askService.submit(
        { userId: asker },
        { responderUserId: owner, query: { queryType: 'photos', dataClass: 'photos', prompt: 'p' } },
      );
      await askService.approve({ userId: owner }, ask.id);

      return ask.id;
    };

    // Control: grant in force.
    const control = await submit();
    await resolver.runAsk({ userId: owner } as never, GlobalUID.encode('ask', control));
    expect(await storedAnswer(control)).toMatchObject({
      summary: '3 matching items.',
      disclosed_entities: [],
    });

    // The escalation: approved under the same grant, answered after the revoke.
    const escalated = await submit();
    await grantService.revoke({ userId: owner }, grant.id);
    await resolver.runAsk({ userId: owner } as never, GlobalUID.encode('ask', escalated));

    const after = await storedAnswer(escalated);
    expect(after.disclosed_entities).toEqual([]);
    expect(after.summary).toBe('3 matching items.');

    // And nothing extra reaches the ASKER through the read path either.
    const seen = await resolver.askAnswer({ userId: asker } as never, GlobalUID.encode('ask', escalated));
    expect(seen?.items).toEqual([]);
  });

  /**
   * SECURITY: the availability archetype answered from the owner's real
   * calendar with neither ceiling applied.
   */
  it('SECURITY: a federated availability ask is clamped by the grant and the tier', async () => {
    const linkId = uuidv7();
    const eventId = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.peer_links (id, owner_user_id, peer_handle, display_name, memory_endpoint,
                                  peer_issuer, peer_subject, trust_tier, status)
       VALUES ($1, $2, 'ceiling-peer', 'Peer', 'https://peer.test', 'https://iss.test', $3, 'stranger', 'active')`,
      [linkId, owner, `sub-${linkId}`],
    );
    // The CTI base row shares the event's uuid (events.event_id → entities.entity_id).
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Event', $2, 'Lunch')`,
      [eventId, owner],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, end_time, is_deleted)
       VALUES ($1, $2, '2026-09-01T12:00:00Z', '2026-09-01T13:00:00Z', false)`,
      [eventId, owner],
    );
    await grantService.create(
      { userId: owner },
      {
        granteePeerLinkId: linkId,
        queryType: 'availability',
        dataClass: 'calendar',
        mode: 'auto',
        scope: { maxDisclosure: 'none' },
      },
    );

    const link = await dataSource.getRepository(PeerLinkEntity).findOneByOrFail({ id: linkId });
    const peerAsk = new PeerAskService(
      { findActiveByPeerIdentity: jest.fn().mockResolvedValue([link]) } as never,
      askService,
      grantService,
      { execute: jest.fn().mockResolvedValue([]) } as never,
      answerService,
      auditService,
      dataSource.getRepository(EventEntity),
      noopLogger,
    );

    const response = await peerAsk.handle(
      { issuer: 'https://iss.test', subject: `sub-${linkId}` },
      {
        askId: `corr-${linkId}`.slice(0, 64),
        askerHandle: 'ceiling-peer',
        prompt: 'free friday?',
        request: {
          archetype: 'availability',
          from: '2026-09-01T09:00:00Z',
          to: '2026-09-01T17:00:00Z',
        },
      },
    );

    // The owner's real 12:00–13:00 meeting and both free windows used to cross.
    expect(response.answer).toMatchObject({ summary: 'Nothing was shared.', busy: [], free: [] });

    // …and the disclosure is now on the record, which it was not at all before.
    const [{ n }] = await dataSource.query(
      `SELECT count(*)::int AS n FROM ci.ask_answers a
       JOIN ci.asks k ON k.id = a.ask_id WHERE k.peer_link_id = $1`,
      [linkId],
    );
    expect(n).toBe(1);

    await dataSource.query('DELETE FROM ci.asks WHERE peer_link_id = $1', [linkId]);
    await dataSource.query('DELETE FROM ci.ask_grants WHERE grantee_peer_link_id = $1', [linkId]);
    await dataSource.query('DELETE FROM ci.peer_links WHERE id = $1', [linkId]);
    await dataSource.query('DELETE FROM ci.events WHERE event_id = $1', [eventId]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1', [eventId]);
  });
});
