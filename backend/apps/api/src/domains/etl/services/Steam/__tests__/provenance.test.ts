import { SteamAchievementsTransformService } from '../transform/TransformAchievements';
import { SteamFriendsTransformService } from '../transform/TransformFriends';
import { SteamOwnedGamesTransformService } from '../transform/TransformOwnedGames';

/**
 * Steam events carried source_type: 'ETL' alone — which engages neither
 * CalendarEventService.createOne's find-or-create (it needs source_id too) nor
 * events_source_identity_uniq — and content rows carried no triple. Dedup
 * rested entirely on app-level pre-checks (for friends, on whether the person
 * row already existed). These tests pin the full triples.
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
    eventService: {
      search: jest.fn(async () => []),
      create: jest.fn(async () => [{ id: 'event-1' }]),
    },
    personService: {
      search: jest.fn(async () => []),
      create: jest.fn(async () => ({ id: 'person-1' })),
    },
  };
}

const connection = { id: 'conn-1' } as never;

function syncJob(data: Record<string, unknown>) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data } as never;
}

describe('Steam provenance triples', () => {
  it('Owned Games stamps the triple on the game content row and keys the play event per rtime_last_played', async () => {
    const deps = makeDeps();
    const service = new SteamOwnedGamesTransformService(
      deps.contentService as never,
      deps.eventService as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        games: [{ appid: 440, name: 'Team Fortress 2', playtime_forever: 60, rtime_last_played: 1700000000 }],
      }),
    });

    expect(deps.contentService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source_type: 'ETL', source_system: 'steam', source_id: 'game:440' }),
    );
    expect(deps.eventService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'steam',
        source_id: 'played:440:1700000000',
      }),
    );
  });

  it('Achievements stamps the triple on content and event, with no timestamp in the event key', async () => {
    const deps = makeDeps();
    const service = new SteamAchievementsTransformService(
      deps.contentService as never,
      deps.eventService as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        achievements: [
          {
            gameName: 'Team Fortress 2',
            appid: 440,
            achievement: { apiname: 'TF_GET_HEADSHOTS', achieved: 1, unlocktime: 1700000000 },
          },
        ],
      }),
    });

    expect(deps.contentService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'steam',
        source_id: 'achievement:440_TF_GET_HEADSHOTS',
      }),
    );
    expect(deps.eventService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'steam',
        source_id: 'achievement_unlocked:440_TF_GET_HEADSHOTS',
      }),
    );
  });

  it('Friends gives the friendship event its own key instead of riding on the person-exists check', async () => {
    const deps = makeDeps();
    const service = new SteamFriendsTransformService(
      deps.personService as never,
      deps.eventService as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        friends: [
          {
            steamid: '7656119',
            personaname: 'Friend',
            profileurl: 'https://steamcommunity.com/id/friend',
            avatar: '',
            avatarfull: '',
            friend_since: 1700000000,
          },
        ],
      }),
    });

    expect(deps.eventService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'steam',
        source_id: 'friend_added:7656119',
      }),
    );
  });
});
