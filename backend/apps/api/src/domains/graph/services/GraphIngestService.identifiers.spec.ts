import { GraphIngestService, type GraphEntityInputDto } from './GraphIngestService';

const USER = '00000000-0000-0000-0000-0000000000aa';

/**
 * Focused coverage for the people-linking hook added to the entity upsert path:
 * an ingested entity carrying properties.emails/.phones must register them via
 * EntityIdentifierService, and an entity without them must not.
 */
function makeService(identifierUpsert: jest.Mock) {
  // Node repo: findOne returns existing (so upsertEntity short-circuits to a
  // stable id without a save), keeping the test on the identifier path.
  const nodeRepository = {
    findOne: jest.fn().mockResolvedValue({ entityId: 'resolved-entity-id' }),
    create: jest.fn(),
    save: jest.fn(),
    manager: { query: jest.fn().mockResolvedValue([]) },
  };
  const relationshipRepository = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
  const entityIdentifierService = { upsertForEntity: identifierUpsert };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new GraphIngestService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    relationshipRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entityIdentifierService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, entityIdentifierService, logger };
}

function entity(props: Record<string, unknown> | null): GraphEntityInputDto {
  return {
    key: 'apple_contacts:contact:John Doe',
    entityType: 'Person',
    name: 'John Doe',
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
    expect(upsert).toHaveBeenCalledWith(USER, 'resolved-entity-id', {
      emails: ['john@example.com'],
      phones: ['+14155550100'],
    });
  });

  it('does not call the identifier service when no emails/phones are present', async () => {
    const upsert = jest.fn();
    const { service } = makeService(upsert);

    await service.ingest({ userId: USER }, { entities: [entity({ note: 'no contacts here' })], relationships: [] });

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
