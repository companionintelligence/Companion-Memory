import { BadRequestException } from '@nestjs/common';

import { GraphIngestService } from '@ci/domains/graph';

import { GraphIngestResolver } from '../GraphIngestResolver';

/**
 * The owner's self Person sits at sourceSystem `self`, key `self:user:<account id>`: onboarding and
 * the import push both create it there (GraphIngestService.selfEntityLink), so the coordinates
 * follow from the account id alone. Bulk graph ingest merges whatever it is sent into the row at
 * an entity's coordinates, and over /api/mcp an agent could otherwise rename the owner or rewrite
 * their Person's properties. The server writes that row in-process and no client of this mutation
 * sends `self`, so an entity under it is refused.
 */
describe('GraphIngestResolver.bulkIngestGraph and the self sourceSystem', () => {
  function resolver() {
    const ingest = jest.fn(async () => ({
      entitiesProcessed: 1,
      relationshipsProcessed: 0,
      errors: [],
      entities: [],
    }));

    return { resolver: new GraphIngestResolver({ ingest } as never), ingest };
  }

  const context = { userId: '00000000-0000-0000-0000-0000000000aa' };

  it('refuses an entity under the sourceSystem the self Person is keyed by, before anything is written', async () => {
    const { resolver: subject, ingest } = resolver();

    await expect(
      subject.bulkIngestGraph(
        context as never,
        {
          entities: [
            {
              key: `self:user:${context.userId}`,
              entityType: 'Person',
              name: 'Someone Else',
              sourceSystem: 'self',
              properties: { emails: ['planted@example.com'] },
            },
          ],
          relationships: [],
        } as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(ingest).not.toHaveBeenCalled();
  });

  it('refuses the whole batch when one entity uses it', async () => {
    const { resolver: subject, ingest } = resolver();

    await expect(
      subject.bulkIngestGraph(
        context as never,
        {
          entities: [
            { key: 'importer:person:alex', entityType: 'Person', sourceSystem: 'importer' },
            { key: 'anything', entityType: 'Concept', sourceSystem: 'self' },
          ],
          relationships: [],
        } as never,
      ),
    ).rejects.toThrow(/sourceSystem "self"/);

    expect(ingest).not.toHaveBeenCalled();
  });

  it('is the sourceSystem behind the self Person’s linked key', () => {
    expect(GraphIngestService.selfEntityLink(context.userId).linkedTable).toBe('import:self');
  });

  it('still ingests self-anchored edges between entities of another sourceSystem', async () => {
    const { resolver: subject, ingest } = resolver();

    await subject.bulkIngestGraph(
      context as never,
      {
        entities: [
          {
            key: 'importer:concept:hiking',
            entityType: 'Concept',
            sourceSystem: 'importer',
            name: 'Hiking',
          },
        ],
        relationships: [{ fromKey: 'self', toKey: 'importer:concept:hiking', type: 'PREFERS' }],
      } as never,
    );

    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
