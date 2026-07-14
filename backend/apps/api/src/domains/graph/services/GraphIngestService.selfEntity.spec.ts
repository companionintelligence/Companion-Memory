import {
  makeFakeNodeRepository,
  makeFakeRelationshipRepository,
} from './__testHelpers__/fakeGraphRepositories';
import { GraphIngestService } from './GraphIngestService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const EXISTING_SELF = '00000000-0000-0000-0000-0000000000c1';

const CONCEPT_KEY = 'graph_llm:concept:cuisine:italian';

/**
 * Coverage for the self-entity self-heal: a `self`-anchored edge (preferences
 * from extract-graph) must attach even on a from-scratch graph where
 * ci.users.entity_id is still NULL. The previous behaviour dropped every such
 * edge with "endpoint not found in batch" (preferenceEdgesWritten=0). Now the
 * ingest provisions a `Person` for the owner and links ci.users.entity_id to it
 * before wiring the edge. Exercises the set-based upsert path.
 */
function makeService(opts: { selfExists: boolean }) {
  // The owner's self entity, as resolveSelfEntity's JOIN would return it. Starts
  // empty on a fresh graph; the provisioned Person fills it in.
  let selfRows: Array<{ entity_id: string; entity_type: string }> = opts.selfExists
    ? [{ entity_id: EXISTING_SELF, entity_type: 'Person' }]
    : [];

  const node = makeFakeNodeRepository();
  const rel = makeFakeRelationshipRepository();

  const usersUpdate = jest.fn();

  // The self Person is provisioned via the set-based upsert (insert()), so the
  // provisioned row shows up in node.inserted; mirror it into the resolveSelfEntity
  // JOIN result so the subsequent lookup finds it (as the ci.users FK link would).
  node.repo.manager.query = jest.fn((sql: string, params: unknown[]) => {
    if (sql.includes('JOIN ci.entities')) {
      return Promise.resolve(selfRows);
    }

    if (sql.includes('name, email')) {
      return Promise.resolve([{ name: 'Liam', email: 'liam@ci.computer' }]);
    }

    if (sql.includes('UPDATE ci.users')) {
      usersUpdate(params);
      // params = [ownerId, selfEntityId]; reflect the link into the JOIN result.
      selfRows = [{ entity_id: params[1] as string, entity_type: 'Person' }];

      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  }) as unknown as typeof node.repo.manager.query;

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

  return { service, node, rel, usersUpdate };
}

// One preference: a Concept node + a self -> PREFERS -> Concept edge, exactly
// what GraphEnrichmentService.buildPreferenceInput emits.
const PREFERENCE_BATCH = {
  entities: [
    {
      key: CONCEPT_KEY,
      entityType: 'Concept',
      name: 'Italian',
      sourceSystem: 'graph_llm',
      properties: { type: 'cuisine', extracted_by: 'graph_llm' },
    },
  ],
  relationships: [
    { fromKey: 'self', toKey: CONCEPT_KEY, type: 'PREFERS', properties: { source: 'graph_llm' } },
  ],
};

describe('GraphIngestService self-entity provisioning', () => {
  it('provisions a Person + links ci.users.entity_id when the owner has no self entity, then writes the self edge', async () => {
    const { service, node, rel, usersUpdate } = makeService({ selfExists: false });

    const result = await service.ingest({ userId: USER }, PREFERENCE_BATCH);

    // The self edge is written, not dropped.
    expect(result.relationshipsProcessed).toBe(1);
    expect(result.errors).toEqual([]);

    // A self Person was provisioned (named from ci.users.name, flagged is_self).
    const selfRow = node.inserted.find((row) => (row.properties as Record<string, unknown>)?.is_self);
    expect(selfRow).toBeDefined();
    expect(selfRow!.entityType).toBe('Person');
    expect(selfRow!.name).toBe('Liam');

    // ci.users.entity_id was linked to the provisioned Person.
    expect(usersUpdate).toHaveBeenCalledTimes(1);
    expect(usersUpdate.mock.calls[0][0]).toEqual([USER, selfRow!.entityId]);

    // The edge anchors on the provisioned self.
    const edge = rel.inserted[0];
    expect(edge.fromNodeId).toBe(selfRow!.entityId);
    expect(edge.type).toBe('PREFERS');
  });

  it('reuses an existing self entity without provisioning or relinking', async () => {
    const { service, node, rel, usersUpdate } = makeService({ selfExists: true });

    const result = await service.ingest({ userId: USER }, PREFERENCE_BATCH);

    expect(result.relationshipsProcessed).toBe(1);
    expect(result.errors).toEqual([]);

    // No self Person provisioned, no relink.
    expect(node.inserted.some((row) => (row.properties as Record<string, unknown>)?.is_self)).toBe(false);
    expect(usersUpdate).not.toHaveBeenCalled();

    // The edge anchors on the existing self.
    expect(rel.inserted[0].fromNodeId).toBe(EXISTING_SELF);
  });
});
