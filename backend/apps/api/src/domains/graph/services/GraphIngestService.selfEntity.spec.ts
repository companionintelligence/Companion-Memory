import {
  makeFakeNodeRepository,
  makeFakeRelationshipRepository,
} from './__testHelpers__/fakeGraphRepositories';
import { GraphIngestService } from './GraphIngestService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const EXISTING_SELF = '00000000-0000-0000-0000-0000000000c1';
const ELSEWHERE = '00000000-0000-0000-0000-0000000000c2';

const CONCEPT_KEY = 'graph_llm:concept:cuisine:italian';

/**
 * Coverage for the self-entity self-heal: a `self`-anchored edge (preferences
 * from extract-graph) must attach even on a from-scratch graph where
 * ci.users.entity_id is still NULL. The previous behaviour dropped every such
 * edge with "endpoint not found in batch" (preferenceEdgesWritten=0). Now the
 * ingest provisions a `Person` for the owner and links ci.users.entity_id to it
 * before wiring the edge. Exercises the set-based upsert path.
 */
function makeService(opts: { selfExists: boolean; pointerSetElsewhere?: string }) {
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
      // params = [ownerId, selfEntityId]; reflect the link into the JOIN result —
      // or, when another writer pointed the account first, the guarded UPDATE
      // matched nothing and the JOIN finds that writer's Person.
      selfRows = [{ entity_id: opts.pointerSetElsewhere ?? (params[1] as string), entity_type: 'Person' }];

      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  }) as unknown as typeof node.repo.manager.query;

  const entityIdentifierService = {
    upsertForEntities: jest.fn(),
    claimForSelf: jest.fn(async () => 0),
    repointToEntity: jest.fn(async () => null),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new GraphIngestService(
    node.repo as never,
    rel.repo as never,
    entityIdentifierService as never,
    logger as never,
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    } as never,
  );

  return { service, node, rel, usersUpdate, entityIdentifierService };
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
    const { service, node, rel, usersUpdate, entityIdentifierService } = makeService({
      selfExists: false,
    });

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
    const selfMark = node.repo.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes('SET is_self = TRUE'),
    );
    expect(selfMark?.[1]).toEqual([selfRow!.entityId, USER]);

    // Owner identifiers are claimed onto the new self Person.
    expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(
      USER,
      selfRow!.entityId,
      expect.objectContaining({ emails: ['liam@ci.computer'], names: ['Liam'] }),
    );
    expect(entityIdentifierService.repointToEntity).toHaveBeenCalledWith(
      USER,
      selfRow!.entityId,
      'email',
      'liam@ci.computer',
      'self',
    );

    // The edge anchors on the provisioned self.
    const edge = rel.inserted[0];
    expect(edge.fromNodeId).toBe(selfRow!.entityId);
    expect(edge.type).toBe('PREFERS');
  });

  it('provisions the self Person on the key onboarding creates its own under', async () => {
    const { service, node } = makeService({ selfExists: false });

    await service.ingest({ userId: USER }, PREFERENCE_BATCH);

    const selfRow = node.inserted.find((row) => (row.properties as Record<string, unknown>)?.is_self);
    expect({ linkedTable: selfRow!.linkedTable, linkedId: selfRow!.linkedId }).toEqual(
      GraphIngestService.selfEntityLink(USER),
    );
  });

  it('claims the owner for the Person the account points at when its own pointer write lost', async () => {
    // Between the provisioner's read (no pointer) and its guarded write, another
    // writer pointed the account at a different Person. The owner's address and
    // name must go to that Person, not to the row the account does not point at.
    const { service, node, rel, usersUpdate, entityIdentifierService } = makeService({
      selfExists: false,
      pointerSetElsewhere: ELSEWHERE,
    });

    const result = await service.ingest({ userId: USER }, PREFERENCE_BATCH);

    expect(result.errors).toEqual([]);
    const selfRow = node.inserted.find((row) => (row.properties as Record<string, unknown>)?.is_self);
    expect(usersUpdate).toHaveBeenCalledWith([USER, selfRow!.entityId]);

    expect(entityIdentifierService.claimForSelf).toHaveBeenCalledTimes(1);
    expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(USER, ELSEWHERE, expect.anything());
    expect(entityIdentifierService.repointToEntity).toHaveBeenCalledTimes(1);
    expect(entityIdentifierService.repointToEntity).toHaveBeenCalledWith(
      USER,
      ELSEWHERE,
      'email',
      'liam@ci.computer',
      'self',
    );
    const marks = node.repo.manager.query.mock.calls
      .filter(([sql]) => String(sql).includes('SET is_self = TRUE'))
      .map(([, params]) => params);
    expect(marks).toContainEqual([ELSEWHERE, USER]);

    // The edge anchors on the Person the account points at.
    expect(rel.inserted[0].fromNodeId).toBe(ELSEWHERE);
  });

  it('reuses an existing self entity without provisioning or relinking', async () => {
    const { service, node, rel, usersUpdate, entityIdentifierService } = makeService({
      selfExists: true,
    });

    const result = await service.ingest({ userId: USER }, PREFERENCE_BATCH);

    expect(result.relationshipsProcessed).toBe(1);
    expect(result.errors).toEqual([]);

    // No self Person provisioned, no relink.
    expect(node.inserted.some((row) => (row.properties as Record<string, unknown>)?.is_self)).toBe(false);
    expect(usersUpdate).not.toHaveBeenCalled();
    const selfMark = node.repo.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes('SET is_self = TRUE'),
    );
    expect(selfMark?.[1]).toEqual([EXISTING_SELF, USER]);

    // Existing self still claims owner identifiers (idempotent heal on ingest).
    expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(
      USER,
      EXISTING_SELF,
      expect.objectContaining({ emails: ['liam@ci.computer'], names: ['Liam'] }),
    );

    // The edge anchors on the existing self.
    expect(rel.inserted[0].fromNodeId).toBe(EXISTING_SELF);
  });
});
