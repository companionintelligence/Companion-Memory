import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { EntityIdentifierService } from '@ci/domains/graph';
import {
  CommunicationLinkBackfillService,
  DeterministicEdgeBackfillService,
  type EdgeProjectionReopener,
  EventParticipantBackfillService,
} from '@ci/domains/maintenance';
import { GraphDeltaWriter } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PIPELINE_QUEUES } from '../../constants';
import { PipelineSliceListener } from '../../listeners/PipelineSliceListener';
import { EdgeProjectionReopenService } from '../../services/EdgeProjectionReopenService';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { Stage } from '../../types';
import { ENRICH_PERSON_LINK_STAGE_ID, PersonLinkStage } from '../enrich/PersonLinkStage';
import {
  CommunicationEdgePromoteStage,
  EventEdgePromoteStage,
  PROMOTE_EDGE_COMMUNICATION_STAGE_ID,
  PROMOTE_EDGE_COMMUNICATION_VERSION,
  PROMOTE_EDGE_EVENT_STAGE_ID,
  PROMOTE_EDGE_EVENT_VERSION,
} from '../promote/EdgePromoteStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LINKAGE THAT ARRIVES AFTER AN EDGE LEG DECIDED THE ROW STILL GETS ITS EDGES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `promote.edge_communication` decides a message on the FIRST of its sender,
 * recipients or attachments to arrive. On the reference appliance (2026-09-30)
 * 17,417 messages sat `done` at the leg's then-current version (7) without 19,889 RECEIVED
 * and 1,456 SENT edges: the push had linked one half, the edge leg projected
 * that half and recorded `done`, and the other half was filled in hours later —
 * 17,416 times by `CommunicationLinkBackfillService` (the `link_communications`
 * leg smart-rotation's `graph_link` runs every two hours), once by
 * `enrich.person_link`. Nothing re-opened the decision, so nothing ever
 * projected the rest.
 *
 * What only a real database can show, and a stubbed `query` would agree with
 * unconditionally:
 *
 *  1. the gap is real — ledger, predicate and projection together strand a
 *     half-linked message when a linker fills the other half without saying so;
 *  2. `CommunicationLinkBackfillService` now re-opens exactly the rows it wrote,
 *     through the real `EdgeProjectionReopenService` and `reopen()`, and the
 *     next edge slice projects the missing edge without duplicating the rest;
 *  3. the link and its re-open are ONE transaction — a failure after the
 *     re-open leaves neither;
 *  4. `enrich.person_link`'s `done` re-opens the leg through `STAGE_REOPENS`;
 *  5. `EventParticipantBackfillService` does the same for `promote.edge_event`;
 *  6. repair migration `20260930161359` re-opens exactly the stranded rows —
 *     not a complete one, not one whose only missing pair points at a deleted
 *     person, not one whose edge already sits on a merge survivor.
 *
 * Everything runs through the real listener, ledger, stages, linkers and edge
 * projection. Nothing is stubbed but the Nest container (a ModuleRef that hands
 * back the real re-opener, and a registry that hands back the real stages).
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. Every
 * fixture belongs to a synthetic user and is deleted in `afterAll`.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://… yarn workspace @ci/be-api jest LateLinkageReopensEdgeLegs.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/LateLinkageReopensEdgeLegs.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(90_000);

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../db/postgres/migrations/20260930161359_reopen_edge_decisions_for_late_linkage.sql',
);

/**
 * The check this change was measured with, scoped to the ids asked about: a
 * message with a projectable sender or recipient (resolved through the merge
 * tombstone, active-or-merged, as the projection resolves it) and no active
 * edge of that type from it. A message's own entity is never merged, so its id
 * is the edge's `to`.
 */
const GAP_SQL = `
  SELECT DISTINCT c.id
    FROM ci.communications c
    CROSS JOIN LATERAL (
      SELECT unnest(c.to_entity_ids) AS person_id, 'RECEIVED'::text AS relationship_type
      UNION ALL
      SELECT c.from_entity_id, 'SENT' WHERE c.from_entity_id IS NOT NULL
    ) p
    JOIN ci.entities ef
      ON ef.entity_id = p.person_id
     AND ef.owner_user_id = c.user_id
     AND (ef.is_active = TRUE OR ef.merged_into_entity_id IS NOT NULL)
   WHERE c.user_id = $1
     AND c.id = ANY($2::uuid[])
     AND NOT EXISTS (SELECT 1
                       FROM ci.relationships r
                      WHERE r.from_entity_id = COALESCE(ef.merged_into_entity_id, ef.entity_id)
                        AND r.to_entity_id = c.id
                        AND r.relationship_type = p.relationship_type
                        AND r.is_active = TRUE)
   ORDER BY c.id`;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describeWithDb(`late linkage re-opens the edge legs against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let ctx: UserServiceContext;

  let ledger: PipelineStateService;
  let commEdgeStage: CommunicationEdgePromoteStage;
  let eventEdgeStage: EventEdgePromoteStage;
  let personLinkStage: PersonLinkStage;
  let worker: PipelineSliceListener;
  let workerLogger: ReturnType<typeof makeLogger>;
  let reopener: EdgeProjectionReopenService;
  let linker: CommunicationLinkBackfillService;
  let eventLinker: EventParticipantBackfillService;
  let identifiers: EntityIdentifierService;

  /** Hands back the real re-opener, as `moduleRef.get(EDGE_PROJECTION_REOPENER)` does in the app. */
  const moduleRefFor = (bound: EdgeProjectionReopener) => ({ get: () => bound }) as never;

  const people = {
    /** Sender the push linked at ingest. */
    sender: uuidv7(),
    /** Recipient only the identifier index knows — the owner's own number, in the Google Voice case. */
    recipient: uuidv7(),
    /** The owner, as the WhatsApp sender the push could not resolve. */
    owner: uuidv7(),
    /** Recipient `enrich.person_link` resolves. */
    linkedByStage: uuidv7(),
    /** Calendar organizer `link_events` resolves. */
    organizer: uuidv7(),
    /** A person deleted without a merge: the projection writes nothing for it. */
    deleted: uuidv7(),
    /** A merged-away duplicate and its survivor. */
    mergedAway: uuidv7(),
    survivor: uuidv7(),
  };
  const place = uuidv7();

  const comms = {
    /** Google Voice shape: sender linked, recipient not. */
    senderOnly: uuidv7(),
    /** WhatsApp shape: recipient linked, the owner's sender not. */
    recipientOnly: uuidv7(),
    /** Linked late by a writer that does NOT re-open — the pre-fix behaviour. */
    strandedByRawWrite: uuidv7(),
    /** The link write whose transaction fails after the re-open. */
    rolledBack: uuidv7(),
    /** Linked late by `enrich.person_link`. */
    byPersonLink: uuidv7(),
    /** Fully projected: nothing is missing. */
    complete: uuidv7(),
    /** Its only unprojected pair points at a deleted person. */
    deletedOnly: uuidv7(),
    /** Its column still names the merged-away id; the edge sits on the survivor. */
    viaTombstone: uuidv7(),
  };
  const events = {
    /** Decided on its place (LOCATED_AT) before `link_events` found its organizer. */
    placeFirst: uuidv7(),
    /** Decided on its place, then given a participant by a writer that says nothing. */
    strandedByRawWrite: uuidv7(),
  };

  const allEntityIds = () => [
    ...Object.values(people),
    place,
    ...Object.values(comms),
    ...Object.values(events),
  ];

  async function seedPerson(
    entityId: string,
    name: string,
    extra: Partial<{ active: boolean; mergedInto: string }> = {},
  ) {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, is_active, merged_into_entity_id)
       VALUES ($1, 'Person', $2, '{}'::jsonb, $3, $4, $5)`,
      [entityId, name, ctx.userId, extra.active ?? true, extra.mergedInto ?? null],
    );
  }

  async function indexEmail(entityId: string, email: string) {
    await dataSource.query(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value)
       VALUES ($1, $2, 'email', $3, $3)`,
      [entityId, ctx.userId, email],
    );
  }

  async function seedComm(
    id: string,
    n: number,
    args: { from: string | null; to: string[]; meta: Record<string, unknown> },
  ): Promise<void> {
    // A communication is a CTI aggregate: the ci.entities row is the edge's
    // Communication endpoint, and the FK wants it first.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Communication', $2, '{}'::jsonb, $3)`,
      [id, `Late-linkage fixture ${n}`, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.communications
         (id, time, user_id, communication_type, direction, from_entity_id, to_entity_ids,
          participants_metadata, content, source_type, source_system, source_id)
       VALUES ($1::uuid, $2::timestamptz, $3, 'sms', 'inbound', $4::uuid, $5::uuid[], $6::jsonb, 'hello',
               'ci.import', 'google_voice', $1::text)`,
      [
        id,
        `2025-06-${String(n).padStart(2, '0')}T15:00:00Z`,
        ctx.userId,
        args.from,
        args.to,
        JSON.stringify(args.meta),
      ],
    );
  }

  /** One slice through the real worker, exactly as a dispatched job arrives. */
  async function runSlice(stage: Stage, entityType: string, ids: string[]): Promise<void> {
    await worker.handleSlice(PIPELINE_QUEUES.INDEX, { stage: stage.id, entityType, userId: ctx.userId, ids });
  }

  async function ledgerRow(entityType: string, stageId: string, entityId: string) {
    const [row] = await dataSource.query(
      `SELECT status, stage_version FROM ci.pipeline_state
        WHERE entity_type = $1 AND entity_id = $2 AND stage = $3`,
      [entityType, entityId, stageId],
    );

    return row as { status: string; stage_version: number } | undefined;
  }

  async function edges(fromId: string, toId: string, type: string) {
    return dataSource.query(
      `SELECT from_entity_id, to_entity_id, properties->>'rule' AS rule
         FROM ci.relationships
        WHERE owner_user_id = $1 AND relationship_type = $2
          AND from_entity_id = $3 AND to_entity_id = $4 AND is_active = TRUE`,
      [ctx.userId, type, fromId, toId],
    ) as Promise<Array<{ from_entity_id: string; to_entity_id: string; rule: string }>>;
  }

  const gap = async (ids: string[]) =>
    ((await dataSource.query(GAP_SQL, [ctx.userId, ids])) as Array<{ id: string }>).map((row) => row.id);

  const offeredTo = (stage: Stage) => ledger.selectStale(stage, ctx.userId, null, 500);

  const decided = { status: 'done', stage_version: PROMOTE_EDGE_COMMUNICATION_VERSION };
  const reopened = { status: 'done', stage_version: 0 };

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });

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
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/LateLinkageReopensEdgeLegs.integration');

    ctx = {
      userId: await createSyntheticTestUser(
        (sql, params) => dataSource.query(sql, params),
        'LateLinkageReopensEdgeLegs',
      ),
    } as UserServiceContext;

    const logger = () => makeLogger() as never;
    const edgeService = new DeterministicEdgeBackfillService(
      dataSource,
      new GraphDeltaWriter(dataSource, logger()),
      logger(),
    );

    ledger = new PipelineStateService(dataSource, logger());
    commEdgeStage = new CommunicationEdgePromoteStage(edgeService, logger());
    eventEdgeStage = new EventEdgePromoteStage(edgeService, logger());
    personLinkStage = new PersonLinkStage(dataSource, logger());

    const stages = new Map<string, Stage>([
      [commEdgeStage.id, commEdgeStage],
      [eventEdgeStage.id, eventEdgeStage],
      [personLinkStage.id, personLinkStage],
    ]);
    const registry = {
      get: (stageId: string) => {
        const stage = stages.get(stageId);

        if (stage == null) {
          throw new Error(`Unknown pipeline stage "${stageId}".`);
        }

        return stage;
      },
    };

    workerLogger = makeLogger();
    worker = new PipelineSliceListener(registry as never, ledger, workerLogger as never);
    reopener = new EdgeProjectionReopenService(ledger, registry as never);

    // The real lookup; it only ever reads through the repository's manager.
    identifiers = new EntityIdentifierService({ manager: dataSource.manager } as never, logger());
    linker = new CommunicationLinkBackfillService(dataSource, identifiers, logger(), moduleRefFor(reopener));
    eventLinker = new EventParticipantBackfillService(
      dataSource,
      identifiers,
      logger(),
      moduleRefFor(reopener),
    );

    await seedPerson(people.sender, 'Sacha Sender');
    await seedPerson(people.recipient, 'Owner (vCard)');
    await seedPerson(people.owner, 'Owner (contact list)');
    await seedPerson(people.linkedByStage, 'Pat Stage');
    await seedPerson(people.organizer, 'Olive Organizer');
    await seedPerson(people.deleted, 'Deleted Person', { active: false });
    await seedPerson(people.survivor, 'Sam Survivor');
    await seedPerson(people.mergedAway, 'Sam Duplicate', { active: false, mergedInto: people.survivor });
    await indexEmail(people.recipient, 'owner-gv@example.com');
    await indexEmail(people.owner, 'owner-wa@example.com');
    await indexEmail(people.linkedByStage, 'pat@example.com');
    await indexEmail(people.organizer, 'olive@example.com');

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point, place_kind)
       VALUES ($1, 'Location', $2, 'Late-linkage venue', '{}'::jsonb,
               ST_SetSRID(ST_MakePoint(-33.5, -44.5), 4326)::geography, 'address')`,
      [place, ctx.userId],
    );

    await seedComm(comms.senderOnly, 1, {
      from: people.sender,
      to: [],
      meta: { from: 'sacha@example.com', to: ['owner-gv@example.com'] },
    });
    await seedComm(comms.recipientOnly, 2, {
      from: null,
      to: [people.sender],
      meta: { from: 'owner-wa@example.com', to: ['sacha@example.com'] },
    });
    await seedComm(comms.strandedByRawWrite, 3, { from: people.sender, to: [], meta: {} });
    await seedComm(comms.rolledBack, 4, {
      from: people.sender,
      to: [],
      meta: { from: 'sacha@example.com', to: ['owner-gv@example.com'] },
    });
    await seedComm(comms.byPersonLink, 5, {
      from: people.sender,
      to: [],
      meta: { from: 'sacha@example.com', to: ['pat@example.com'] },
    });
    await seedComm(comms.complete, 6, { from: people.sender, to: [people.recipient], meta: {} });
    await seedComm(comms.deletedOnly, 7, { from: people.sender, to: [], meta: {} });
    await seedComm(comms.viaTombstone, 8, { from: people.sender, to: [people.mergedAway], meta: {} });

    for (const [eventId, metadata] of [
      [events.placeFirst, { organizerEmail: 'olive@example.com' }],
      [events.strandedByRawWrite, {}],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Event', 'Late-linkage meeting', '{}'::jsonb, $2, 'events', $1)`,
        [eventId, ctx.userId],
      );
      await dataSource.query(
        `INSERT INTO ci.events (event_id, user_id, start_time, source_type, source_system, source_id, metadata, location_entity_id)
         VALUES ($1::uuid, $2, '2025-06-09T15:00:00Z', 'ci.import', 'calendar', $1::text, $3::jsonb, $4)`,
        [eventId, ctx.userId, JSON.stringify(metadata), place],
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [
        allEntityIds(),
      ]);
      await dataSource.query(`DELETE FROM ci.pipeline_dead_letters WHERE payload->>'userId' = $1`, [
        ctx.userId,
      ]);
      await dataSource.query('DELETE FROM ci.identifier_claims WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
      await dataSource.query(
        'DELETE FROM ci.entities WHERE owner_user_id = $1 AND merged_into_entity_id IS NOT NULL',
        [ctx.userId],
      );
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('the link backfill re-opens the half-linked messages it completes, and the next slice projects the rest', async () => {
    const victims = [comms.senderOnly, comms.recipientOnly];

    // ── The edge leg decides each message on the half the push linked. ──
    await runSlice(commEdgeStage, 'communication', victims);

    expect(await edges(people.sender, comms.senderOnly, 'SENT')).toHaveLength(1);
    expect(await edges(people.sender, comms.recipientOnly, 'RECEIVED')).toHaveLength(1);
    expect(await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.senderOnly)).toEqual(
      decided,
    );
    expect(
      await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.recipientOnly),
    ).toEqual(decided);
    expect(await offeredTo(commEdgeStage)).not.toEqual(expect.arrayContaining([comms.senderOnly]));

    // ── Then graph_link's link_communications leg fills the other halves. ──
    const result = await linker.backfill(ctx.userId, {
      startTime: new Date('2025-06-01T00:00:00Z'),
      endTime: new Date('2025-06-03T00:00:00Z'),
    });

    expect(result).toMatchObject({ fromLinked: 1, toLinked: 1, edgeDecisionsReopened: 2 });
    const rows: Array<{ id: string; from_entity_id: string | null; to_entity_ids: string[] }> =
      await dataSource.query(
        `SELECT id, from_entity_id, to_entity_ids FROM ci.communications WHERE id = ANY($1::uuid[]) ORDER BY time`,
        [victims],
      );
    expect(rows).toEqual([
      { id: comms.senderOnly, from_entity_id: people.sender, to_entity_ids: [people.recipient] },
      { id: comms.recipientOnly, from_entity_id: people.owner, to_entity_ids: [people.sender] },
    ]);

    // The gap, exactly as measured, now open for both.
    expect(await gap(victims)).toEqual([...victims].sort());

    // ── Re-opened with the write, so THE ONE RULE offers them again. ──
    expect(await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.senderOnly)).toEqual(
      reopened,
    );
    expect(
      await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.recipientOnly),
    ).toEqual(reopened);
    expect(await offeredTo(commEdgeStage)).toEqual(expect.arrayContaining(victims));

    await runSlice(commEdgeStage, 'communication', victims);

    expect(await edges(people.recipient, comms.senderOnly, 'RECEIVED')).toEqual([
      expect.objectContaining({ rule: 'communication.received' }),
    ]);
    expect(await edges(people.owner, comms.recipientOnly, 'SENT')).toEqual([
      expect.objectContaining({ rule: 'communication.sent' }),
    ]);
    // Re-projecting what was already there wrote nothing twice.
    expect(await edges(people.sender, comms.senderOnly, 'SENT')).toHaveLength(1);
    expect(await edges(people.sender, comms.recipientOnly, 'RECEIVED')).toHaveLength(1);
    expect(await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.senderOnly)).toEqual(
      decided,
    );
    expect(await gap(victims)).toEqual([]);

    // A second pass finds nothing left to link, so it re-opens nothing.
    await expect(
      linker.backfill(ctx.userId, {
        startTime: new Date('2025-06-01T00:00:00Z'),
        endTime: new Date('2025-06-03T00:00:00Z'),
      }),
    ).resolves.toMatchObject({ fromLinked: 0, toLinked: 0, edgeDecisionsReopened: 0 });
  });

  it('strands the message when a linker writes without re-opening — the state the reference appliance was in', async () => {
    await runSlice(commEdgeStage, 'communication', [comms.strandedByRawWrite]);

    // What the link backfill did before this change: fill the column, say nothing.
    await dataSource.query(`UPDATE ci.communications SET to_entity_ids = ARRAY[$2::uuid] WHERE id = $1`, [
      comms.strandedByRawWrite,
      people.recipient,
    ]);

    expect(
      await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.strandedByRawWrite),
    ).toEqual(decided);
    expect(await offeredTo(commEdgeStage)).not.toContain(comms.strandedByRawWrite);
    expect(await gap([comms.strandedByRawWrite])).toEqual([comms.strandedByRawWrite]);
  });

  it('commits the link and its re-open together, or neither', async () => {
    await runSlice(commEdgeStage, 'communication', [comms.rolledBack]);

    // The real re-open runs, THEN the transaction fails: both must roll back.
    // Keeping the re-open without the link would re-decide an unchanged row;
    // keeping the link without the re-open is the gap itself.
    const failingAfterReopen: EdgeProjectionReopener = {
      reopen: async (source, ids, manager) => {
        const moved = await reopener.reopen(source, ids, manager);

        expect(moved).toBe(1);
        throw new Error('connection lost after the re-open');
      },
    };
    const failingLinker = new CommunicationLinkBackfillService(
      dataSource,
      identifiers,
      makeLogger() as never,
      moduleRefFor(failingAfterReopen),
    );

    await expect(
      failingLinker.backfill(ctx.userId, {
        startTime: new Date('2025-06-04T00:00:00Z'),
        endTime: new Date('2025-06-05T00:00:00Z'),
      }),
    ).rejects.toThrow('connection lost after the re-open');

    const [row] = await dataSource.query(`SELECT to_entity_ids FROM ci.communications WHERE id = $1`, [
      comms.rolledBack,
    ]);
    expect(row.to_entity_ids).toEqual([]);
    expect(await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.rolledBack)).toEqual(
      decided,
    );
  });

  it("re-opens the edge leg when enrich.person_link records done, through the worker's STAGE_REOPENS step", async () => {
    await runSlice(commEdgeStage, 'communication', [comms.byPersonLink]);
    expect(await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.byPersonLink)).toEqual(
      decided,
    );

    workerLogger.log.mockClear();
    await runSlice(personLinkStage, 'communication', [comms.byPersonLink]);

    const [row] = await dataSource.query(`SELECT to_entity_ids FROM ci.communications WHERE id = $1`, [
      comms.byPersonLink,
    ]);
    expect(row.to_entity_ids).toEqual([people.linkedByStage]);
    expect(await ledgerRow('communication', ENRICH_PERSON_LINK_STAGE_ID, comms.byPersonLink)).toMatchObject({
      status: 'done',
    });
    expect(await ledgerRow('communication', PROMOTE_EDGE_COMMUNICATION_STAGE_ID, comms.byPersonLink)).toEqual(
      reopened,
    );
    const linkSliceLog = workerLogger.log.mock.calls.find(
      ([message, fields]) =>
        message === 'Processed pipeline slice' && fields?.stage === ENRICH_PERSON_LINK_STAGE_ID,
    );
    expect(linkSliceLog?.[1]).toEqual(expect.objectContaining({ reopened: 1, done: 1 }));

    await runSlice(commEdgeStage, 'communication', [comms.byPersonLink]);

    expect(await edges(people.linkedByStage, comms.byPersonLink, 'RECEIVED')).toHaveLength(1);
    expect(await gap([comms.byPersonLink])).toEqual([]);
  });

  it('the event linker re-opens promote.edge_event for the organizer it adds to an event decided on its place', async () => {
    await runSlice(eventEdgeStage, 'event', [events.placeFirst]);

    expect(await edges(events.placeFirst, place, 'LOCATED_AT')).toHaveLength(1);
    expect(await ledgerRow('event', PROMOTE_EDGE_EVENT_STAGE_ID, events.placeFirst)).toEqual({
      status: 'done',
      stage_version: PROMOTE_EDGE_EVENT_VERSION,
    });

    const result = await eventLinker.backfill(ctx.userId);

    expect(result).toMatchObject({ organizersLinked: 1, edgeDecisionsReopened: 1 });
    expect(await ledgerRow('event', PROMOTE_EDGE_EVENT_STAGE_ID, events.placeFirst)).toEqual({
      status: 'done',
      stage_version: 0,
    });

    await runSlice(eventEdgeStage, 'event', [events.placeFirst]);

    expect(await edges(people.organizer, events.placeFirst, 'PARTICIPATED_IN')).toHaveLength(1);
    expect(await edges(events.placeFirst, place, 'LOCATED_AT')).toHaveLength(1);
  });

  it('the repair migration re-opens exactly the stranded rows', async () => {
    // Three more decided rows, each a case the repair must leave alone.
    await runSlice(commEdgeStage, 'communication', [comms.complete, comms.deletedOnly, comms.viaTombstone]);
    // deletedOnly: a recipient deleted without a merge is linked after the
    // decision. The projection writes nothing for an inactive, un-merged
    // person, so re-opening it would re-decide to the same nothing.
    await dataSource.query(`UPDATE ci.communications SET to_entity_ids = ARRAY[$2::uuid] WHERE id = $1`, [
      comms.deletedOnly,
      people.deleted,
    ]);

    // viaTombstone's column still names the merged-away id; its RECEIVED edge
    // was projected onto the survivor, which is where the repair must look.
    expect(await edges(people.survivor, comms.viaTombstone, 'RECEIVED')).toHaveLength(1);

    // And the event leg: decided on its place, then given a participant by a
    // writer that re-opens nothing. `placeFirst` (repaired above) is complete.
    await runSlice(eventEdgeStage, 'event', [events.strandedByRawWrite]);
    await dataSource.query(
      `UPDATE ci.events SET participant_entity_ids = ARRAY[$2::uuid] WHERE event_id = $1`,
      [events.strandedByRawWrite, people.organizer],
    );

    const up = (() => {
      const sql = readFileSync(MIGRATION, 'utf8');

      return sql.slice(sql.indexOf('-- migrate:up') + '-- migrate:up'.length, sql.indexOf('-- migrate:down'));
    })();

    // Inside a transaction that is rolled back: the migration is global, and
    // other suites' deliberately stranded controls share this database.
    const runner = dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    // Its own rows only. `comms.strandedByRawWrite` is the control two tests
    // up, still stranded because nothing re-opened it.
    const cases = [
      comms.strandedByRawWrite,
      comms.complete,
      comms.deletedOnly,
      comms.viaTombstone,
      events.placeFirst,
      events.strandedByRawWrite,
    ];
    const versions = async () => {
      const rows: Array<{ entity_id: string; stage_version: number }> = await runner.query(
        `SELECT entity_id, stage_version FROM ci.pipeline_state
          WHERE stage IN ($1, $2) AND entity_id = ANY($3::uuid[])`,
        [PROMOTE_EDGE_COMMUNICATION_STAGE_ID, PROMOTE_EDGE_EVENT_STAGE_ID, cases],
      );

      return Object.fromEntries(rows.map((row) => [row.entity_id, row.stage_version]));
    };

    const expected = {
      [comms.strandedByRawWrite]: 0,
      [comms.complete]: PROMOTE_EDGE_COMMUNICATION_VERSION,
      [comms.deletedOnly]: PROMOTE_EDGE_COMMUNICATION_VERSION,
      [comms.viaTombstone]: PROMOTE_EDGE_COMMUNICATION_VERSION,
      [events.placeFirst]: PROMOTE_EDGE_EVENT_VERSION,
      [events.strandedByRawWrite]: 0,
    };

    try {
      await runner.query(up);

      expect(await versions()).toEqual(expected);

      // Idempotent: a second run over the same state changes nothing.
      await runner.query(up);

      expect(await versions()).toEqual(expected);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
