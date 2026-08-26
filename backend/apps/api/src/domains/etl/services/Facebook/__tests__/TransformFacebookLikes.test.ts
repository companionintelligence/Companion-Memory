import { FacebookLikesTransformService, pageEntityKey } from '../transform/TransformFacebookLikes';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const eventService = { create: jest.fn(async () => [{ id: 'event-1' }]) };
  const contentService = { search: jest.fn(async () => []), remove: jest.fn(async () => true) };
  type IngestResult = {
    entitiesProcessed: number;
    relationshipsProcessed: number;
    errors: string[];
    entities: Array<{ key: string; entityId: string }>;
  };
  const graphIngestService = {
    ingest: jest.fn(
      async (_ctx: unknown, input: { entities: Array<{ key: string }> }): Promise<IngestResult> => ({
        entitiesProcessed: input.entities.length,
        relationshipsProcessed: input.entities.length,
        errors: [],
        entities: input.entities.map((e, i) => ({ key: e.key, entityId: `org-${i + 1}` })),
      }),
    ),
  };

  const service = new FacebookLikesTransformService(
    eventService as never,
    contentService as never,
    graphIngestService as never,
    makeLogger() as never,
  );

  return { service, eventService, contentService, graphIngestService };
}

const connection = { id: 'conn-1' } as never;

function syncJobWith(likes: unknown[]) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { likes } } as never;
}

const lifescope = {
  id: '170342537143457',
  name: 'LifeScope',
  category: 'Software Company',
  link: 'https://www.facebook.com/170342537143457',
  created_time: '2018-07-10T20:51:35+0000',
  cover: { id: 'c', cover_id: 'c', source: 'https://cdn/cover.png', offset_x: 50, offset_y: 36 },
};

describe('FacebookLikesTransformService.transform', () => {
  it('ingests each liked Page as an Organization node with a SUBSCRIBES_TO edge from the user', async () => {
    const { service, graphIngestService } = build();

    await service.transform({ connection, syncJob: syncJobWith([lifescope]) });

    expect(graphIngestService.ingest).toHaveBeenCalledTimes(1);
    expect(graphIngestService.ingest).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        entities: [
          expect.objectContaining({
            key: 'facebook:organization:170342537143457',
            entityType: 'Organization',
            name: 'LifeScope',
            description: 'Software Company',
            sourceSystem: 'facebook',
            properties: expect.objectContaining({
              facebook_page_id: '170342537143457',
              category: 'Software Company',
              url: 'https://www.facebook.com/170342537143457',
              cover_url: 'https://cdn/cover.png',
            }),
          }),
        ],
        relationships: [
          expect.objectContaining({
            fromKey: 'self',
            toKey: 'facebook:organization:170342537143457',
            type: 'SUBSCRIBES_TO',
            properties: expect.objectContaining({ source: 'facebook', liked_at: '2018-07-10T20:51:35+0000' }),
          }),
        ],
      },
    );
  });

  it('writes a social.like Event titled after the Page, at the like time, with the Organization as participant', async () => {
    const { service, eventService } = build();

    await service.transform({ connection, syncJob: syncJobWith([lifescope]) });

    expect(eventService.create).toHaveBeenCalledTimes(1);
    expect(eventService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        title: 'Liked Facebook page LifeScope',
        description: 'LifeScope — Software Company',
        event_type: 'social.like',
        category: 'social',
        start_time: new Date('2018-07-10T20:51:35+0000'),
        time_source: 'source',
        participant_entity_ids: ['org-1'],
        source_type: 'ETL',
        source_system: 'facebook',
        source_id: 'like:170342537143457',
        metadata: expect.objectContaining({
          facebook_page_id: '170342537143457',
          page_name: 'LifeScope',
          page_category: 'Software Company',
          organization_entity_id: 'org-1',
        }),
      }),
    );
  });

  it('still writes the event (without a participant) when the Page failed to ingest', async () => {
    const { service, eventService, graphIngestService } = build();
    graphIngestService.ingest.mockResolvedValue({
      entitiesProcessed: 0,
      relationshipsProcessed: 0,
      errors: ['boom'],
      entities: [],
    });

    await service.transform({ connection, syncJob: syncJobWith([lifescope]) });

    expect(eventService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ title: 'Liked Facebook page LifeScope', participant_entity_ids: undefined }),
    );
  });

  it('marks the time as ingest-stamped when Facebook gives no created_time', async () => {
    const { service, eventService } = build();

    await service.transform({
      connection,
      syncJob: syncJobWith([{ ...lifescope, created_time: undefined }]),
    });

    expect(eventService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ time_source: 'ingest' }),
    );
  });

  it('removes the text/plain content row the old transform wrote for the Page', async () => {
    const { service, contentService } = build();
    contentService.search.mockResolvedValue([
      { id: 'old-like', sourceData: { contentType: 'facebook_like' } },
      { id: 'a-photo', sourceData: { contentType: 'facebook_photo' } },
    ] as never);

    await service.transform({ connection, syncJob: syncJobWith([lifescope]) });

    expect(contentService.search).toHaveBeenCalledWith({ userId: 'user-1' }, { external_id: lifescope.id });
    expect(contentService.remove).toHaveBeenCalledTimes(1);
    expect(contentService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'old-like');
  });

  it('does nothing — and does not touch the graph — for an empty page of likes', async () => {
    const { service, eventService, graphIngestService } = build();

    await service.transform({ connection, syncJob: syncJobWith([]) });

    expect(graphIngestService.ingest).not.toHaveBeenCalled();
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('keeps going past one like that fails', async () => {
    const { service, eventService } = build();
    eventService.create.mockRejectedValueOnce(new Error('boom'));

    await service.transform({
      connection,
      syncJob: syncJobWith([lifescope, { ...lifescope, id: '2', name: 'Amazon.com' }]),
    });

    expect(eventService.create).toHaveBeenCalledTimes(2);
  });
});

describe('pageEntityKey', () => {
  it('is stable per page id', () => {
    expect(pageEntityKey('9465008123')).toBe('facebook:organization:9465008123');
  });
});
