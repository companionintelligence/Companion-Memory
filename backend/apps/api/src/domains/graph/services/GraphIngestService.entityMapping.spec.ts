import {
  makeFakeNodeRepository,
  makeFakeRelationshipRepository,
} from './__testHelpers__/fakeGraphRepositories';
import { GraphIngestService, type GraphEntityInputDto } from './GraphIngestService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const EXISTING_ID = '00000000-0000-0000-0000-0000000000d1';

/**
 * Coverage for the key → entityId mapping returned to the caller: every input
 * entity that upserts — freshly created OR resolved to an existing row — must
 * appear in `result.entities` with the ci.entities UUID it landed on, so the
 * importer can cache the mapping. Failed entities are reported in `errors` and
 * excluded from the mapping. Exercises the set-based upsert path.
 */
function makeService(opts: { existingKeys?: string[]; failEntities?: boolean } = {}) {
  // Seed the node store with an already-present row per existing key so the
  // existence pre-check resolves it to EXISTING_ID (no insert).
  const seed = (opts.existingKeys ?? []).map((k) => ({
    entityId: EXISTING_ID,
    entityType: 'Person',
    name: k,
    description: null,
    properties: {},
    linkedTable: 'import:apple_contacts',
    linkedId: GraphIngestService.linkedIdFor(k),
    userId: USER,
  }));

  const node = makeFakeNodeRepository({ seed, failSelect: opts.failEntities, failInsert: opts.failEntities });
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

  return { service, node };
}

function entity(key: string): GraphEntityInputDto {
  return {
    key,
    entityType: 'Person',
    name: key,
    sourceSystem: 'apple_contacts',
    properties: null,
  };
}

describe('GraphIngestService entity key mapping', () => {
  it('maps every input key to its UUID, covering created and resolved-existing rows', async () => {
    const { service, node } = makeService({ existingKeys: ['ent:1'] });

    const result = await service.ingest(
      { userId: USER },
      { entities: [entity('ent:1'), entity('ent:2')], relationships: [] },
    );

    expect(result.entitiesProcessed).toBe(2);
    expect(result.errors).toEqual([]);

    // 'ent:2' was freshly inserted — exactly one node row landed.
    expect(node.inserted).toHaveLength(1);
    const createdId = node.inserted[0].entityId;
    expect(createdId).toBeTruthy();

    expect(result.entities).toEqual([
      { key: 'ent:1', entityId: EXISTING_ID },
      { key: 'ent:2', entityId: createdId },
    ]);
  });

  it('resolves an existing row to its stable UUID on re-ingest without an insert', async () => {
    const { service, node } = makeService({ existingKeys: ['ent:1'] });

    const result = await service.ingest({ userId: USER }, { entities: [entity('ent:1')], relationships: [] });

    expect(node.inserted).toHaveLength(0);
    expect(result.entities).toEqual([{ key: 'ent:1', entityId: EXISTING_ID }]);
  });

  it('excludes all entities from the mapping and reports them on a batch-level DB failure', async () => {
    // A batch-level failure can't be pinned to one row, so every input key is
    // reported and none resolve — matching the prior per-entity catch's outcome
    // for a genuine (non-race) DB error.
    const { service } = makeService({ failEntities: true });

    const result = await service.ingest(
      { userId: USER },
      { entities: [entity('ent:1'), entity('ent:bad')], relationships: [] },
    );

    expect(result.entitiesProcessed).toBe(0);
    expect(result.errors).toEqual(['entity ent:1: db unavailable', 'entity ent:bad: db unavailable']);
    expect(result.entities).toEqual([]);
  });
});
