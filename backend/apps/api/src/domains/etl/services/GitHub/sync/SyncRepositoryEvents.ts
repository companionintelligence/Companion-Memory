import type { BaseClient, Connection } from '@ci/domains/connections';

import type {
  GitHubEvent,
  GitHubRepository,
  GitHubRepositoryEvents,
  GitHubRepositoryEventsCursor,
} from '../types';

const REPOSITORIES_PER_PAGE = 100;
const EVENTS_PER_PAGE = 100;

function parseCursor(nextCursor: Record<string, unknown>): Required<GitHubRepositoryEventsCursor> {
  return {
    since: typeof nextCursor.since === 'string' ? nextCursor.since : '',
    repoPage: typeof nextCursor.repoPage === 'number' ? nextCursor.repoPage : 1,
    repoIndex: typeof nextCursor.repoIndex === 'number' ? nextCursor.repoIndex : 0,
    eventPage: typeof nextCursor.eventPage === 'number' ? nextCursor.eventPage : 1,
  };
}

export async function syncRepositoryEvents({
  connection,
  client,
  nextCursor,
  historical = false,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  const cursor = parseCursor(nextCursor);

  try {
    client.logger.log(
      `Performing ${historical ? 'historical' : 'incremental'} GitHub Repository Events sync`,
      {
        connectionId: connection.id,
        cursor,
      },
    );

    const repoParams = new URLSearchParams({
      affiliation: 'owner,collaborator,organization_member',
      sort: 'updated',
      direction: 'desc',
      per_page: String(REPOSITORIES_PER_PAGE),
      page: String(cursor.repoPage),
    });

    const repositories = await client.request<GitHubRepository[]>(
      connection,
      `/user/repos?${repoParams.toString()}`,
    );
    const repository = repositories[cursor.repoIndex];

    if (!repository) {
      return {
        data: {
          repoEvents: [],
        },
        nextCursor: historical ? {} : { since: new Date().toISOString() },
      };
    }

    const eventPage = historical ? cursor.eventPage : 1;
    const eventsParams = new URLSearchParams({
      per_page: String(EVENTS_PER_PAGE),
      page: String(eventPage),
    });

    let events: GitHubEvent[] = [];

    try {
      events = await client.request<GitHubEvent[]>(
        connection,
        `/repos/${repository.owner.login}/${repository.name}/events?${eventsParams.toString()}`,
      );
    } catch (error) {
      client.logger.error('Failed to fetch GitHub repository events, skipping repository', {
        connectionId: connection.id,
        repository: repository.full_name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    const since = cursor.since || connection.createdAt.toISOString();
    const repoEvents: GitHubRepositoryEvents[] = [
      {
        repository,
        events: historical
          ? events
          : events.filter((event) => new Date(event.created_at).getTime() > new Date(since).getTime()),
      },
    ];

    const hasMoreEventPages = historical && events.length === EVENTS_PER_PAGE;
    const hasMoreReposOnPage = cursor.repoIndex + 1 < repositories.length;
    const nextRepoPage = hasMoreReposOnPage ? cursor.repoPage : cursor.repoPage + 1;
    const nextRepoIndex = hasMoreReposOnPage ? cursor.repoIndex + 1 : 0;

    return {
      data: {
        repoEvents,
      },
      nextCursor: hasMoreEventPages
        ? {
            repoPage: cursor.repoPage,
            repoIndex: cursor.repoIndex,
            eventPage: eventPage + 1,
            ...(cursor.since ? { since: cursor.since } : {}),
          }
        : historical
          ? {
              repoPage: nextRepoPage,
              repoIndex: nextRepoIndex,
              eventPage: 1,
            }
          : {
              since,
              repoPage: nextRepoPage,
              repoIndex: nextRepoIndex,
            },
    };
  } catch (err) {
    client.logger.error('Failed to sync GitHub Repository Events', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
