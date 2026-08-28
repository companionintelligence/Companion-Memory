import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import { GraphDeltaWriter } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { DerivedRelationshipService } from '../DerivedRelationshipService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLAIMS THAT LET THIS LEG RUN ON A TIMER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DerivationCron` schedules `derive_relationships` nightly, unattended, for
 * every onboarded user. That is only defensible if these are true of the SQL,
 * and none of them can be checked against a mocked DataSource:
 *
 *  1. **The aggregate legs are idempotent.** A nightly job that writes every
 *     night is a leak with a schedule. `relationships_unique_directed_idx` plus
 *     the before/after comparison in the conflict action's `WHERE` is what
 *     makes the second run a no-op, and that index is a property of the live
 *     schema, not of the service.
 *  2. **A re-derive actually re-weights.** The COMMUNICATES_WITH strength comes
 *     off `ci.communications`, and an edge derived last month has to pick up
 *     this month's evidence — `ON CONFLICT DO NOTHING` would have frozen every
 *     existing edge at whatever the first pass wrote.
 *  3. **It re-weights only what it owns.** The same unique index arbitrates a
 *     COMMUNICATES_WITH edge another producer wrote; only the provenance
 *     predicate on the `DO UPDATE` keeps that row and its properties intact.
 *  4. **The household leg is genuinely withheld.** The trust dial decides
 *     whether a `Group` entity may be MINTED (`DerivationRunListener` asks
 *     `decideAction({ kind: 'graph_entity' })`), and the option it passes has
 *     to actually stop the INSERT — not merely stop counting it.
 *
 * The case that guards against over-correcting: with the option at its default
 * the household leg must still work, because the operator-invoked HTTP path and
 * the orchestrator leg both rely on it and neither has changed.
 *
 * Fixtures are COMMITTED rather than wrapped in an outer transaction: the
 * service calls `dataSource.transaction()`, which takes its own connection from
 * the pool and could not see an uncommitted outer transaction's rows. Teardown
 * deletes them by owner.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/DerivedRelationshipService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

describeWithDatabase(`DerivedRelationshipService against the live schema (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: DerivedRelationshipService;

  const userId = randomUUID();
  /** The appliance owner's own Person entity — `ci.users.entity_id`. */
  const owner = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const home = randomUUID();
  const cafe = randomUUID();
  const gym = randomUUID();
  /** Two people with ONE episodic link kind and a lot of traffic. */
  const carol = randomUUID();
  const dave = randomUUID();
  /** Two people with the SAME one link kind and a single message. */
  const erin = randomUUID();
  const frank = randomUUID();
  /** A pair whose COMMUNICATES_WITH edge another producer already owns. */
  const gina = randomUUID();
  const harry = randomUUID();

  /** The pair key the aggregate normalises to — LEAST/GREATEST, not argument order. */
  const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

  /** Every `ci.relationships` row this user owns, as a stable comparable set. */
  const relationshipRows = async (): Promise<Array<Record<string, unknown>>> =>
    (await dataSource.query(
      `SELECT from_entity_id, to_entity_id, relationship_type, strength, is_active
         FROM ci.relationships
        WHERE owner_user_id = $1
        ORDER BY relationship_type, from_entity_id, to_entity_id`,
      [userId],
    )) as Array<Record<string, unknown>>;

  /** The derived COMMUNICATES_WITH edge for one unordered pair, or undefined. */
  const communicatesEdge = async (
    x: string,
    y: string,
  ): Promise<{ strength: number; properties: Record<string, unknown> } | undefined> => {
    const [a, b] = pair(x, y);
    const [row] = (await dataSource.query(
      `SELECT strength, properties FROM ci.relationships
        WHERE owner_user_id = $1 AND relationship_type = 'COMMUNICATES_WITH'
          AND from_entity_id = $2::uuid AND to_entity_id = $3::uuid`,
      [userId, a, b],
    )) as Array<{ strength: number; properties: Record<string, unknown> }>;

    return row;
  };

  /**
   * `count` email rows naming both people, plus the `ci.entities` rows the
   * `communications_id_entities_fk` FK requires. One statement, so the
   * DEFERRABLE FK resolves at commit.
   */
  const insertCommunications = async (
    from: string,
    to: string,
    count: number,
    startIso: string,
  ): Promise<void> => {
    await dataSource.query(
      `WITH ids AS (
         SELECT gen_random_uuid() AS id, g AS n FROM generate_series(1, $4::int) g
       ),
       ents AS (
         INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, is_active)
         SELECT id, 'Communication', 'fixture message', $1::uuid, TRUE FROM ids
         RETURNING entity_id
       )
       INSERT INTO ci.communications
         (id, time, user_id, communication_type, direction, from_entity_id, to_entity_ids, content, entity_type)
       SELECT id, $5::timestamptz + (n * INTERVAL '1 minute'), $1::uuid, 'email', 'outbound',
              $2::uuid, ARRAY[$3::uuid], 'fixture body', 'Communication'
         FROM ids`,
      [userId, from, to, count, startIso],
    );
  };

  const deltaRows = async (
    relationshipType: string,
  ): Promise<Array<{ change_type: string; changed_fields: Record<string, unknown>; to_entity_id: string }>> =>
    (await dataSource.query(
      `SELECT change_type, changed_fields, to_entity_id
         FROM ci.graph_deltas
        WHERE owner_user_id = $1 AND relationship_type = $2 AND change_source = 'DerivedRelationshipService'
        ORDER BY delta_id`,
      [userId, relationshipType],
    )) as Array<{ change_type: string; changed_fields: Record<string, unknown>; to_entity_id: string }>;

  const groupCount = async (): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci.entities WHERE owner_user_id = $1 AND entity_type = 'Group'`,
      [userId],
    )) as Array<{ count: number }>;

    return row.count;
  };

  const deltaCount = async (relationshipType: string): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT COUNT(*)::int AS count
         FROM ci.graph_deltas
        WHERE owner_user_id = $1 AND relationship_type = $2 AND change_source = 'DerivedRelationshipService'`,
      [userId, relationshipType],
    )) as Array<{ count: number }>;

    return row.count;
  };

  beforeAll(async () => {
    const connection = resolveConnection();

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

    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params as unknown[]),
      'DerivedRelationship',
      userId,
    );

    // The owner plus two people, a home, a café and a gym. Names are irrelevant
    // to the SQL; the entity ROWS have to exist because the aggregates read
    // entity ids that the household leg then joins back to `ci.entities`.
    for (const [entityId, entityType, name] of [
      [owner, 'Person', 'Owner'],
      [alice, 'Person', 'Alice'],
      [bob, 'Person', 'Bob'],
      [carol, 'Person', 'Carol'],
      [dave, 'Person', 'Dave'],
      [erin, 'Person', 'Erin'],
      [frank, 'Person', 'Frank'],
      [gina, 'Person', 'Gina'],
      [harry, 'Person', 'Harry'],
      [home, 'Location', 'Home'],
      [cafe, 'Location', 'Café'],
      [gym, 'Location', 'Gym'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, is_active)
              VALUES ($1::uuid, $2, $3, $4::uuid, TRUE)
         ON CONFLICT (entity_id) DO NOTHING`,
        [entityId, entityType, name, userId],
      );
    }

    // The account anchor every VISITED edge starts from. Without it the
    // FREQUENTS leg has nothing to attribute the owner's position fixes to.
    await dataSource.query(`UPDATE ci.users SET entity_id = $2::uuid WHERE id = $1::uuid`, [userId, owner]);

    // ── The episodic history the aggregates summarise ────────────────────
    //
    // Three DISTINCT (direction, type) links between the same pair, plus two
    // more EMAILED rows for that same pair which `relationships_unique_directed_idx`
    // (UNIQUE on (from, to, type) WHERE is_active) silently collapses. That
    // collapse is the point: it is why the COMMUNICATES_WITH aggregate counts
    // link KINDS and can never count emails. Then the owner's two VISITED edges
    // (café and gym, told apart only by the position evidence below), a
    // repeated VISITED from a person who is NOT the owner, and the LIVES_WITH +
    // shared LIVES_IN pair the household cluster reads.
    const episodes: Array<[string, string, string, string, string]> = [
      [alice, bob, 'EMAILED', 'Person', 'Person'],
      [alice, bob, 'EMAILED', 'Person', 'Person'],
      [alice, bob, 'EMAILED', 'Person', 'Person'],
      [alice, bob, 'MESSAGED', 'Person', 'Person'],
      [bob, alice, 'CALLED', 'Person', 'Person'],
      [owner, cafe, 'VISITED', 'Person', 'Location'],
      [owner, gym, 'VISITED', 'Person', 'Location'],
      [alice, cafe, 'VISITED', 'Person', 'Location'],
      [alice, cafe, 'VISITED', 'Person', 'Location'],
      [alice, cafe, 'VISITED', 'Person', 'Location'],
      [alice, bob, 'LIVES_WITH', 'Person', 'Person'],
      [alice, home, 'LIVES_IN', 'Person', 'Location'],
      [bob, home, 'LIVES_IN', 'Person', 'Location'],
      // Three pairs with IDENTICAL episodic evidence — one EMAILED row each.
      // Under the old formula all three scored LN(2)/LN(10)/2 ≈ 0.1505 and
      // nothing about the corpus could move them apart.
      [carol, dave, 'EMAILED', 'Person', 'Person'],
      [erin, frank, 'EMAILED', 'Person', 'Person'],
      [gina, harry, 'EMAILED', 'Person', 'Person'],
    ];

    for (const [from, to, type, fromType, toType] of episodes) {
      await dataSource.query(
        `INSERT INTO ci.relationships
           (from_entity_id, to_entity_id, relationship_type, strength, properties,
            owner_user_id, from_entity_type, to_entity_type, is_bidirectional, is_active)
         VALUES ($1::uuid, $2::uuid, $3, 1.0, '{}'::jsonb, $4::uuid, $5, $6, FALSE, TRUE)
         ON CONFLICT DO NOTHING`,
        [from, to, type, userId, fromType, toType],
      );
    }

    // ── The telemetry the visit counts are read from ─────────────────────
    //
    // Café: three fixes on three separate days. Gym: FIVE fixes, all inside one
    // afternoon — more rows than the café and still a single day, which is the
    // difference between "goes there" and "was there once for a while".
    const fixes: Array<[string, string]> = [
      ['2026-03-01T09:00:00Z', cafe],
      ['2026-03-02T09:05:00Z', cafe],
      ['2026-03-03T09:10:00Z', cafe],
      ['2026-03-04T17:00:00Z', gym],
      ['2026-03-04T17:15:00Z', gym],
      ['2026-03-04T17:30:00Z', gym],
      ['2026-03-04T17:45:00Z', gym],
      ['2026-03-04T18:00:00Z', gym],
    ];

    for (const [time, placeId] of fixes) {
      await dataSource.query(
        `INSERT INTO ci.position (time, user_id, source, location, location_entity_id)
              VALUES ($1::timestamptz, $2::uuid, 'gps', ST_SetSRID(ST_MakePoint(0, 0), 4326), $3::uuid)`,
        [time, userId, placeId],
      );
    }

    // ── The evidence the WEIGHT is read from ─────────────────────────────
    //
    // Carol and Dave traded 120 messages, in both directions — a pair is
    // unordered, so 70 one way and 50 the other has to come out as 120, not as
    // two separate figures. Erin and Frank exchanged exactly one. Alice and Bob
    // have none at all: their three link kinds are all the evidence there is,
    // and the floor is what keeps that edge where it already was.
    await insertCommunications(carol, dave, 70, '2026-03-01T00:00:00Z');
    await insertCommunications(dave, carol, 50, '2026-03-02T00:00:00Z');
    await insertCommunications(erin, frank, 1, '2026-03-01T00:00:00Z');

    // Gina and Harry already have a COMMUNICATES_WITH edge somebody else owns.
    // The derivation must leave it — and its properties — exactly as it stands.
    const [ginaFirst, harrySecond] = pair(gina, harry);

    await dataSource.query(
      `INSERT INTO ci.relationships
         (from_entity_id, to_entity_id, relationship_type, strength, properties,
          owner_user_id, from_entity_type, to_entity_type, is_bidirectional, is_active)
       VALUES ($1::uuid, $2::uuid, 'COMMUNICATES_WITH', 0.99,
               jsonb_build_object(
                 'layer', 'L1',
                 'curated_note', 'set by a human',
                 'provenance', jsonb_build_object('source', 'SomeOtherProducer')
               ),
               $3::uuid, 'Person', 'Person', TRUE, TRUE)`,
      [ginaFirst, harrySecond, userId],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.position WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [userId]);
      // ci.users.entity_id has no ON DELETE action, so the anchor has to be
      // released before the entity it points at can go.
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  beforeAll(() => {
    service = new DerivedRelationshipService(
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
      noopLogger,
    );
  });

  it('projects the aggregates and WITHHOLDS the household Group when the option is false', async () => {
    const result = await service.derive(userId, { reifyHouseholdGroups: false });

    // Three pairs, not four: gina↔harry already carries an edge another
    // producer owns, and the derivation declines to touch it or to claim it.
    expect(result.communicatesWith).toBe(3);
    expect(result.frequents).toBe(1);
    expect(result.householdReification).toBe('withheld');
    expect(result.groupsReified).toBe(0);

    // The claim that matters: nothing was MINTED. A `groupsReified: 0` that
    // still inserted a Group would pass a counter assertion and fail the user.
    expect(await groupCount()).toBe(0);

    const edge = await communicatesEdge(alice, bob);

    // Three DISTINCT link kinds, not five rows: the two extra EMAILED inserts
    // above collapsed on the unique index and bought this pair nothing. That
    // count is still recorded, under the name that says what it is — but with
    // no `ci.communications` evidence for the pair it is now only the FLOOR
    // under the weight, which is what keeps this edge exactly where it was.
    expect(edge?.properties.episodic_link_kinds).toBe(3);
    expect(edge?.properties.communications_exchanged).toBe(0);
    expect(edge?.strength).toBeCloseTo(Math.log10(4) / 2, 6);
    expect(edge?.properties.layer).toBe('L2');
    expect(await deltaCount('COMMUNICATES_WITH')).toBe(3);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE DEFECT THIS LEG EXISTED WITH.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Carol↔Dave and Erin↔Frank have IDENTICAL episodic evidence: one EMAILED
   * row each. `relationships_unique_directed_idx` guarantees it can never be
   * more than that no matter how much they exchanged, so a weight derived from
   * `ci.relationships` gave both pairs the same number — 120 messages and 1
   * message, indistinguishable.
   *
   * The volume comes off `ci.communications` instead, counted in BOTH
   * directions into one figure, and the two pairs now separate.
   */
  it('weights a pair by the communications between them, in either direction', async () => {
    const busy = await communicatesEdge(carol, dave);
    const quiet = await communicatesEdge(erin, frank);

    // The headline: 120 messages must not weigh the same as 1.
    expect(busy!.strength).toBeGreaterThan(quiet!.strength + 0.3);

    // 70 carol→dave plus 50 dave→carol. A pair is unordered.
    expect(busy?.properties.communications_exchanged).toBe(120);
    expect(quiet?.properties.communications_exchanged).toBe(1);

    // Both pairs still have exactly one link kind — the ONLY thing that moved
    // them apart is the evidence.
    expect(busy?.properties.episodic_link_kinds).toBe(1);
    expect(quiet?.properties.episodic_link_kinds).toBe(1);

    expect(busy?.strength).toBeCloseTo(Math.log(121) / Math.log(10_000), 6);
    // One message does not out-weigh the pair's own link-kind floor.
    expect(quiet?.strength).toBeCloseTo(Math.log10(2) / 2, 6);
  });

  /**
   * The pair whose edge the derivation does NOT own. `ON CONFLICT DO UPDATE`
   * fires on the same unique index for this row as for its own, so the only
   * thing standing between another producer's edge and a silent overwrite is
   * the provenance predicate on the DO UPDATE — and a predicate is exactly the
   * kind of clause that survives a refactor by not being tested.
   */
  it('leaves a COMMUNICATES_WITH edge another producer owns completely alone', async () => {
    const foreign = await communicatesEdge(gina, harry);

    expect(foreign?.strength).toBe(0.99);
    expect(foreign?.properties.layer).toBe('L1');
    expect(foreign?.properties.curated_note).toBe('set by a human');
    expect(foreign?.properties.communications_exchanged).toBeUndefined();
  });

  /**
   * The repeat-visit count CANNOT come from `ci.relationships`, and that is a
   * property of the live schema this spec exists to hold onto:
   * `relationships_unique_directed_idx` is UNIQUE on (from, to, type) WHERE
   * is_active, so the three `alice -VISITED→ café` inserts above collapse to
   * ONE row. An aggregate over those rows counts 1 for every pair there is —
   * which is exactly why this leg used to be a scheduled no-op.
   *
   * It counts `ci.position` days instead: the fixes whose `location_entity_id`
   * snapped to the place, which is the same evidence the VISITED edge itself
   * was projected from.
   */
  it('derives FREQUENTS from repeat visit DAYS in ci.position, not from duplicate VISITED rows', async () => {
    const [visited] = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci.relationships
        WHERE owner_user_id = $1 AND to_entity_id = $2 AND relationship_type = 'VISITED' AND is_active = TRUE`,
      [userId, cafe],
    )) as Array<{ count: number }>;

    // Two: the owner's and alice's. Her three inserts are one surviving row.
    expect(visited.count).toBe(2);

    const edges = (await dataSource.query(
      `SELECT from_entity_id, to_entity_id, strength, properties
         FROM ci.relationships
        WHERE owner_user_id = $1 AND relationship_type = 'FREQUENTS'`,
      [userId],
    )) as Array<{
      from_entity_id: string;
      to_entity_id: string;
      strength: number;
      properties: Record<string, unknown>;
    }>;

    // The café only, from the OWNER. Alice's repeated VISITED row buys nothing:
    // ci.position is the owner's telemetry, so it cannot evidence her visits.
    expect(edges).toHaveLength(1);
    expect(edges[0].from_entity_id).toBe(owner);
    expect(edges[0].to_entity_id).toBe(cafe);
    expect(edges[0].properties.visit_days).toBe(3);
    expect(edges[0].strength).toBeCloseTo(Math.log10(4) / 2, 6);
    expect(await deltaCount('FREQUENTS')).toBe(1);

    // And the gym is NOT one: five fixes, all on one afternoon.
    expect(edges.some((edge) => edge.to_entity_id === gym)).toBe(false);
  });

  it('is idempotent: a second pass writes nothing and leaves every row identical', async () => {
    const before = await relationshipRows();

    const result = await service.derive(userId, { reifyHouseholdGroups: false });

    expect(result).toEqual({
      communicatesWith: 0,
      frequents: 0,
      groupsReified: 0,
      householdReification: 'withheld',
    });
    expect(await relationshipRows()).toEqual(before);
    // No second delta either. `DO UPDATE` alone would have re-written all three
    // edges with the values they already held and announced each one; the
    // before/after comparison in the conflict action's WHERE is what keeps a
    // nightly re-derive silent when nothing moved.
    expect(await deltaCount('COMMUNICATES_WITH')).toBe(3);
  });

  it('still reifies the household when the caller is an operator (option defaulted)', async () => {
    const result = await service.derive(userId);

    expect(result.householdReification).toBe('applied');
    expect(result.groupsReified).toBe(1);
    expect(await groupCount()).toBe(1);

    const members = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci.relationships
        WHERE owner_user_id = $1 AND relationship_type = 'MEMBER_OF'`,
      [userId],
    )) as Array<{ count: number }>;

    expect(members[0].count).toBe(2);

    // And that path is idempotent too — the household leg keys on
    // (linked_table, linked_id), not on a fresh uuid per run.
    const second = await service.derive(userId);

    expect(second.groupsReified).toBe(0);
    expect(await groupCount()).toBe(1);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * A WEIGHT NOBODY CAN RE-DERIVE IS A CONSTANT.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Under `ON CONFLICT DO NOTHING` every edge kept the strength of the pass
   * that first created it, forever: a year of further correspondence changed
   * nothing, and no fix to the formula could ever reach a row that already
   * existed. This is the case that proves the conflict action actually writes.
   *
   * It also proves what it does NOT write. The row picks up a key the
   * derivation has never heard of before the re-derive; a `properties =
   * EXCLUDED.properties` would take that key with it.
   */
  it('re-derives an existing edge: strength follows the new evidence, foreign keys survive', async () => {
    const [carolFirst, daveSecond] = pair(carol, dave);

    await dataSource.query(
      `UPDATE ci.relationships
          SET properties = properties || jsonb_build_object('user_pinned', TRUE)
        WHERE owner_user_id = $1 AND relationship_type = 'COMMUNICATES_WITH'
          AND from_entity_id = $2::uuid AND to_entity_id = $3::uuid`,
      [userId, carolFirst, daveSecond],
    );

    const stale = await communicatesEdge(carol, dave);
    const deltasBefore = await deltaRows('COMMUNICATES_WITH');

    // 880 more, taking the pair from 120 to 1,000.
    await insertCommunications(carol, dave, 880, '2026-04-01T00:00:00Z');

    const result = await service.derive(userId, { reifyHouseholdGroups: false });

    expect(result.communicatesWith).toBe(1);

    const fresh = await communicatesEdge(carol, dave);

    expect(fresh?.properties.communications_exchanged).toBe(1_000);
    expect(fresh?.strength).toBeCloseTo(Math.log(1_001) / Math.log(10_000), 6);
    expect(fresh!.strength).toBeGreaterThan(stale!.strength);

    // The key the derivation does not own is still there.
    expect(fresh?.properties.user_pinned).toBe(true);
    expect(fresh?.properties.layer).toBe('L2');

    // And the change is observable: one new delta, typed `updated` rather than
    // `created`, carrying the move.
    const deltasAfter = await deltaRows('COMMUNICATES_WITH');

    expect(deltasAfter).toHaveLength(deltasBefore.length + 1);

    const delta = deltasAfter[deltasAfter.length - 1];

    expect(delta.change_type).toBe('updated');
    expect(delta.to_entity_id).toBe(daveSecond);
    expect(delta.changed_fields).toEqual({
      strength: { old: stale!.strength, new: fresh!.strength },
    });
  });
});
