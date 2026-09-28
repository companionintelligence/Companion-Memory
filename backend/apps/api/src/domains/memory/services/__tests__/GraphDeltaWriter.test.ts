import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { GraphDeltaWriter, type RecordGraphDeltaInput } from '../GraphDeltaWriter';

/**
 * Field order the `record`/`recordMany` bind array pushes in, per row — see
 * `GraphDeltaWriter.recordMany`. Used below to decode a captured bind array
 * back into a named object per row, so multi-row assertions read by column
 * name instead of a fragile positional index.
 */
const BOUND_COLUMNS = [
  'deltaId',
  'entityId',
  'relationshipId',
  'nodeType',
  'entityType',
  'relationshipType',
  'fromEntityId',
  'toEntityId',
  'changeType',
  'changedFields',
  'changeSource',
  'changeReason',
  'changedByUserId',
  'ownerUserId',
] as const;

function rowAt(bind: unknown[], rowIndex: number): Record<(typeof BOUND_COLUMNS)[number], unknown> {
  const start = rowIndex * BOUND_COLUMNS.length;
  const slice = bind.slice(start, start + BOUND_COLUMNS.length);

  return Object.fromEntries(BOUND_COLUMNS.map((key, i) => [key, slice[i]])) as Record<
    (typeof BOUND_COLUMNS)[number],
    unknown
  >;
}

function makeWriter() {
  const query = jest.fn(async () => undefined);
  const writer = new GraphDeltaWriter(
    { query } as unknown as DataSource,
    { setContext: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as LoggerService,
  );

  return { writer, query };
}

describe('GraphDeltaWriter', () => {
  describe('entityCreated', () => {
    it('serializes the full changed_fields payload, not just the name anchor', async () => {
      const { writer, query } = makeWriter();

      await writer.entityCreated({
        entityId: '00000000-0000-0000-0000-0000000000c1',
        entityType: 'Content',
        name: 'Docs',
        description: 'A folder of docs',
        properties: { foo: 'bar' },
        ownerUserId: '00000000-0000-0000-0000-0000000000a1',
        changeSource: 'ContentService.create',
      });

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, bind] = query.mock.calls[0] as unknown as [string, unknown[]];
      const row = rowAt(bind, 0);

      expect(sql).toContain('INSERT INTO ci.graph_deltas');
      expect(row).toMatchObject({
        entityId: '00000000-0000-0000-0000-0000000000c1',
        entityType: 'Content',
        nodeType: 'entity',
        changeType: 'created',
        changeSource: 'ContentService.create',
        ownerUserId: '00000000-0000-0000-0000-0000000000a1',
      });
      expect(JSON.parse(row.changedFields as string)).toEqual({
        name: { new: 'Docs' },
        description: { new: 'A folder of docs' },
        entity_type: { new: 'Content' },
        properties: { new: { foo: 'bar' } },
      });
    });

    it('defaults description and properties when the caller omits them', async () => {
      const { writer, query } = makeWriter();

      await writer.entityCreated({
        entityId: 'e-1',
        entityType: 'Concept',
        name: 'Coffee',
        ownerUserId: 'owner-1',
        changeSource: 'ConceptService.create',
      });

      const [, bind] = query.mock.calls[0] as unknown as [string, unknown[]];
      const row = rowAt(bind, 0);

      expect(JSON.parse(row.changedFields as string)).toEqual({
        name: { new: 'Coffee' },
        description: { new: null },
        entity_type: { new: 'Concept' },
        properties: { new: {} },
      });
    });
  });

  describe('entityUpdated', () => {
    it('fills a default name changed-field pair when the caller does not supply one', async () => {
      const { writer, query } = makeWriter();

      await writer.entityUpdated({
        entityId: 'e-2',
        entityType: 'Person',
        name: 'Ada Lovelace',
        changedFields: { email: { old: 'a@x.com', new: 'b@x.com' } },
        ownerUserId: 'owner-2',
        changeSource: 'PersonService.update',
      });

      const [, bind] = query.mock.calls[0] as unknown as [string, unknown[]];
      const row = rowAt(bind, 0);

      expect(row.changeType).toBe('updated');
      expect(JSON.parse(row.changedFields as string)).toEqual({
        email: { old: 'a@x.com', new: 'b@x.com' },
        // The default fill-in (GraphDeltaWriter.ts entityUpdated): when the
        // caller's changedFields carries no `name` entry, one is synthesized
        // from the CURRENT name on both sides — this is the only branch that
        // proves that fill-in actually lands in the serialized payload.
        name: { old: 'Ada Lovelace', new: 'Ada Lovelace' },
      });
    });

    it('does NOT override an explicit name changed-field with the default', async () => {
      const { writer, query } = makeWriter();

      await writer.entityUpdated({
        entityId: 'e-3',
        entityType: 'Person',
        name: 'New Name',
        changedFields: { name: { old: 'Old Name', new: 'New Name' } },
        ownerUserId: 'owner-3',
        changeSource: 'PersonService.update',
      });

      const [, bind] = query.mock.calls[0] as unknown as [string, unknown[]];
      const row = rowAt(bind, 0);

      expect(JSON.parse(row.changedFields as string)).toEqual({
        name: { old: 'Old Name', new: 'New Name' },
      });
    });
  });

  describe('entityDeleted', () => {
    it('records only the prior name, under changed_fields.name.old', async () => {
      const { writer, query } = makeWriter();

      await writer.entityDeleted({
        entityId: 'e-9',
        entityType: 'Content',
        name: 'Doc Title',
        ownerUserId: 'owner-9',
        changeSource: 'ContentService.remove',
        changeReason: 'user requested',
        changedByUserId: 'owner-9',
      });

      const [, bind] = query.mock.calls[0] as unknown as [string, unknown[]];
      const row = rowAt(bind, 0);

      expect(row).toMatchObject({
        entityId: 'e-9',
        nodeType: 'entity',
        changeType: 'deleted',
        changeReason: 'user requested',
        changedByUserId: 'owner-9',
      });
      expect(JSON.parse(row.changedFields as string)).toEqual({ name: { old: 'Doc Title' } });
    });
  });

  describe('recordMany', () => {
    it('is a no-op for an empty batch (no query issued)', async () => {
      const { writer, query } = makeWriter();

      await writer.recordMany([]);

      expect(query).not.toHaveBeenCalled();
    });

    it('offsets bind params correctly across a multi-row batch — a mismatched multiplier would corrupt every row after the first', async () => {
      const { writer, query } = makeWriter();

      // Three rows, deliberately touching every field the bind builder pushes
      // (relationship fields included), each with values distinguishable by
      // row so a misaligned offset shows up as row N reading row M's data.
      const inputs: RecordGraphDeltaInput[] = [
        {
          nodeType: 'entity',
          changeType: 'created',
          entityId: 'entity-0',
          entityType: 'Person',
          ownerUserId: 'owner-0',
          changeSource: 'src-0',
          changeReason: 'reason-0',
          changedByUserId: 'actor-0',
          changedFields: { name: { new: 'Row Zero' } },
        },
        {
          nodeType: 'entity',
          changeType: 'updated',
          entityId: 'entity-1',
          entityType: 'Place',
          ownerUserId: 'owner-1',
          changeSource: 'src-1',
          changedFields: { name: { new: 'Row One' } },
        },
        {
          nodeType: 'relationship',
          changeType: 'deleted',
          relationshipId: 'rel-2',
          relationshipType: 'knows',
          fromEntityId: 'from-2',
          toEntityId: 'to-2',
          ownerUserId: 'owner-2',
          changeSource: 'src-2',
        },
      ];

      await writer.recordMany(inputs);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, bind] = query.mock.calls[0] as unknown as [string, unknown[]];

      // Exactly 14 bind params per row, contiguous, no gaps or overlap.
      expect(bind).toHaveLength(inputs.length * BOUND_COLUMNS.length);

      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      expect(placeholders).toHaveLength(inputs.length * BOUND_COLUMNS.length);
      expect(new Set(placeholders).size).toBe(placeholders.length); // no collisions
      expect(Math.min(...placeholders)).toBe(1);
      expect(Math.max(...placeholders)).toBe(inputs.length * BOUND_COLUMNS.length);

      const row0 = rowAt(bind, 0);
      expect(row0).toMatchObject({
        entityId: 'entity-0',
        relationshipId: null,
        nodeType: 'entity',
        entityType: 'Person',
        changeType: 'created',
        changeSource: 'src-0',
        changeReason: 'reason-0',
        changedByUserId: 'actor-0',
        ownerUserId: 'owner-0',
      });
      expect(JSON.parse(row0.changedFields as string)).toEqual({ name: { new: 'Row Zero' } });

      const row1 = rowAt(bind, 1);
      expect(row1).toMatchObject({
        entityId: 'entity-1',
        nodeType: 'entity',
        entityType: 'Place',
        changeType: 'updated',
        changeSource: 'src-1',
        changeReason: null,
        changedByUserId: null,
        ownerUserId: 'owner-1',
      });
      expect(JSON.parse(row1.changedFields as string)).toEqual({ name: { new: 'Row One' } });

      const row2 = rowAt(bind, 2);
      expect(row2).toMatchObject({
        entityId: null,
        relationshipId: 'rel-2',
        nodeType: 'relationship',
        relationshipType: 'knows',
        fromEntityId: 'from-2',
        toEntityId: 'to-2',
        changeType: 'deleted',
        changeSource: 'src-2',
        ownerUserId: 'owner-2',
      });
      expect(JSON.parse(row2.changedFields as string)).toEqual({});
    });

    it('shares the caller-supplied transactional manager instead of the DataSource', async () => {
      const { writer } = makeWriter();
      const managerQuery = jest.fn(async () => undefined);
      const manager = { query: managerQuery } as never;

      await writer.recordMany(
        [
          {
            nodeType: 'entity',
            changeType: 'created',
            entityId: 'e-in-tx',
            ownerUserId: 'owner-1',
            changeSource: 'src',
          },
        ],
        manager,
      );

      expect(managerQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordMany chunking', () => {
    it('never binds more than the Postgres parameter limit in one statement', async () => {
      // 4,873 rows is one real Google Takeout push. Unchunked it bound 68,222
      // parameters, which the protocol's 16-bit count wrapped to "bind message
      // has 2686 parameter formats but 0 parameters".
      const { writer, query } = makeWriter();
      const inputs: RecordGraphDeltaInput[] = Array.from({ length: 4_873 }, (_, i) => ({
        nodeType: 'entity',
        changeType: 'created',
        entityId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        entityType: 'Person',
        ownerUserId: '00000000-0000-4000-8000-00000000aaaa',
        changeSource: 'test',
      }));

      await writer.recordMany(inputs);

      const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
      expect(calls.length).toBeGreaterThan(1);

      for (const [, bind] of calls) {
        expect(bind.length).toBeLessThanOrEqual(65_535);
      }

      // Every row written exactly once, in order.
      const all = calls.flatMap(([, bind]) =>
        Array.from({ length: bind.length / BOUND_COLUMNS.length }, (_, r) => rowAt(bind, r).entityId),
      );
      expect(all).toEqual(inputs.map((input) => input.entityId));
    });
  });
});
