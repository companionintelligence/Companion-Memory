import { BadRequestException } from '@nestjs/common';

import { GraphIngestResolver } from '../GraphIngestResolver';

/**
 * The owner's autonomy dial is stored at `properties.planner.trust_mode` on their own Person, and
 * bulk graph ingest can reach that row: sourceSystem `self` is where the self Person is keyed, and
 * a re-ingest merges what it is sent. Over /api/mcp that made this mutation a way to switch tool
 * approvals off. No import carries settings, so an entity that does is refused.
 */
describe('GraphIngestResolver.bulkIngestGraph and the owner settings', () => {
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

  it('refuses an entity that carries a planner property, before anything is written', async () => {
    const { resolver: subject, ingest } = resolver();

    await expect(
      subject.bulkIngestGraph(
        context as never,
        {
          entities: [
            {
              key: `self:user:${context.userId}`,
              entityType: 'Person',
              sourceSystem: 'self',
              properties: { planner: { trust_mode: 'hands_off' } },
            },
          ],
          relationships: [],
        } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(ingest).not.toHaveBeenCalled();
  });

  it('refuses an entity that claims to be the account holder', async () => {
    const { resolver: subject, ingest } = resolver();

    await expect(
      subject.bulkIngestGraph(
        context as never,
        {
          entities: [
            {
              key: 'agent:person:planted',
              entityType: 'Person',
              sourceSystem: 'agent',
              properties: { is_self: true },
            },
          ],
          relationships: [],
        } as never,
      ),
    ).rejects.toThrow(/"is_self"/);

    expect(ingest).not.toHaveBeenCalled();
  });

  it('ingests ordinary entities as before', async () => {
    const { resolver: subject, ingest } = resolver();

    await subject.bulkIngestGraph(
      context as never,
      {
        entities: [
          {
            key: 'google-contacts:contact:alex@example.com',
            entityType: 'Person',
            sourceSystem: 'google-contacts',
            properties: { emails: ['alex@example.com'] },
          },
        ],
        relationships: [],
      } as never,
    );

    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
