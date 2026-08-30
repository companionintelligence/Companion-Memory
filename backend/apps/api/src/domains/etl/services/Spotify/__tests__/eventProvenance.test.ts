import { SpotifyRecentlyPlayedTransformService } from '../transform/TransformRecentlyPlayed';
import { SpotifySavedEpisodesTransformService } from '../transform/TransformSavedEpisodes';
import { SpotifySavedShowsTransformService } from '../transform/TransformSavedShows';
import { SpotifySavedTracksTransformService } from '../transform/TransformSavedTracks';

/**
 * One concern, four services: every Spotify transform that writes a
 * `ci.events` row must stamp the provenance triple, because
 * CalendarEventService.createOne only find-or-creates when source_type and source_id
 * are present — without them each re-sweep of the rolling recently-played
 * window / the saved lists minted a fresh event per item.
 */

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function makeDeps() {
  return {
    contentService: {
      search: jest.fn(async () => []),
      create: jest.fn(async () => [{ id: 'content-1' }]),
    },
    eventService: { create: jest.fn(async () => [{ id: 'event-1' }]) },
    graph: { ingest: jest.fn(async () => undefined) },
  };
}

const connection = { id: 'conn-1' } as never;

function syncJob(data: Record<string, unknown>) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data } as never;
}

const track = {
  id: 'track-1',
  name: 'Song',
  artists: [{ name: 'Artist' }],
  duration_ms: 180000,
  album: { name: 'Album' },
  external_urls: { spotify: 'https://open.spotify.com/track/track-1' },
};

function expectEventTriple(eventService: { create: jest.Mock }, sourceId: string) {
  expect(eventService.create).toHaveBeenCalledTimes(1);
  expect(eventService.create).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      source_type: 'ETL',
      source_system: 'spotify',
      source_id: sourceId,
    }),
  );
}

describe('Spotify event provenance triples', () => {
  it('Recently Played keys the play event on (track, played_at)', async () => {
    const deps = makeDeps();
    const service = new SpotifyRecentlyPlayedTransformService(
      deps.contentService as never,
      deps.eventService as never,
      deps.graph as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({ tracks: [{ track, played_at: '2026-08-20T10:00:00.000Z' }] }),
    });

    expectEventTriple(deps.eventService, 'play:track-1:2026-08-20T10:00:00.000Z');
  });

  it('Saved Tracks keys the save event on the track', async () => {
    const deps = makeDeps();
    const service = new SpotifySavedTracksTransformService(
      deps.contentService as never,
      deps.eventService as never,
      deps.graph as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({ tracks: [{ track, added_at: '2026-08-20T10:00:00.000Z' }] }),
    });

    expectEventTriple(deps.eventService, 'saved_track:track-1');
  });

  it('Saved Episodes keys the save event on the episode', async () => {
    const deps = makeDeps();
    const service = new SpotifySavedEpisodesTransformService(
      deps.contentService as never,
      deps.eventService as never,
      deps.graph as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        episodes: [
          {
            added_at: '2026-08-20T10:00:00.000Z',
            episode: {
              id: 'ep-1',
              name: 'Episode',
              duration_ms: 1800000,
              show: { id: 'show-1', name: 'Show', publisher: 'Pub' },
              external_urls: { spotify: 'https://open.spotify.com/episode/ep-1' },
            },
          },
        ],
      }),
    });

    expectEventTriple(deps.eventService, 'saved_episode:ep-1');
  });

  it('Saved Shows keys the save event on the show', async () => {
    const deps = makeDeps();
    const service = new SpotifySavedShowsTransformService(
      deps.contentService as never,
      deps.eventService as never,
      deps.graph as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        shows: [
          {
            added_at: '2026-08-20T10:00:00.000Z',
            show: {
              id: 'show-1',
              name: 'Show',
              total_episodes: 10,
              media_type: 'audio',
              explicit: false,
              uri: 'spotify:show:show-1',
              external_urls: { spotify: 'https://open.spotify.com/show/show-1' },
            },
          },
        ],
      }),
    });

    expectEventTriple(deps.eventService, 'saved_show:show-1');
  });
});
