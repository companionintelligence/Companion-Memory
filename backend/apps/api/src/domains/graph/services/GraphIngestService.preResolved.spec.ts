import {
  makeFakeNodeRepository,
  makeFakeRelationshipRepository,
} from './__testHelpers__/fakeGraphRepositories';
import { GraphIngestService } from './GraphIngestService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const A = '00000000-0000-0000-0000-0000000000b1';
const B = '00000000-0000-0000-0000-0000000000b2';

/**
 * Coverage for the pre-resolved relationship endpoints used by
 * GraphEnrichmentService's family-edge path: a relationship may name its
 * endpoints by an existing graph node id (fromEntityId/toEntityId) instead of a
 * batch key, so an edge is attached between two Person nodes the importer already
 * created without re-ingesting them. Exercises the set-based relationship upsert.
 */
function makeService() {
  const node = makeFakeNodeRepository();
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

  return { service, rel };
}

describe('GraphIngestService pre-resolved relationship endpoints', () => {
  it('writes an edge between two existing nodes referenced by entity id, with no batch entities', async () => {
    const { service, rel } = makeService();

    const result = await service.ingest(
      { userId: USER },
      {
        entities: [],
        relationships: [
          {
            fromKey: 'Liam',
            toKey: 'Sarah',
            type: 'SPOUSE',
            fromEntityId: A,
            fromEntityType: 'Person',
            toEntityId: B,
            toEntityType: 'Person',
          },
        ],
      },
    );

    expect(result.relationshipsProcessed).toBe(1);
    expect(result.errors).toEqual([]);

    expect(rel.inserted).toHaveLength(1);
    const saved = rel.inserted[0];
    expect(saved.fromNodeId).toBe(A);
    expect(saved.toNodeId).toBe(B);
    expect(saved.fromNodeType).toBe('Person');
    expect(saved.toNodeType).toBe('Person');
    expect(saved.type).toBe('SPOUSE');
  });

  it('is idempotent: re-sending the same pre-resolved edge inserts nothing the second time', async () => {
    const { service, rel } = makeService();

    const batch = {
      entities: [],
      relationships: [
        {
          fromKey: 'Liam',
          toKey: 'Sarah',
          type: 'SPOUSE',
          fromEntityId: A,
          fromEntityType: 'Person',
          toEntityId: B,
          toEntityType: 'Person',
        },
      ],
    };

    const first = await service.ingest({ userId: USER }, batch);
    const second = await service.ingest({ userId: USER }, batch);

    expect(first.relationshipsProcessed).toBe(1);
    expect(second.relationshipsProcessed).toBe(1); // resolved to the existing edge
    expect(rel.inserted).toHaveLength(1); // but only ONE row ever landed
  });
});
