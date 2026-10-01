import { WriteKnowledgeTool } from '../WriteKnowledgeTool';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe('WriteKnowledgeTool Qwen argument shapes', () => {
  it('creates entities from op/create_entity and resolves name-based relationships in-batch', async () => {
    const created: Array<{ name?: string | null; entityType: string }> = [];
    const relationships: Array<{ fromEntityId: string; toEntityId: string; relationshipType: string }> = [];
    const nodes = new Map<string, { entity_id: string; entity_type: string; name: string }>();

    const graphEvents = {
      upsertNode: jest.fn(async (_owner: string, input: { entityType: string; name?: string | null }) => {
        const entityId = `id-${created.length + 1}`;
        created.push({ entityType: input.entityType, name: input.name });
        nodes.set(entityId, { entity_id: entityId, entity_type: input.entityType, name: input.name ?? '' });

        return { entityId };
      }),
      upsertRelationship: jest.fn(
        async (
          _owner: string,
          input: { fromEntityId: string; toEntityId: string; relationshipType: string },
        ) => {
          relationships.push(input);

          return { relationshipId: `rel-${relationships.length}` };
        },
      ),
    };
    const graphQuery = {
      getNode: jest.fn(async (_owner: string, id: string) => nodes.get(id) ?? null),
      getNodes: jest.fn(async () => []),
      getNodesByIds: jest.fn(async (_owner: string, ids: string[]) =>
        ids.map((id) => nodes.get(id)).filter(Boolean),
      ),
      searchNodesByPrefix: jest.fn(async () => []),
      // Both entities are new in this batch, so no edge between them exists yet.
      findActiveRelationship: jest.fn(async () => null),
    };

    const tool = new WriteKnowledgeTool(graphEvents as never, graphQuery as never, makeLogger() as never);
    const result = await tool.execute(
      { userId: 'user-1' },
      {
        operations: [
          {
            op: 'create_entity',
            entityType: 'place',
            name: 'Example Home',
            properties: { type: 'home' },
          },
          {
            op: 'create_entity',
            entityType: 'person',
            name: 'alex',
          },
          {
            op: 'create_relationship',
            from: { entityType: 'person', name: 'alex' },
            relationshipType: 'LIVES_AT',
            to: { entityType: 'place', name: 'Example Home' },
          },
        ],
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ createdNodes: 2, createdRelationships: 1, failures: 0 });
    // The lower-case types Qwen sends go out as ci.entities stores them:
    // `valid_entity_type` refuses `person`, and the write dead-lettered.
    expect(created).toEqual([
      { entityType: 'Place', name: 'Example Home' },
      { entityType: 'Person', name: 'alex' },
    ]);
    expect(relationships).toEqual([
      expect.objectContaining({
        fromEntityId: 'id-2',
        toEntityId: 'id-1',
        relationshipType: 'LIVES_AT',
      }),
    ]);
  });
});
