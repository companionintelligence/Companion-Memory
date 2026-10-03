import type { EntityManager } from 'typeorm';

import type { GraphDeltaWriter } from './GraphDeltaWriter';

/**
 * Every column of `ci.relationships`. The sweep re-creates an edge column for
 * column — the DELETE hands the whole row to the INSERT — so a column added to
 * the table has to be added here, or the sweep would quietly reset it to its
 * default. `PersonMergeService.integration.spec.ts` compares this list with the
 * live table and fails when they differ.
 */
export const RELATIONSHIP_COLUMNS = [
  'relationship_id',
  'from_entity_id',
  'to_entity_id',
  'relationship_type',
  'owner_user_id',
  'strength',
  'properties',
  'is_bidirectional',
  'is_active',
  'start_date',
  'end_date',
  'created_at',
  'updated_at',
  'to_entity_type',
  'from_entity_type',
] as const;

/** The end of an edge a merge re-points, and the end that stays where it is. */
const EDGE_ENDS = {
  from: { moved: 'from_entity_id', other: 'to_entity_id' },
  to: { moved: 'to_entity_id', other: 'from_entity_id' },
} as const;

/** Which end of an edge a sweep covers — the end the merged-away entities sit at. */
export type EdgeEnd = keyof typeof EDGE_ENDS;

/** One edge the sweep moved onto the target, as the sweep statement reports it. */
interface RescuedEdge {
  relationship_id: string;
  relationship_type: string;
  from_entity_id: string;
  to_entity_id: string;
  /** The source that held this end of the edge before the sweep. */
  was: string;
}

/** What one merge asks of one sweep. */
export interface EdgeSweep {
  ownerUserId: string;
  /** The entities being merged away. */
  sources: string[];
  /** The survivor. */
  targetId: string;
  /** The end of the edge the sources sit at: `from` sweeps `from_entity_id`, `to` sweeps `to_entity_id`. */
  end: EdgeEnd;
  /** `ci.graph_deltas.change_source` of the delta written for each moved edge, e.g. `PersonMergeService.mergePeople`. */
  changeSource: string;
  /** `ci.graph_deltas.change_reason` of that delta, e.g. `person_merge.rescued_edge`. */
  changeReason: string;
}

/** What a sweep did: the edges it dropped as duplicates or self-references, and the ones it moved onto the target. */
export interface EdgeSweepOutcome {
  dropped: number;
  rescued: number;
}

/**
 * The last statement of a merge about one end of the sources' edges: whatever
 * the guarded UPDATE did not move. In ONE statement it deletes every edge that
 * still holds a source at `end` and puts each one back on the target — same
 * `relationship_id`, same every other column — unless the target already holds
 * that edge or the edge would become a self-reference. Shared by
 * `PersonMergeService` and `PlaceMergeService`, which run it once per end, after
 * BOTH guarded re-points, and add the two outcomes to the merge's audit counts.
 *
 * Why not a bare DELETE. The guarded UPDATEs decline an active edge only when
 * the target already has its shape, or when an older source edge of the same
 * shape is the one that moves; everything else they move. So for every row the
 * UPDATE saw, "still here afterwards" meant "a duplicate" and a DELETE was
 * right. But each statement of a merge's READ COMMITTED transaction takes its own
 * snapshot, and until the merge commits the edge projection still reads the
 * columns the merge just rewrote — so it writes the SOURCE's edge, to a table
 * with no foreign key that could make it wait. A projection committing after the
 * UPDATE's snapshot and before the DELETE's lost its edge to the DELETE: a hard
 * delete, no delta, the row's ledger entry stamped `done` by the leg that wrote
 * it, and nothing left to offer it to the leg again. The survivor never got the
 * edge. Five of them went that way in one person merge on the reference
 * appliance. The legs that can do this:
 *
 * - person merge: `promote.edge_communication` (`from_entity_id` /
 *   `to_entity_ids`), `promote.edge_event` (`organizer_entity_id` /
 *   `participant_entity_ids`);
 * - place merge: `promote.edge_event` (`location_entity_id`),
 *   `promote.edge_position` (`ci.position.location_entity_id`, the owner's
 *   VISITED edge), `promote.edge_object` / `promote.edge_receipt` /
 *   `promote.edge_observation` (the place columns they read), and
 *   `promote.edge_place` (`parent_place_id`, the one that puts a source at the
 *   FROM end of its edge).
 *
 * One statement closes it because the DELETE and the INSERT share a snapshot:
 * whatever the DELETE sees, the INSERT re-seats. The target's own guard moves
 * from explicit predicates to the unique index —
 *
 * - an ACTIVE edge whose shape the target already holds conflicts with
 *   `relationships_unique_directed_idx` and is dropped (`ON CONFLICT DO
 *   NOTHING`), exactly the duplicate the UPDATE would have declined;
 * - among sources' edges of one shape the rows are inserted oldest first, so
 *   the oldest is the one that is kept, as in the UPDATE;
 * - an inactive edge is outside that index and is kept, as the UPDATE keeps it.
 *
 * An edge whose OTHER end is a source or the target is dropped, not inserted:
 * re-pointed it would be a self-reference, and `no_self_references` is a CHECK,
 * which no `ON CONFLICT` absorbs and which would abort the whole merge. The
 * self-reference DELETE at the top of each merge's re-point step catches those
 * edges that existed then; this is the same rule for the ones that did not.
 *
 * The `relationship_id` is kept so an edge stays ONE edge: the projection's
 * `relationship/created` delta still names a row that exists, and the check "a
 * relationship delta whose `relationship_id` is gone from `ci.relationships`" —
 * which is how the loss above was found — stays an exact signal of a hard delete
 * instead of also flagging every swept edge. Moving the edge is recorded as a
 * `relationship/updated` delta, which an in-place re-point is not; this path is
 * the one that can only run on a race, and the delta (plus the merge's
 * `relationshipsRescued` count) is how it gets counted.
 *
 * What remains is a projection whose own snapshot predates the merge's commit
 * and that commits after this statement: its edge stays on the tombstone. That
 * window is the length of this statement plus the rest of the transaction.
 * Closing it would take a lock the projection also takes.
 */
export async function sweepLeftoverEdges(
  em: EntityManager,
  graphDeltaWriter: GraphDeltaWriter,
  sweep: EdgeSweep,
): Promise<EdgeSweepOutcome> {
  const { ownerUserId, sources, targetId, end, changeSource, changeReason } = sweep;
  const { moved, other } = EDGE_ENDS[end];
  const columns = RELATIONSHIP_COLUMNS.join(', ');
  const values = RELATIONSHIP_COLUMNS.map((column) =>
    column === moved ? '$3::uuid' : `gone.${column}`,
  ).join(', ');

  // The outer command is a SELECT, so TypeORM hands back plain rows — the
  // [rows, rowCount] pair is only for a statement whose OUTER command is an
  // UPDATE or DELETE (see countAffected).
  const rows: Array<{ deleted: unknown; rescued: unknown }> = await em.query(
    `WITH gone AS (
         DELETE FROM ci.relationships
          WHERE owner_user_id = $1 AND ${moved} = ANY($2::uuid[])
          RETURNING ${columns}
       ),
       seated AS (
         INSERT INTO ci.relationships (${columns})
         SELECT ${values}
           FROM gone
          WHERE gone.${other} <> $3::uuid AND NOT (gone.${other} = ANY($2::uuid[]))
          ORDER BY gone.created_at ASC, gone.relationship_id ASC
         ON CONFLICT DO NOTHING
         RETURNING relationship_id, relationship_type, from_entity_id, to_entity_id
       )
       SELECT (SELECT count(*)::int FROM gone) AS deleted,
              COALESCE(
                (SELECT jsonb_agg(jsonb_build_object(
                          'relationship_id', seated.relationship_id,
                          'relationship_type', seated.relationship_type,
                          'from_entity_id', seated.from_entity_id,
                          'to_entity_id', seated.to_entity_id,
                          'was', gone.${moved}))
                   FROM seated JOIN gone ON gone.relationship_id = seated.relationship_id),
                '[]'::jsonb) AS rescued`,
    [ownerUserId, sources, targetId],
  );

  // Same tripwire as countAffected, for the same reason: a wrong shape here
  // would read as "nothing was swept" and let the audit row say so.
  const [row] = rows;
  if (rows.length !== 1 || !Number.isInteger(row.deleted) || !Array.isArray(row.rescued)) {
    throw new Error(`sweepLeftoverEdges expected one { deleted, rescued } row, got ${JSON.stringify(rows)}`);
  }

  const rescued = row.rescued as RescuedEdge[];

  if (rescued.length > 0) {
    await graphDeltaWriter.recordMany(
      rescued.map((edge) => ({
        nodeType: 'relationship' as const,
        changeType: 'updated' as const,
        relationshipId: edge.relationship_id,
        relationshipType: edge.relationship_type,
        fromEntityId: edge.from_entity_id,
        toEntityId: edge.to_entity_id,
        ownerUserId,
        changeSource,
        changeReason,
        changedByUserId: ownerUserId,
        changedFields: { [moved]: { old: edge.was, new: targetId } },
      })),
      em,
    );
  }

  return { dropped: (row.deleted as number) - rescued.length, rescued: rescued.length };
}
