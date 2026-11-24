import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncRedditUserListing, type RedditPost } from '../redditListing';

function createMockClient(responses: unknown[]) {
  let callIndex = 0;

  return {
    logger: {
      log: jest.fn(),
      error: jest.fn(),
    },
    request: jest.fn(async () => {
      const response = responses[callIndex];
      callIndex++;

      return response;
    }),
  } as unknown as BaseClient;
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'connection-1',
    externalId: 'testuser',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Connection;
}

function listingResponse(posts: RedditPost[], after: string | null = null) {
  return {
    kind: 'Listing',
    data: {
      after,
      before: null,
      dist: posts.length,
      children: posts.map((post) => ({
        kind: 't3',
        data: post,
      })),
    },
  };
}

describe('syncRedditUserListing', () => {
  const post = (createdUtc: number, id = 'abc123'): RedditPost => ({
    id,
    name: `t3_${id}`,
    title: `Post ${id}`,
    url: 'https://example.com',
    permalink: `/r/test/comments/${id}/`,
    subreddit: 'test',
    author: 'testuser',
    created_utc: createdUtc,
    score: 1,
    num_comments: 0,
    is_self: true,
  });

  it('returns one historical page and preserves after cursor', async () => {
    const client = createMockClient([listingResponse([post(1_700_000_000)], 't3_next')]);

    const result = await syncRedditUserListing({
      connection: createConnection(),
      client,
      nextCursor: {},
      historical: true,
      listingKind: 'submitted',
      dataKey: 'posts',
    });

    expect(result.data.posts).toHaveLength(1);
    expect(result.nextCursor).toEqual({ after: 't3_next' });
    expect(client.request).toHaveBeenCalledWith(
      expect.anything(),
      '/user/testuser/submitted?limit=100&sort=new',
    );
  });

  it('stops incremental sync when items are older than since cursor', async () => {
    const client = createMockClient([
      listingResponse([post(1_800_000_000, 'new'), post(1_700_000_000, 'old')], 't3_more'),
    ]);

    const result = await syncRedditUserListing({
      connection: createConnection(),
      client,
      nextCursor: {
        since: '2026-06-01T00:00:00.000Z',
      },
      historical: false,
      listingKind: 'submitted',
      dataKey: 'posts',
    });

    expect(result.data.posts).toHaveLength(1);
    expect((result.data.posts as RedditPost[])[0].id).toBe('new');
    expect(result.nextCursor).toEqual({
      since: expect.any(String),
    });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  describe('incremental saved', () => {
    const run = (client: BaseClient, nextCursor: Record<string, unknown>) =>
      syncRedditUserListing({
        connection: createConnection(),
        client,
        nextCursor,
        historical: false,
        listingKind: 'saved',
        dataKey: 'saved',
      });

    const names = (result: { data: Record<string, unknown> }) =>
      (result.data.saved as RedditPost[]).map((item) => item.name);

    it('keeps a newly saved item whose post is older than the last sync', async () => {
      // The regression: the listing is ordered by save time, so an old post just
      // saved sits on top with an old created_utc. A date cutoff dropped it.
      const client = createMockClient([
        listingResponse([post(1_600_000_000, 'justsaved'), post(1_800_000_000, 'prev')], 't3_more'),
      ]);

      const result = await run(client, { seen: ['t3_prev'] });

      expect(names(result)).toEqual(['t3_justsaved']);
      expect(result.nextCursor).toEqual({ seen: ['t3_justsaved', 't3_prev'] });
      expect(client.request).toHaveBeenCalledTimes(1);
    });

    it('walks further pages until it reaches a marker', async () => {
      const client = createMockClient([
        listingResponse([post(1, 'a'), post(2, 'b')], 't3_b'),
        listingResponse([post(3, 'c'), post(4, 'prev'), post(5, 'older')], 't3_older'),
      ]);

      const result = await run(client, { seen: ['t3_prev'] });

      expect(names(result)).toEqual(['t3_a', 't3_b', 't3_c']);
      expect(client.request).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        '/user/testuser/saved?limit=100&sort=new&after=t3_b',
      );
    });

    it('takes one page when there are no markers yet, including a cursor the date-based code wrote', async () => {
      for (const nextCursor of [{}, { since: '2026-06-01T00:00:00.000Z' }]) {
        const client = createMockClient([listingResponse([post(1, 'x'), post(2, 'y')], 't3_more')]);

        const result = await run(client, nextCursor);

        expect(names(result)).toEqual(['t3_x', 't3_y']);
        expect(result.nextCursor).toEqual({ seen: ['t3_x', 't3_y'] });
        expect(client.request).toHaveBeenCalledTimes(1);
      }
    });

    it('returns nothing and keeps its markers when nothing new was saved', async () => {
      const client = createMockClient([listingResponse([post(1, 'prev'), post(2, 'older')], 't3_older')]);

      const result = await run(client, { seen: ['t3_prev', 't3_older'] });

      expect(names(result)).toEqual([]);
      expect(result.nextCursor).toEqual({ seen: ['t3_prev', 't3_older'] });
    });

    it('stops at the next marker when the newest one was unsaved', async () => {
      const client = createMockClient([listingResponse([post(1, 'new'), post(2, 'second')], 't3_second')]);

      // t3_gone was the newest marker and is no longer in the listing.
      const result = await run(client, { seen: ['t3_gone', 't3_second'] });

      expect(names(result)).toEqual(['t3_new']);
      expect(client.request).toHaveBeenCalledTimes(1);
    });

    it('remembers at most 25 markers', async () => {
      const page = Array.from({ length: 30 }, (_, i) => post(i, `n${i}`));
      const client = createMockClient([listingResponse(page, null)]);

      const result = await run(client, {});

      expect((result.nextCursor as { seen: string[] }).seen).toHaveLength(25);
      expect((result.nextCursor as { seen: string[] }).seen[0]).toBe('t3_n0');
    });
  });

  it('throws when connection is missing username', async () => {
    const client = createMockClient([]);

    await expect(
      syncRedditUserListing({
        connection: createConnection({ externalId: null }),
        client,
        nextCursor: {},
        historical: true,
        listingKind: 'submitted',
        dataKey: 'posts',
      }),
    ).rejects.toThrow('Reddit connection missing username');
  });
});
