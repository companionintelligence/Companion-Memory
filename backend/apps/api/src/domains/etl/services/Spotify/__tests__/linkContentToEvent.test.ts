import type { Connection } from '@ci/domains/connections';

import type { ConnectionSyncJob } from '../../../types';
import { SPOTIFY_ETL_EDGE_SOURCE, upsertContentForEvent } from '../transform/linkContentToEvent';
import { SpotifyRecentlyPlayedTransformService } from '../transform/TransformRecentlyPlayed';
import { SpotifySavedEpisodesTransformService } from '../transform/TransformSavedEpisodes';
import { SpotifySavedShowsTransformService } from '../transform/TransformSavedShows';
import { SpotifySavedTracksTransformService } from '../transform/TransformSavedTracks';

/**
 * A Spotify track/episode/show is stored once but played or saved many times.
 * Before this, every transform wrote the content row and the event as two
 * unrelated rows — `Event.contents` in the sidebar came back empty for every
 * Spotify event. These tests pin the link: the first occurrence sets
 * `content.event_id` via `event: { id }`, and EVERY occurrence gets a
 * `Content -DOCUMENTS-> Event` edge so later plays reach the track too.
 */

function makeMocks() {
  let nextEvent = 0;
  const contentService = {
    search: jest.fn().mockResolvedValue([]),
    create: jest
      .fn()
      .mockImplementation(async (_ctx: unknown, dto: { id?: string }) => [{ id: dto.id ?? 'content-1' }]),
  };
  const eventService = {
    create: jest.fn().mockImplementation(async () => [{ id: `event-${++nextEvent}` }]),
  };
  const graph = { ingest: jest.fn().mockResolvedValue({ errors: [] }) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  return { contentService, eventService, graph, logger };
}

const context = { userId: 'user-1' } as never;
const connection = { id: 'conn-1' } as unknown as Connection;

function edgesOf(graph: { ingest: jest.Mock }) {
  return graph.ingest.mock.calls.flatMap(([, input]) => input.relationships);
}

describe('upsertContentForEvent', () => {
  it('creates the content row pointing at the event and writes the DOCUMENTS edge', async () => {
    const m = makeMocks();

    const result = await upsertContentForEvent({
      context,
      contentService: m.contentService as never,
      graph: m.graph as never,
      logger: m.logger as never,
      existing: [],
      eventId: 'event-1',
      input: { type: 'Music', external_id: 'track-1' },
    });

    expect(result).toEqual({ contentId: 'content-1', created: true });
    expect(m.contentService.create).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ event: { id: 'event-1' } }),
    );
    expect(edgesOf(m.graph)).toEqual([
      expect.objectContaining({
        fromEntityId: 'content-1',
        fromEntityType: 'Content',
        toEntityId: 'event-1',
        toEntityType: 'Event',
        type: 'DOCUMENTS',
        properties: { derived_from: SPOTIFY_ETL_EDGE_SOURCE },
      }),
    ]);
  });

  it('links an existing content row through the edge only, without re-creating it', async () => {
    const m = makeMocks();

    const result = await upsertContentForEvent({
      context,
      contentService: m.contentService as never,
      graph: m.graph as never,
      logger: m.logger as never,
      existing: [{ id: 'content-existing' } as never],
      eventId: 'event-2',
      input: { type: 'Music', external_id: 'track-1' },
    });

    expect(result).toEqual({ contentId: 'content-existing', created: false });
    expect(m.contentService.create).not.toHaveBeenCalled();
    expect(edgesOf(m.graph)).toEqual([
      expect.objectContaining({ fromEntityId: 'content-existing', toEntityId: 'event-2', type: 'DOCUMENTS' }),
    ]);
  });

  it('creates the content without any link when there is no event', async () => {
    const m = makeMocks();

    await upsertContentForEvent({
      context,
      contentService: m.contentService as never,
      graph: m.graph as never,
      logger: m.logger as never,
      existing: [],
      eventId: undefined,
      input: { type: 'Episode', external_id: 'ep-1' },
    });

    expect(m.contentService.create).toHaveBeenCalledWith(
      context,
      expect.not.objectContaining({ event: expect.anything() }),
    );
    expect(m.graph.ingest).not.toHaveBeenCalled();
  });

  it('is fail-soft on the edge write: the rows stay, the failure is logged', async () => {
    const m = makeMocks();
    m.graph.ingest.mockRejectedValueOnce(new Error('graph down'));

    const result = await upsertContentForEvent({
      context,
      contentService: m.contentService as never,
      graph: m.graph as never,
      logger: m.logger as never,
      existing: [],
      eventId: 'event-1',
      input: { type: 'Music', external_id: 'track-1' },
    });

    expect(result.created).toBe(true);
    expect(m.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('edge sweep'),
      expect.objectContaining({ eventId: 'event-1' }),
    );
  });
});

describe('Spotify transforms link every event to its content', () => {
  const track = {
    id: 'track-1',
    name: 'Abesses',
    duration_ms: 240000,
    artists: [{ name: 'Birdy Nam Nam' }],
    album: { name: 'Birdy Nam Nam' },
    external_urls: { spotify: 'https://open.spotify.com/track/track-1' },
  };

  function job(data: Record<string, unknown>): ConnectionSyncJob {
    return { userId: 'user-1', data } as unknown as ConnectionSyncJob;
  }

  it('recently played: two plays of one track share the content row; the first owns event_id, both get an edge', async () => {
    const m = makeMocks();
    // The second play finds the row the first one created.
    m.contentService.search.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'content-1' }]);
    const service = new SpotifyRecentlyPlayedTransformService(
      m.contentService as never,
      m.eventService as never,
      m.graph as never,
      m.logger as never,
    );

    await service.transform({
      connection,
      syncJob: job({
        tracks: [
          { track, played_at: '2011-08-06T22:55:12Z' },
          { track, played_at: '2011-08-08T13:26:29Z' },
        ],
      }),
    });

    expect(m.eventService.create).toHaveBeenCalledTimes(2);
    expect(m.contentService.create).toHaveBeenCalledTimes(1);
    expect(m.contentService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ external_id: 'track-1', event: { id: 'event-1' } }),
    );
    expect(edgesOf(m.graph).map((edge) => [edge.fromEntityId, edge.toEntityId])).toEqual([
      ['content-1', 'event-1'],
      ['content-1', 'event-2'],
    ]);
  });

  it('saved tracks: the save event is created before the content so the row can point at it', async () => {
    const m = makeMocks();
    const order: string[] = [];
    m.eventService.create.mockImplementation(async () => {
      order.push('event');

      return [{ id: 'event-1' }];
    });
    m.contentService.create.mockImplementation(async () => {
      order.push('content');

      return [{ id: 'content-1' }];
    });
    const service = new SpotifySavedTracksTransformService(
      m.contentService as never,
      m.eventService as never,
      m.graph as never,
      m.logger as never,
    );

    await service.transform({
      connection,
      syncJob: job({ tracks: [{ track, added_at: '2020-01-01T00:00:00Z' }] }),
    });

    expect(order).toEqual(['event', 'content']);
    expect(m.contentService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: { id: 'event-1' } }),
    );
    expect(edgesOf(m.graph)).toHaveLength(1);
  });

  it('saved episodes: an item without added_at still gets its content row, just no event or edge', async () => {
    const m = makeMocks();
    const service = new SpotifySavedEpisodesTransformService(
      m.contentService as never,
      m.eventService as never,
      m.graph as never,
      m.logger as never,
    );
    const episode = { id: 'ep-1', name: 'Ep', duration_ms: 60000, show: { name: 'Show' } };

    await service.transform({
      connection,
      syncJob: job({
        episodes: [{ episode }, { episode: { ...episode, id: 'ep-2' }, added_at: '2020-01-01T00:00:00Z' }],
      }),
    });

    expect(m.eventService.create).toHaveBeenCalledTimes(1);
    expect(m.contentService.create).toHaveBeenCalledTimes(2);
    expect(m.contentService.create).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.not.objectContaining({ event: expect.anything() }),
    );
    expect(m.contentService.create).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ event: { id: 'event-1' } }),
    );
    expect(edgesOf(m.graph)).toHaveLength(1);
  });

  it('saved shows: a show already imported as an Audiobook is linked to that row instead of duplicated', async () => {
    const m = makeMocks();
    m.contentService.search.mockImplementation(async (_ctx: unknown, query: { type: string }) =>
      query.type === 'Audiobook' ? [{ id: 'audiobook-1' }] : [],
    );
    const service = new SpotifySavedShowsTransformService(
      m.contentService as never,
      m.eventService as never,
      m.graph as never,
      m.logger as never,
    );

    await service.transform({
      connection,
      syncJob: job({ shows: [{ show: { id: 'show-1', name: 'A Book' }, added_at: '2020-01-01T00:00:00Z' }] }),
    });

    expect(m.contentService.create).not.toHaveBeenCalled();
    expect(m.eventService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Saved audiobook A Book' }),
    );
    expect(edgesOf(m.graph)).toEqual([
      expect.objectContaining({ fromEntityId: 'audiobook-1', toEntityId: 'event-1' }),
    ]);
  });
});
