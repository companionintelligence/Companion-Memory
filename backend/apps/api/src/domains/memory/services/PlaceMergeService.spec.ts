import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';

import { PlaceEntity } from '../entities/PlaceEntity';

import { RELATIONSHIP_COLUMNS } from './mergeEdgeSweep';
import { PlaceMergeService } from './PlaceMergeService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const TARGET = '00000000-0000-0000-0000-0000000000b1';
const SOURCE_A = '00000000-0000-0000-0000-0000000000c1';
const SOURCE_B = '00000000-0000-0000-0000-0000000000c2';
const CITY = '00000000-0000-0000-0000-0000000000e1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

interface LocationRow {
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  merged_into_entity_id: string | null;
  parent_place_id: string | null;
  place_kind: string | null;
  has_point: boolean;
  has_boundary: boolean;
}

function locationRow(id: string, overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    entity_id: id,
    entity_type: 'Location',
    name: null,
    description: null,
    properties: {},
    merged_into_entity_id: null,
    parent_place_id: null,
    place_kind: null,
    has_point: true,
    has_boundary: false,
    ...overrides,
  };
}

/** One edge a sweep reports having moved onto the target, as the sweep statement returns it. */
interface RescuedRow {
  relationship_id: string;
  relationship_type: string;
  from_entity_id: string;
  to_entity_id: string;
  was: string;
}

/** What one sweep statement answers: the rows its DELETE removed, and the ones its INSERT put back. */
interface SweepAnswer {
  deleted: number;
  rescued: RescuedRow[];
}

interface Harness {
  service: PlaceMergeService;
  statements: Array<{ sql: string; params: unknown[] | undefined }>;
  send: jest.Mock;
  recordMany: jest.Mock;
}

/**
 * Rows each counting write "touched", keyed by a fragment of its statement —
 * distinct values, so a count wired to the wrong field shows up as a wrong
 * number rather than an equal one.
 */
const REPOINTED: Array<[fragment: string, count: number]> = [
  ['UPDATE ci.events SET location_entity_id', 2],
  ['UPDATE ci.position SET location_entity_id', 3],
  ['UPDATE ci.position SET reference_entity_id', 5],
  ['SET parent_place_id = $3', 7],
  ['UPDATE ci.objects SET last_seen_place_entity_id', 11],
  ['UPDATE ci.objects SET acquired_from_entity_id', 13],
  ['UPDATE ci.object_observations SET place_entity_id', 17],
  ['UPDATE ci.receipts SET place_entity_id', 19],
  ['UPDATE ci.receipts SET merchant_entity_id', 23],
  ['UPDATE ci.entity_identifiers SET entity_id', 29],
  ['UPDATE ci.relationships r SET from_entity_id', 31],
  ['UPDATE ci.relationships r SET to_entity_id', 37],
  ['DELETE FROM ci_search.embeddings', 41],
  ['DELETE FROM ci_search.vectors', 43],
  ['UPDATE ci_search.entity_tag', 47],
];

/** The self-reference DELETE, then the two sweeps (from, then to) — in the order the merge issues them. They sum to relationshipsDropped. */
const DROPPED_SELF_REFERENCES = 1;
const SWEPT: SweepAnswer[] = [
  { deleted: 2, rescued: [] },
  { deleted: 4, rescued: [] },
];

const EXPECTED_COUNTS = {
  events: 2,
  positions: 3 + 5,
  childPlaces: 7,
  objects: 11 + 13,
  observations: 17,
  receipts: 19 + 23,
  identifiers: 29,
  relationshipsFrom: 31,
  relationshipsTo: 37,
  relationshipsDropped: 1 + 2 + 4,
  relationshipsRescued: 0,
  searchRowsDeleted: 41 + 43,
  tagLinksMoved: 47,
};

function makeHarness(
  entityRows: LocationRow[],
  ancestorsOfTarget: string[] = [],
  swept: Array<SweepAnswer | 'wrong-shape'> = SWEPT,
): Harness {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const sweeps = [...swept];

  // Answers each statement the way TypeORM's Postgres runner does, so this
  // mock cannot flatter the service: a SELECT — which is what a counting CTE
  // is — gets rows, while a bare UPDATE/DELETE gets the PAIR [rows, rowCount].
  // Every count used to be `….length` of that pair, a constant in production;
  // a statement that loses its CTE wrapper now makes countAffected throw here
  // too.
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });

    if (sql.includes('FROM ci.entities') && sql.includes('FOR UPDATE')) {
      const requested = (params?.[1] as string[]) ?? [];

      return entityRows.filter((row) => requested.includes(row.entity_id));
    }

    if (sql.includes('WITH RECURSIVE up AS')) {
      const sources = (params?.[2] as string[]) ?? [];

      return ancestorsOfTarget.filter((id) => sources.includes(id)).map((entity_id) => ({ entity_id }));
    }

    // A sweep ends in a plain SELECT, so the driver hands its one row back as is.
    if (sql.includes('WITH gone AS (')) {
      const answer = sweeps.shift() ?? { deleted: 0, rescued: [] };

      // What a statement whose OUTER command is a DELETE would get back.
      if (answer === 'wrong-shape') {
        return [[], 0];
      }

      return [{ deleted: answer.deleted, rescued: answer.rescued }];
    }

    if (/SELECT count\(\*\)::int AS count FROM/.test(sql)) {
      const count = sql.includes('DELETE FROM ci.relationships')
        ? DROPPED_SELF_REFERENCES
        : REPOINTED.find(([fragment]) => sql.includes(fragment))?.[1];

      return [{ count: count ?? 0 }];
    }

    if (/^\s*(UPDATE|DELETE)\b/.test(sql)) {
      return [[], 0];
    }

    return [];
  });

  const manager = {
    query,
    transaction: jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => cb({ query })),
  };

  const findOne = jest.fn(async () =>
    Object.assign(new PlaceEntity(), {
      id: TARGET,
      entityType: 'Location',
      properties: {},
      mergedIntoEntityId: null,
    }),
  );

  const repository = { manager, findOne };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const send = jest.fn(async () => []);
  const recordMany = jest.fn(async () => undefined);

  const service = new PlaceMergeService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany,
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  return { service, statements, send, recordMany };
}

function statementsMatching(harness: Harness, fragment: string) {
  return harness.statements.filter(({ sql }) => sql.includes(fragment));
}

describe('PlaceMergeService', () => {
  it('rejects a merge with no sources distinct from the target', async () => {
    const harness = makeHarness([locationRow(TARGET)]);

    await expect(harness.service.mergePlaces(CONTEXT, [TARGET], TARGET)).rejects.toThrow(BadRequestException);
  });

  it('rejects a missing target', async () => {
    const harness = makeHarness([locationRow(SOURCE_A)]);

    await expect(harness.service.mergePlaces(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(NotFoundException);
  });

  it('rejects a non-Location source', async () => {
    const harness = makeHarness([locationRow(TARGET), locationRow(SOURCE_A, { entity_type: 'Person' })]);

    await expect(harness.service.mergePlaces(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an already-merged source (tombstone)', async () => {
    const harness = makeHarness([
      locationRow(TARGET),
      locationRow(SOURCE_A, { merged_into_entity_id: SOURCE_B }),
    ]);

    await expect(harness.service.mergePlaces(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses to fold an ancestor (the city a street sits in) into its descendant', async () => {
    const harness = makeHarness([locationRow(TARGET, { parent_place_id: CITY }), locationRow(CITY)], [CITY]);

    await expect(harness.service.mergePlaces(CONTEXT, [CITY], TARGET)).rejects.toThrow(/contains/i);
    expect(statementsMatching(harness, 'UPDATE ci.events SET location_entity_id')).toHaveLength(0);
  });

  it('re-points every place-bearing column, folds the row, tombstones the sources, and audits', async () => {
    const harness = makeHarness([
      locationRow(TARGET, {
        name: '61 Plantation, Irvine, CA, United States',
        properties: { source: 'reverse_geocode', lat: 33.695, lng: -117.748 },
        has_point: true,
        has_boundary: false,
        place_kind: 'address',
      }),
      locationRow(SOURCE_A, {
        name: '61 Plantation, Irvine, CA, United States',
        description: 'Home',
        properties: { source: 'reverse_geocode', place_id: 'ChIJabc', lat: 33.695, lng: -117.749 },
        has_point: true,
        has_boundary: true,
        parent_place_id: CITY,
      }),
      locationRow(SOURCE_B, { has_point: false }),
    ]);

    const result = await harness.service.mergePlaces(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    expect(result.target.id).toBe(TARGET);
    // The payload reports what the statements touched, per field.
    expect(result.counts).toEqual(EXPECTED_COUNTS);

    // Hypertable decompression cap lifted inside the txn.
    expect(statementsMatching(harness, 'max_tuples_decompressed_per_dml_transaction')).toHaveLength(1);

    // One owner-scoped re-point per dependent column.
    for (const fragment of [
      'UPDATE ci.events SET location_entity_id',
      'UPDATE ci.position SET location_entity_id',
      'UPDATE ci.position SET reference_entity_id',
      'UPDATE ci.objects SET last_seen_place_entity_id',
      'UPDATE ci.objects SET acquired_from_entity_id',
      'UPDATE ci.object_observations SET place_entity_id',
      'UPDATE ci.receipts SET place_entity_id',
      'UPDATE ci.receipts SET merchant_entity_id',
      'UPDATE ci.entity_identifiers SET entity_id',
    ]) {
      const matches = statementsMatching(harness, fragment);
      expect(matches).toHaveLength(1);
      expect(matches[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);
    }

    // Children of a source move under the target — but never the target itself.
    const children = statementsMatching(harness, 'SET parent_place_id = $3');
    expect(children).toHaveLength(1);
    expect(children[0].sql).toContain('entity_id <> $3');

    // Relationships (known-places edges): self-reference cleanup, guarded
    // re-points, then the two sweeps (each one a DELETE, so three in all).
    expect(statementsMatching(harness, 'DELETE FROM ci.relationships')).toHaveLength(3);
    expect(statementsMatching(harness, 'UPDATE ci.relationships r SET from_entity_id')).toHaveLength(1);
    expect(statementsMatching(harness, 'UPDATE ci.relationships r SET to_entity_id')).toHaveLength(1);

    // Fold: target keeps its name and provenance; the description, the
    // provider place_id, the parent and the boundary fill from the source.
    const fold = statementsMatching(harness, 'properties = $5::jsonb');
    expect(fold).toHaveLength(1);
    const [, , name, description, propertiesJson, kind, parent, pointDonor, boundaryDonor] =
      fold[0].params ?? [];
    expect(name).toBe('61 Plantation, Irvine, CA, United States');
    expect(description).toBe('Home');
    const folded = JSON.parse(propertiesJson as string) as Record<string, unknown>;
    expect(folded.place_id).toBe('ChIJabc');
    expect(folded.lng).toBe(-117.748); // target wins the scalar it already had
    expect(kind).toBe('address');
    expect(parent).toBe(CITY);
    expect(pointDonor).toBeNull(); // target already has a point
    expect(boundaryDonor).toBe(SOURCE_A); // first source with a boundary

    // Sources tombstoned, chain compressed, search rows gone from both stores, tags moved.
    const tombstone = statementsMatching(harness, 'is_active = FALSE');
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);
    expect(
      statementsMatching(harness, 'WHERE owner_user_id = $1 AND merged_into_entity_id = ANY($2::uuid[])'),
    ).toHaveLength(1);
    expect(statementsMatching(harness, 'DELETE FROM ci_search.embeddings')).toHaveLength(1);
    expect(statementsMatching(harness, 'DELETE FROM ci_search.vectors')).toHaveLength(1);
    const tagMove = statementsMatching(harness, 'UPDATE ci_search.entity_tag');
    expect(tagMove).toHaveLength(1);
    expect(tagMove[0].sql).toContain(`entity_type = 'place'`);
    expect(statementsMatching(harness, 'DELETE FROM ci_search.entity_tag')).toHaveLength(1);

    // One audit row per source, typed Location, carrying the same counts.
    const audits = statementsMatching(harness, 'INSERT INTO ci.entity_merges');
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.params?.[1])).toEqual([SOURCE_A, SOURCE_B]);
    expect(audits[0].params?.[3]).toBe('Location');
    for (const audit of audits) {
      const details = JSON.parse(audit.params?.[4] as string) as { counts: unknown };
      expect(details.counts).toEqual(EXPECTED_COUNTS);
    }

    // The target re-indexes after commit.
    expect(harness.send).toHaveBeenCalledWith('place.updated', { placeId: TARGET });
  });

  it('sweeps what the guarded re-points left only AFTER both of them, putting each edge back on the target rather than dropping it', async () => {
    const harness = makeHarness([locationRow(TARGET), locationRow(SOURCE_A), locationRow(SOURCE_B)]);

    await harness.service.mergePlaces(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    const order = harness.statements.map(({ sql }) => sql);
    const sweeps = harness.statements.filter(({ sql }) => sql.includes('WITH gone AS ('));
    expect(sweeps).toHaveLength(2);

    // There is no plain DELETE of the leftovers any more: the one DELETE that is
    // not a sweep is the self-reference drop, and it reports `RETURNING 1`.
    // A statement that only deletes is the shape that lost the edges.
    const deletes = statementsMatching(harness, 'DELETE FROM ci.relationships').filter(
      ({ sql }) => !sql.includes('WITH gone AS ('),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toContain('RETURNING 1');

    // The re-points are the long statements and the sweeps the short ones, so
    // the sweeps go last: a sweep's snapshot is the one that decides what a
    // concurrent commit can still slip past, and it should be as late as it can be.
    const selfReferences = order.indexOf(deletes[0].sql);
    const fromRepoint = order.findIndex((sql) =>
      sql.includes('UPDATE ci.relationships r SET from_entity_id'),
    );
    const toRepoint = order.findIndex((sql) => sql.includes('UPDATE ci.relationships r SET to_entity_id'));
    expect(selfReferences).toBeLessThan(fromRepoint);
    expect(fromRepoint).toBeLessThan(toRepoint);
    expect(toRepoint).toBeLessThan(order.indexOf(sweeps[0].sql));
    expect(order.indexOf(sweeps[0].sql)).toBeLessThan(order.indexOf(sweeps[1].sql));

    for (const sweep of sweeps) {
      expect(sweep.params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);
    }

    // The first sweep covers the FROM end, the second the TO end — and each one
    // hands every column of the edge from its DELETE to its INSERT.
    const [from, to] = sweeps.map(({ sql }) => sql.replace(/\s+/g, ' '));
    const columns = RELATIONSHIP_COLUMNS.join(', ');

    expect(from).toContain(
      'WHERE owner_user_id = $1 AND from_entity_id = ANY($2::uuid[]) RETURNING ' + columns,
    );
    expect(to).toContain('WHERE owner_user_id = $1 AND to_entity_id = ANY($2::uuid[]) RETURNING ' + columns);
  });

  it('records one relationship delta per edge a sweep moved, counts them apart from the dropped ones, and says which source it came from', async () => {
    const EVENT_1 = '00000000-0000-0000-0000-0000000000f2';
    const EVENT_2 = '00000000-0000-0000-0000-0000000000f3';
    const PARENT = '00000000-0000-0000-0000-0000000000e2';
    const edge = (id: string, type: string, from: string, to: string, was: string): RescuedRow => ({
      relationship_id: id,
      relationship_type: type,
      from_entity_id: from,
      to_entity_id: to,
      was,
    });
    const E1 = '00000000-0000-0000-0000-00000000ee01';
    const E2 = '00000000-0000-0000-0000-00000000ee02';
    const E3 = '00000000-0000-0000-0000-00000000ee03';

    const harness = makeHarness(
      [locationRow(TARGET), locationRow(SOURCE_A), locationRow(SOURCE_B)],
      [],
      [
        // One row deleted, one put back: the other end of this sweep is the CHILD place's edge.
        { deleted: 2, rescued: [edge(E3, 'PART_OF', TARGET, PARENT, SOURCE_A)] },
        // Three rows deleted, two put back: one was a duplicate and stays dropped.
        {
          deleted: 3,
          rescued: [
            edge(E1, 'LOCATED_AT', EVENT_1, TARGET, SOURCE_A),
            edge(E2, 'VISITED', EVENT_2, TARGET, SOURCE_B),
          ],
        },
      ],
    );

    await harness.service.mergePlaces(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    const [audit] = statementsMatching(harness, 'INSERT INTO ci.entity_merges');
    const { counts } = JSON.parse(audit.params?.[4] as string) as { counts: Record<string, number> };

    // dropped = the self-reference DELETE's 1 + (2 − 1) + (3 − 2); rescued = 1 + 2.
    expect(counts.relationshipsDropped).toBe(DROPPED_SELF_REFERENCES + 1 + 1);
    expect(counts.relationshipsRescued).toBe(3);
    // The rows the guarded UPDATEs moved are a different number and stay one.
    expect(counts.relationshipsFrom).toBe(31);
    expect(counts.relationshipsTo).toBe(37);

    const relationshipDeltas = harness.recordMany.mock.calls.filter(([inputs]) =>
      inputs.some((input: { nodeType: string }) => input.nodeType === 'relationship'),
    );
    expect(relationshipDeltas).toHaveLength(2);

    const common = {
      nodeType: 'relationship',
      changeType: 'updated',
      ownerUserId: USER,
      changeSource: 'PlaceMergeService.mergePlaces',
      changeReason: 'place_merge.rescued_edge',
      changedByUserId: USER,
    };

    expect(relationshipDeltas[0][0]).toEqual([
      {
        ...common,
        relationshipId: E3,
        relationshipType: 'PART_OF',
        fromEntityId: TARGET,
        toEntityId: PARENT,
        changedFields: { from_entity_id: { old: SOURCE_A, new: TARGET } },
      },
    ]);
    expect(relationshipDeltas[1][0]).toEqual([
      {
        ...common,
        relationshipId: E1,
        relationshipType: 'LOCATED_AT',
        fromEntityId: EVENT_1,
        toEntityId: TARGET,
        changedFields: { to_entity_id: { old: SOURCE_A, new: TARGET } },
      },
      {
        ...common,
        relationshipId: E2,
        relationshipType: 'VISITED',
        fromEntityId: EVENT_2,
        toEntityId: TARGET,
        changedFields: { to_entity_id: { old: SOURCE_B, new: TARGET } },
      },
    ]);

    // In the merge's own transaction, like every other delta the merge writes.
    for (const [, manager] of relationshipDeltas) {
      expect(manager).toEqual(expect.objectContaining({ query: expect.any(Function) }));
    }
  });

  it('writes no relationship delta when the sweeps moved nothing — a plain drop of a duplicate leaves no trail, as before', async () => {
    const harness = makeHarness([locationRow(TARGET), locationRow(SOURCE_A)]);

    await harness.service.mergePlaces(CONTEXT, [SOURCE_A], TARGET);

    for (const [inputs] of harness.recordMany.mock.calls) {
      for (const input of inputs) {
        expect(input.nodeType).toBe('entity');
      }
    }
  });

  it('refuses a sweep answer that is not one { deleted, rescued } row, rather than reading it as "nothing swept"', async () => {
    // A statement whose outer command is a DELETE comes back from TypeORM as
    // [rows, rowCount]; reading that as an empty sweep would let the audit row
    // report zero edges dropped while the merge deleted them.
    const harness = makeHarness([locationRow(TARGET), locationRow(SOURCE_A)], [], ['wrong-shape']);

    await expect(harness.service.mergePlaces(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      /sweepLeftoverEdges expected one \{ deleted, rescued \} row/,
    );
  });
});
