import {
  makeFakeNodeRepository,
  makeFakeRelationshipRepository,
} from './__testHelpers__/fakeGraphRepositories';
import { GraphIngestService } from './GraphIngestService';

const USER = '00000000-0000-0000-0000-0000000000aa';
/** The row a duplicate was merged INTO — the live person. */
const CANONICAL = '00000000-0000-0000-0000-0000000000b1';
/** The merged-away row. Keeps its linked key, so it still wins the lookup. */
const TOMBSTONE = '00000000-0000-0000-0000-0000000000c1';
const OTHER = '00000000-0000-0000-0000-0000000000d1';

const KEY = 'apple_contacts:contact:Max';
const LINKED_TABLE = 'import:apple_contacts';

type SeedRow = NonNullable<NonNullable<Parameters<typeof makeFakeNodeRepository>[0]>['seed']>[number];

function makeService(seed: SeedRow[]) {
  const node = makeFakeNodeRepository({ seed });
  const rel = makeFakeRelationshipRepository();
  const entityIdentifierService = { upsertForEntities: jest.fn() };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new GraphIngestService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node.repo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rel.repo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entityIdentifierService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, node, rel, entityIdentifierService };
}

function tombstoneRow() {
  return {
    entityId: TOMBSTONE,
    entityType: 'Person',
    name: 'Max',
    description: null,
    properties: {},
    linkedTable: LINKED_TABLE,
    linkedId: GraphIngestService.linkedIdFor(KEY),
    userId: USER,
    mergedIntoEntityId: CANONICAL,
  };
}

/**
 * Re-ingest after a merge.
 *
 * A merge tombstone KEEPS its linked key — that is the whole reason the row
 * survives — so the (owner, entity_type, linked_table, linked_id) lookup goes on
 * finding it forever. Before this was handled, the next sync from the
 * merged-away source resolved to the tombstone: names and properties written
 * onto a dead row, and that batch's relationships wired to a node no reader
 * follows. The merge was not undone so much as bypassed.
 */
describe('GraphIngestService — re-ingesting a merged-away linked key', () => {
  it('resolves the tombstone to the entity it was merged into', async () => {
    const { service } = makeService([tombstoneRow()]);

    const result = await service.ingest(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: USER } as any,
      {
        entities: [{ key: KEY, entityType: 'Person', name: 'Max', sourceSystem: 'apple_contacts' }],
        relationships: [],
      },
    );

    expect(result.entities).toEqual([{ key: KEY, entityId: CANONICAL }]);
    expect(result.errors).toEqual([]);
  });

  it('does not create a second row for a key the tombstone still owns', async () => {
    // The linked key is taken by the tombstone (entities_linked_uniq), so a
    // fresh insert would be swallowed by ON CONFLICT anyway — the resolution
    // has to come from following the pointer, not from re-creating the row.
    const { service, node } = makeService([tombstoneRow()]);

    await service.ingest(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: USER } as any,
      {
        entities: [{ key: KEY, entityType: 'Person', name: 'Max', sourceSystem: 'apple_contacts' }],
        relationships: [],
      },
    );

    expect(node.inserted).toHaveLength(0);
  });

  it('attaches this batch’s relationships to the canonical row, not the tombstone', async () => {
    const { service, rel } = makeService([
      tombstoneRow(),
      {
        entityId: OTHER,
        entityType: 'Person',
        name: 'Sam',
        description: null,
        properties: {},
        linkedTable: LINKED_TABLE,
        linkedId: GraphIngestService.linkedIdFor('apple_contacts:contact:Sam'),
        userId: USER,
        mergedIntoEntityId: null,
      },
    ]);

    await service.ingest(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: USER } as any,
      {
        entities: [
          { key: KEY, entityType: 'Person', name: 'Max', sourceSystem: 'apple_contacts' },
          {
            key: 'apple_contacts:contact:Sam',
            entityType: 'Person',
            name: 'Sam',
            sourceSystem: 'apple_contacts',
          },
        ],
        relationships: [{ fromKey: 'apple_contacts:contact:Sam', toKey: KEY, type: 'KNOWS' }],
      },
    );

    const edges = rel.inserted;
    expect(edges).toHaveLength(1);
    expect(edges[0].toNodeId).toBe(CANONICAL);
    expect(edges[0].toNodeId).not.toBe(TOMBSTONE);
  });

  it('indexes the identifiers it carries against the canonical row', async () => {
    const { service, entityIdentifierService } = makeService([tombstoneRow()]);

    await service.ingest(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: USER } as any,
      {
        entities: [
          {
            key: KEY,
            entityType: 'Person',
            name: 'Max',
            sourceSystem: 'apple_contacts',
            properties: { emails: ['max@example.com'] },
          },
        ],
        relationships: [],
      },
    );

    expect(entityIdentifierService.upsertForEntities).toHaveBeenCalledWith(USER, [
      { entityId: CANONICAL, raw: { emails: ['max@example.com'], phones: undefined, names: undefined } },
    ]);
  });

  it('leaves a live row alone', async () => {
    const { service } = makeService([{ ...tombstoneRow(), entityId: CANONICAL, mergedIntoEntityId: null }]);

    const result = await service.ingest(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: USER } as any,
      {
        entities: [{ key: KEY, entityType: 'Person', name: 'Max', sourceSystem: 'apple_contacts' }],
        relationships: [],
      },
    );

    expect(result.entities).toEqual([{ key: KEY, entityId: CANONICAL }]);
  });
});
