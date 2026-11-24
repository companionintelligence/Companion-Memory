import { type EdgeSweep, RELATIONSHIP_COLUMNS, sweepLeftoverEdges } from './mergeEdgeSweep';

const USER = '00000000-0000-0000-0000-0000000000aa';
const TARGET = '00000000-0000-0000-0000-0000000000b1';
const SOURCE_A = '00000000-0000-0000-0000-0000000000c1';
const SOURCE_B = '00000000-0000-0000-0000-0000000000c2';
const OTHER = '00000000-0000-0000-0000-0000000000e1';

const E1 = '00000000-0000-0000-0000-00000000ee01';
const E2 = '00000000-0000-0000-0000-00000000ee02';

/**
 * What one sweep statement answers when it works: its outer command is a SELECT,
 * so the driver hands back plain rows — a statement whose OUTER command is an
 * UPDATE or DELETE would come back as `[rows, rowCount]` instead.
 */
function answer(deleted: number, rescued: unknown[] = []) {
  return [{ deleted, rescued }];
}

function harness(response: unknown) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });

    return response;
  });
  const em = { query };
  const recordMany = jest.fn(async () => undefined);

  return { em: em as never, writer: { recordMany } as never, statements, recordMany };
}

function sweepFor(end: 'from' | 'to', overrides: Partial<EdgeSweep> = {}): EdgeSweep {
  return {
    ownerUserId: USER,
    sources: [SOURCE_A, SOURCE_B],
    targetId: TARGET,
    end,
    changeSource: 'SomeMergeService.merge',
    changeReason: 'some_merge.rescued_edge',
    ...overrides,
  };
}

describe('sweepLeftoverEdges', () => {
  describe.each([
    { end: 'from' as const, moved: 'from_entity_id', other: 'to_entity_id' },
    { end: 'to' as const, moved: 'to_entity_id', other: 'from_entity_id' },
  ])('the $end end', ({ end, moved, other }) => {
    it('deletes what still holds a source and puts each edge back on the target, in ONE statement', async () => {
      const { em, writer, statements } = harness(answer(0));

      await sweepLeftoverEdges(em, writer, sweepFor(end));

      // One statement: the DELETE and the INSERT share a snapshot, which is the
      // whole point — whatever the DELETE sees, the INSERT re-seats.
      expect(statements).toHaveLength(1);
      expect(statements[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);

      const sql = statements[0].sql.replace(/\s+/g, ' ');
      const columns = RELATIONSHIP_COLUMNS.join(', ');
      // Every column goes from the DELETE's row to the INSERT, and the only one
      // that changes is the end being re-pointed.
      const values = RELATIONSHIP_COLUMNS.map((column) =>
        column === moved ? '$3::uuid' : `gone.${column}`,
      ).join(', ');

      expect(sql).toContain(
        `WITH gone AS ( DELETE FROM ci.relationships WHERE owner_user_id = $1 AND ${moved} = ANY($2::uuid[]) RETURNING ${columns} )`,
      );
      expect(sql).toContain(`INSERT INTO ci.relationships (${columns}) SELECT ${values} FROM gone`);

      // The relationship_id is carried over, so an edge stays ONE edge and a
      // `created` delta never outlives the row it names.
      expect(values).toContain('gone.relationship_id');
      expect(values.match(/\$3::uuid/g)).toHaveLength(1);
    });

    it('drops an edge that would become a self-reference, which no ON CONFLICT could absorb', async () => {
      const { em, writer, statements } = harness(answer(0));

      await sweepLeftoverEdges(em, writer, sweepFor(end));

      // `no_self_references` is a CHECK: it aborts the whole merge instead of
      // conflicting, so the other end being a source or the target is filtered
      // out BEFORE the insert.
      expect(statements[0].sql.replace(/\s+/g, ' ')).toContain(
        `WHERE gone.${other} <> $3::uuid AND NOT (gone.${other} = ANY($2::uuid[]))`,
      );
    });

    it('inserts oldest first and lets the unique index drop a duplicate of an edge the target holds', async () => {
      const { em, writer, statements } = harness(answer(0));

      await sweepLeftoverEdges(em, writer, sweepFor(end));

      // Oldest first, so of several sources' edges of one shape the oldest is the
      // one kept; ON CONFLICT drops a duplicate of the target's own edge.
      expect(statements[0].sql.replace(/\s+/g, ' ')).toContain(
        'ORDER BY gone.created_at ASC, gone.relationship_id ASC ON CONFLICT DO NOTHING',
      );
    });

    it('writes one relationship/updated delta per moved edge, under the caller’s source and reason, in the caller’s transaction', async () => {
      const edge = (id: string, type: string, was: string) => ({
        relationship_id: id,
        relationship_type: type,
        from_entity_id: end === 'from' ? TARGET : OTHER,
        to_entity_id: end === 'from' ? OTHER : TARGET,
        was,
      });
      const { em, writer, recordMany } = harness(
        answer(3, [edge(E1, 'LOCATED_AT', SOURCE_A), edge(E2, 'VISITED', SOURCE_B)]),
      );

      const outcome = await sweepLeftoverEdges(em, writer, sweepFor(end));

      // Three rows deleted, two put back: the third was a duplicate or a self-reference.
      expect(outcome).toEqual({ dropped: 1, rescued: 2 });

      const common = {
        nodeType: 'relationship',
        changeType: 'updated',
        fromEntityId: end === 'from' ? TARGET : OTHER,
        toEntityId: end === 'from' ? OTHER : TARGET,
        ownerUserId: USER,
        changeSource: 'SomeMergeService.merge',
        changeReason: 'some_merge.rescued_edge',
        changedByUserId: USER,
      };

      expect(recordMany).toHaveBeenCalledTimes(1);
      expect(recordMany).toHaveBeenCalledWith(
        [
          {
            ...common,
            relationshipId: E1,
            relationshipType: 'LOCATED_AT',
            changedFields: { [moved]: { old: SOURCE_A, new: TARGET } },
          },
          {
            ...common,
            relationshipId: E2,
            relationshipType: 'VISITED',
            changedFields: { [moved]: { old: SOURCE_B, new: TARGET } },
          },
        ],
        em,
      );
    });
  });

  it('writes no delta when nothing was moved — a plain drop of a duplicate leaves no trail', async () => {
    const { em, writer, recordMany } = harness(answer(2));

    await expect(sweepLeftoverEdges(em, writer, sweepFor('to'))).resolves.toEqual({ dropped: 2, rescued: 0 });
    expect(recordMany).not.toHaveBeenCalled();
  });

  it('reports nothing for a sweep that found nothing', async () => {
    const { em, writer, recordMany } = harness(answer(0));

    await expect(sweepLeftoverEdges(em, writer, sweepFor('from'))).resolves.toEqual({
      dropped: 0,
      rescued: 0,
    });
    expect(recordMany).not.toHaveBeenCalled();
  });

  it.each([
    // What TypeORM returns when the OUTER command is a DELETE or an UPDATE.
    ['the [rows, rowCount] pair', [[], 0]],
    ['no rows', []],
    ['two rows', [...answer(1), ...answer(1)]],
    ['a count that is not an integer', [{ deleted: '2', rescued: [] }]],
    ['no list of moved edges', [{ deleted: 2, rescued: null }]],
    ['a missing count', [{ rescued: [] }]],
  ])('refuses %s rather than reading it as "nothing swept"', async (_label, response) => {
    // A wrong shape would read as an empty sweep and let the audit row say that
    // no edge was dropped while the merge had deleted them.
    const { em, writer, recordMany } = harness(response);

    await expect(sweepLeftoverEdges(em, writer, sweepFor('from'))).rejects.toThrow(
      /sweepLeftoverEdges expected one \{ deleted, rescued \} row/,
    );
    expect(recordMany).not.toHaveBeenCalled();
  });
});
