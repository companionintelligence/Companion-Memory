import { RedditCommentsTransformService } from '../transform/TransformComments';
import { RedditPostsTransformService } from '../transform/TransformPosts';
import { RedditSavedTransformService } from '../transform/TransformSaved';

/**
 * The Reddit transforms deduped only through their racy search-then-create
 * pre-checks: events carried source_system + source_id but no source_type
 * (which disables both EventService.createOne's find-or-create and
 * events_source_triple_uniq — NULLs are distinct to it), and content rows
 * carried no triple at all. These tests pin the full triples that give both
 * writes a database backstop.
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
  };
}

const connection = { id: 'conn-1' } as never;

function syncJob(data: Record<string, unknown>) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data } as never;
}

describe('Reddit provenance triples', () => {
  it('Posts stamps the triple on both the content row and the event', async () => {
    const deps = makeDeps();
    const service = new RedditPostsTransformService(
      deps.contentService as never,
      deps.eventService as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        posts: [
          {
            id: 'abc',
            name: 't3_abc',
            permalink: '/r/test/comments/abc/hello/',
            title: 'Hello',
            selftext: 'Body',
            subreddit: 'test',
            score: 1,
            num_comments: 0,
            is_self: true,
            created_utc: 1700000000,
            url: '',
          },
        ],
      }),
    });

    expect(deps.contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ source_type: 'ETL', source_system: 'reddit', source_id: 't3_abc' }),
    );
    expect(deps.eventService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ source_type: 'ETL', source_system: 'reddit_posts', source_id: 't3_abc' }),
    );
  });

  it('Comments stamps the triple on both the content row and the event', async () => {
    const deps = makeDeps();
    const service = new RedditCommentsTransformService(
      deps.contentService as never,
      deps.eventService as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        comments: [
          {
            id: 'def',
            name: 't1_def',
            permalink: '/r/test/comments/abc/hello/def/',
            body: 'A comment',
            subreddit: 'test',
            link_title: 'Hello',
            score: 1,
            created_utc: 1700000000,
          },
        ],
      }),
    });

    expect(deps.contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ source_type: 'ETL', source_system: 'reddit', source_id: 't1_def' }),
    );
    expect(deps.eventService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'reddit_comments',
        source_id: 't1_def',
      }),
    );
  });

  it('Saved shares the content key with Posts/Comments (source_system reddit) so the same item dedupes across transforms', async () => {
    const deps = makeDeps();
    const service = new RedditSavedTransformService(
      deps.contentService as never,
      deps.eventService as never,
      makeLogger() as never,
    );

    await service.transform({
      connection,
      syncJob: syncJob({
        saved: [
          {
            id: 'abc',
            name: 't3_abc',
            permalink: '/r/test/comments/abc/hello/',
            title: 'Hello',
            selftext: 'Body',
            subreddit: 'test',
            score: 1,
            created_utc: 1700000000,
          },
        ],
      }),
    });

    expect(deps.contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ source_type: 'ETL', source_system: 'reddit', source_id: 't3_abc' }),
    );
    expect(deps.eventService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ source_type: 'ETL', source_system: 'reddit_saved', source_id: 't3_abc' }),
    );
  });
});
