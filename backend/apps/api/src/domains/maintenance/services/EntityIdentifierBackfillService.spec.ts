import { EntityIdentifierBackfillService } from './EntityIdentifierBackfillService';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeService(rows: unknown[][] = [[]]) {
  const dataSource = {
    query: jest.fn(),
  };
  for (const result of rows) {
    dataSource.query.mockResolvedValueOnce(result);
  }

  const entityIdentifierService = {
    upsertForEntities: jest.fn(async () => 0),
  };
  const graphIngestService = {
    ensureSelfEntityForOwner: jest.fn(async () => ({ id: 'self-1', type: 'Person' })),
  };
  const logger = { setContext: jest.fn(), log: jest.fn() };
  const service = new EntityIdentifierBackfillService(
    dataSource as never,
    entityIdentifierService as never,
    graphIngestService as never,
    logger as never,
  );

  return { service, dataSource, entityIdentifierService, graphIngestService };
}

describe('EntityIdentifierBackfillService', () => {
  it('indexes identifier properties in pages and repairs the owner self entity', async () => {
    const { service, entityIdentifierService, graphIngestService, dataSource } = makeService([
      [
        {
          entity_id: 'person-1',
          created_at: '2026-01-01T00:00:00.000Z',
          properties: { emails: ['Alice@Example.com'], phones: ['+1 (404) 435-2149'] },
        },
        {
          entity_id: 'person-2',
          created_at: '2026-01-02T00:00:00.000Z',
          properties: { email: 'bob@example.com', names: ['Bob Example'] },
        },
      ],
      [],
    ]);
    entityIdentifierService.upsertForEntities.mockResolvedValueOnce(4);

    const result = await service.backfill(USER_ID, { pageSize: 2 });

    expect(result).toEqual({
      examined: 2,
      identifiersSeen: 4,
      entitiesWithIdentifiers: 2,
      identifiersIndexed: 4,
      selfEntityId: 'self-1',
      errors: [],
    });
    expect(graphIngestService.ensureSelfEntityForOwner).toHaveBeenCalledWith({ userId: USER_ID });
    expect(entityIdentifierService.upsertForEntities).toHaveBeenCalledWith(USER_ID, [
      {
        entityId: 'person-1',
        raw: { emails: ['Alice@Example.com'], phones: ['+1 (404) 435-2149'] },
        source: 'backfill:entity-properties',
      },
      {
        entityId: 'person-2',
        raw: { emails: ['bob@example.com'], names: ['Bob Example'] },
        source: 'backfill:entity-properties',
      },
    ]);
    expect(dataSource.query).toHaveBeenCalledTimes(2);
  });

  it('is safe when a Person has no usable identity properties', async () => {
    const { service, entityIdentifierService } = makeService([
      [
        {
          entity_id: 'person-1',
          created_at: '2026-01-01T00:00:00.000Z',
          properties: { email: '', phones: ['not a phone'], names: [''] },
        },
      ],
      [],
    ]);

    await expect(service.backfill(USER_ID)).resolves.toMatchObject({
      examined: 1,
      identifiersSeen: 0,
      entitiesWithIdentifiers: 0,
      identifiersIndexed: 0,
      errors: [],
    });
    expect(entityIdentifierService.upsertForEntities).not.toHaveBeenCalled();
  });

  it('continues scanning when one identifier page fails', async () => {
    const { service, dataSource, entityIdentifierService } = makeService([
      [
        {
          entity_id: 'person-1',
          created_at: '2026-01-01T00:00:00.000Z',
          properties: { emails: ['first@example.com'] },
        },
      ],
      [
        {
          entity_id: 'person-2',
          created_at: '2026-01-02T00:00:00.000Z',
          properties: { emails: ['second@example.com'] },
        },
      ],
      [],
    ]);
    entityIdentifierService.upsertForEntities
      .mockRejectedValueOnce(new Error('temporary index failure'))
      .mockResolvedValueOnce(1);

    const result = await service.backfill(USER_ID, { pageSize: 1 });

    expect(result.examined).toBe(2);
    expect(result.identifiersSeen).toBe(2);
    expect(result.identifiersIndexed).toBe(1);
    expect(result.errors).toEqual(['index page: temporary index failure']);
    expect(dataSource.query).toHaveBeenCalledTimes(3);
  });
});
