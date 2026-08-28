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
