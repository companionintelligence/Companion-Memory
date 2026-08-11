import {
  makeFakeNodeRepository,
  makeFakeRelationshipRepository,
} from './__testHelpers__/fakeGraphRepositories';
import { GraphIngestService, type GraphEntityInputDto } from './GraphIngestService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const RESOLVED_ID = '00000000-0000-0000-0000-0000000000e1';
const RESOLVED_ID_2 = '00000000-0000-0000-0000-0000000000e2';

const KEY_1 = 'apple_contacts:contact:John Doe';
const KEY_2 = 'apple_contacts:contact:Jane Roe';

/**
 * Focused coverage for the people-linking hook on the entity upsert path: the
 * whole ingest batch's identifiers (properties.emails/.phones/.names) must be
 * registered via ONE EntityIdentifierService.upsertForEntities call — not one
 * per entity — and entities without identifiers must not enter the batch. The
 * entities are seeded as already-present so the set-based upsert resolves them
 * to stable ids without an insert, keeping the test on the identifier path.
 */
function makeService(identifierUpsert: jest.Mock) {
  const seed = [
    {
      entityId: RESOLVED_ID,
      entityType: 'Person',
      name: 'John Doe',
      description: null,
      properties: {},
      linkedTable: 'import:apple_contacts',
      linkedId: GraphIngestService.linkedIdFor(KEY_1),
      userId: USER,
    },
    {
      entityId: RESOLVED_ID_2,
      entityType: 'Person',
      name: 'Jane Roe',
      description: null,
      properties: {},
      linkedTable: 'import:apple_contacts',
      linkedId: GraphIngestService.linkedIdFor(KEY_2),
      userId: USER,
    },
  ];

  const node = makeFakeNodeRepository({ seed });
  const rel = makeFakeRelationshipRepository();
  const entityIdentifierService = { upsertForEntities: identifierUpsert };
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
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  return { service, entityIdentifierService, logger };
}

function entity(props: Record<string, unknown> | null, key = KEY_1, name = 'John Doe'): GraphEntityInputDto {
  return {
    key,
    entityType: 'Person',
    name,
    sourceSystem: 'apple_contacts',
    properties: props,
  };
}

describe('GraphIngestService identifier population', () => {
  it('registers emails/phones for an ingested Person', async () => {
    const upsert = jest.fn().mockResolvedValue(2);
    const { service } = makeService(upsert);

    const result = await service.ingest(
      { userId: USER },
      { entities: [entity({ emails: ['john@example.com'], phones: ['+14155550100'] })], relationships: [] },
    );

    expect(result.entitiesProcessed).toBe(1);
    expect(result.errors).toEqual([]);
    expect(upsert).toHaveBeenCalledWith(USER, [
      { entityId: RESOLVED_ID, raw: { emails: ['john@example.com'], phones: ['+14155550100'] } },
    ]);
  });

  it('issues ONE batched identifier upsert for the whole ingest, excluding identifier-less entities', async () => {
    const upsert = jest.fn().mockResolvedValue(3);
    const { service } = makeService(upsert);

    const result = await service.ingest(
      { userId: USER },
      {
        entities: [
          entity({ emails: ['john@example.com'], phones: ['+14155550100'] }),
          entity({ note: 'no contacts here' }, 'apple_contacts:contact:No Contacts', 'No Contacts'),
          entity({ names: ['Jane Roe'] }, KEY_2, 'Jane Roe'),
        ],
        relationships: [],
      },
    );

    expect(result.entitiesProcessed).toBe(3);
    expect(result.errors).toEqual([]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(USER, [
      { entityId: RESOLVED_ID, raw: { emails: ['john@example.com'], phones: ['+14155550100'] } },
      { entityId: RESOLVED_ID_2, raw: { names: ['Jane Roe'] } },
    ]);
  });

  it('does not call the identifier service when no emails/phones/names are present', async () => {
    const upsert = jest.fn();
    const { service } = makeService(upsert);

    await service.ingest(
      { userId: USER },
      { entities: [entity({ note: 'no contacts here' })], relationships: [] },
    );

    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not call the identifier service when properties is null', async () => {
    const upsert = jest.fn();
    const { service } = makeService(upsert);

    await service.ingest({ userId: USER }, { entities: [entity(null)], relationships: [] });

    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not fail entity ingest when identifier indexing throws', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('boom'));
    const { service, logger } = makeService(upsert);

    const result = await service.ingest(
      { userId: USER },
      { entities: [entity({ emails: ['john@example.com'] })], relationships: [] },
    );

    expect(result.entitiesProcessed).toBe(1);
    expect(result.errors).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});
