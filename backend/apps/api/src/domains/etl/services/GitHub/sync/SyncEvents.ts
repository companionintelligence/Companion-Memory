import type { BaseClient, Connection } from '@ci/domains/connections';

const PAGE_SIZE = 100;

export interface GithubEvent {
  id: number;
  type: string;
  actor: {
    id: number;
    login: string;
    display_login: string;
    gravatar_id: string;
    url: string;
    avatar_url: string;
  };
  repo: {
    id: number;
    name: string;
    url: string;
  };
  payload: Record<string, unknown>;
  public: boolean;
  created_at: string;
}

export interface GithubCommitCommentEvent extends GithubEvent {
  payload: {
    action: string;
    comment: {
      html_url: string;
      url: string;
      id: number;
      node_id: string;
      body: string;
      path: string;
      position: number;
      line: number;
      commit_id: string;
      author_association: string;
    };
  };
}

export interface GithubCreateEvent extends GithubEvent {
  payload: {
    ref: string;
    ref_type: string;
    full_ref: string;
    master_branch: string;
    description: string;
    pusher_type: string;
  };
}

export interface GithubDeleteEvent extends GithubEvent {
  payload: {
    ref: string;
    ref_type: string;
    full_ref: string;
    pusher_type: string;
  };
}

export interface GithubDiscussionEvent extends GithubEvent {
  payload: {
    action: string;
    discussion: {
      title: string;
      body_text: string;
    };
  };
}

export interface GithubForkEvent extends GithubEvent {
  payload: {
    action: string;
    forkee: {
      id: number;
      node_id: string;
      name: string;
      full_name: string;
      description: string;
      html_url: string;
      url: string;
    };
  };
}

export interface GithubIssueCommentEvent extends GithubEvent {
  payload: {
    action: string;
    issue: {
      id: number;
      node_id: string;
      url: string;
      repository_url: string;
      number: number;
      state: string;
      title: string;
      body: string;
    };
    comment: {
      id: number;
      node_id: string;
      url: string;
      html_url: string;
      body: string;
    };
  };
}

export interface GithubIssueEvent extends GithubEvent {
  payload: {
    action: string;
    issue: {
      id: number;
      node_id: string;
      url: string;
      repository_url: string;
      number: number;
      state: string;
      title: string;
      body: string;
    };
  };
}

export interface GithubPullRequestEvent extends GithubEvent {
  payload: {
    action: string;
    number: number;
    pull_request: {
      id: number;
      node_id: string;
      url: string;
      repository_url: string;
      number: number;
      state: string;
      title: string;
      body: string;
      updated_at: string;
    };
  };
}

export interface GithubPullRequestReviewEvent extends GithubEvent {
  payload: {
    action: string;
    pull_request: {
      id: number;
      node_id: string;
      url: string;
      repository_url: string;
      number: number;
      state: string;
      title: string;
      body: string;
    };
    review: {
      id: number;
      node_id: string;
      body: string;
      state: string;
      html_url: string;
      pull_request_url: string;
      commit_id: string;
    };
  };
}

export interface GithubPullRequestReviewCommentEvent extends GithubEvent {
  payload: {
    action: string;
    pull_request: {
      id: number;
      node_id: string;
      url: string;
      repository_url: string;
      number: number;
      state: string;
      title: string;
      body: string;
    };
    comment: {
      html_url: string;
      url: string;
      id: number;
      node_id: string;
      body: string;
      path: string;
      position: number;
      line: number;
      commit_id: string;
      author_association: string;
    };
  };
}

export interface GithubPushEvent extends GithubEvent {
  payload: {
    repository_id: number;
    push_id: number;
    ref: string;
    head: string;
    before: string;
  };
}

export interface GithubReleaseEvent extends GithubEvent {
  payload: {
    action: string;
    release: {
      url: string;
      html_url: string;
      id: number;
      node_id: string;
      tag_name: string;
      name: string;
      body: string;
    };
  };
}

/**
 * Parse the GitHub 'Link' response header and extract the URL for a given rel.
 * Example header:
 *   <https://api.github.com/repositories/1/events?page=2>; rel="next", <…>; rel="last"
 */
function parseLinkHeader(header: string | null, rel: string) {
  if (!header) {
    return null;
  }

  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === rel) {
      return match[1];
    }
  }

  return null;
}

/**
 * Fetch all repos the authenticated user has access to, paginating through
 * the GitHub /user/repos endpoint until there are no more pages.
 */
async function fetchAllRepos(client: BaseClient, connection: Connection) {
  const repos: string[] = [];
  let endpoint: string | null = `/user/repos?per_page=${PAGE_SIZE}`;

  while (endpoint) {
    const response = await client.requestRaw(connection, endpoint);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Failed to fetch repos: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = (await response.json()) as Array<{ full_name: string }>;
    for (const repo of data) {
      repos.push(repo.full_name);
    }

    const linkHeader = response.headers.get('link');
    endpoint = parseLinkHeader(linkHeader, 'next');
  }

  return repos;
}

/**
 * Determine whether a cursor value is an ETag (i.e. the repo finished its
 * initial historical crawl) versus a pagination URL or `false`.
 *
 * Pagination URLs always start with "http". ETags never do (they're typically
 * quoted strings like `W/"abc123"` or `"abc123"`).
 * `false` means the repo has been fully enumerated in a single invocation
 * but hasn't yet received its final ETag.
 */
function cursorIsEtag(cursor: unknown): cursor is string {
  return typeof cursor === 'string' && !cursor.startsWith('http');
}

function cursorIsNextPageUrl(cursor: unknown): cursor is string {
  return typeof cursor === 'string' && cursor.startsWith('http');
}

export async function syncEvents({
  connection,
  client,
  nextCursor,
  historical,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}) {
  try {
    client.logger.log('Performing GitHub Events sync', {
      connectionId: connection.id,
      nextCursor,
    });

    // ── Step 1: Fetch all repos ──────────────────────────────────────────
    const repos = await fetchAllRepos(client, connection);

    client.logger.log('Fetched repos for GitHub Events sync', {
      connectionId: connection.id,
      repoCount: repos.length,
    });

    // ── Step 2: For each repo, fetch one page of events ─────────────────
    const eventsMap: Record<string, unknown[]> = {};
    const newCursor: Record<string, string | false> = {};

    for (const repoFullName of repos) {
      const existingCursor = nextCursor[repoFullName];

      // If cursor is `false`, this repo was fully paginated in a previous
      // invocation and there was no next page. Skip it entirely — it's done.
      if (existingCursor === false) {
        eventsMap[repoFullName] = [];
        newCursor[repoFullName] = false;
        continue;
      }

      let endpoint: string;
      const headers: Record<string, string> = {};

      if (cursorIsNextPageUrl(existingCursor)) {
        // Historical mid-pagination — continue from the saved URL.
        endpoint = existingCursor;
      } else if (!historical && cursorIsEtag(existingCursor)) {
        // Incremental with existing ETag — conditional request.
        endpoint = `/repos/${repoFullName}/events?per_page=${PAGE_SIZE}`;
        headers['If-None-Match'] = existingCursor;
      } else {
        // First-ever call for this repo (historical or incremental).
        endpoint = `/repos/${repoFullName}/events?per_page=${PAGE_SIZE}`;
      }

      const response = await client.requestRaw(connection, endpoint, { headers });

      // 304 Not Modified — no new events since the saved ETag.
      if (response.status === 304) {
        const etag = response.headers.get('etag') || (existingCursor as string);
        eventsMap[repoFullName] = [];
        newCursor[repoFullName] = historical ? false : etag;

        client.logger.log('GitHub Events: no new events (304)', {
          connectionId: connection.id,
          repo: repoFullName,
        });
        continue;
      }

      if (!response.ok) {
        // Non-fatal: log the error and treat this repo as having no events
        // so the rest of the sync can proceed.
        const errorText = await response.text().catch(() => 'Unknown error');
        client.logger.error('GitHub Events: failed to fetch repo events', {
          connectionId: connection.id,
          repo: repoFullName,
          status: response.status,
          error: errorText,
        });
        eventsMap[repoFullName] = [];
        newCursor[repoFullName] = typeof existingCursor === 'string' ? existingCursor : false;
        continue;
      }

      const events = ((await response.json()) as GithubEvent[]).filter(
        (event) => event.actor?.id.toString() === connection.externalId,
      );

      await Promise.all(
        events.map(async (event) => {
          if (event.type === 'PullRequestEvent') {
            const thisEvent = event as GithubPullRequestEvent;
            const detailsResponse = await client.requestRaw(
              connection,
              thisEvent.payload.pull_request.url,
              {},
            );

            if (!detailsResponse.ok) {
              const errorText = await detailsResponse.text().catch(() => 'Unknown error');
              client.logger.error('GitHub Events: failed to fetch PR details', {
                connectionId: connection.id,
                repo: repoFullName,
                status: detailsResponse.status,
                error: errorText,
              });

              return;
            }

            event.payload.pull_request =
              (await detailsResponse.json()) as GithubPullRequestEvent['payload']['pull_request'];

            return;
          } else {
            return;
          }
        }),
      );

      eventsMap[repoFullName] = events;

      const linkHeader = response.headers.get('link');
      let nextPageUrl = parseLinkHeader(linkHeader, 'next');

      if (historical) {
        // Historical: one page per repo per invocation.
        // Save next-page URL if more pages remain, otherwise defaults to false, which indicates end.
        newCursor[repoFullName] = nextPageUrl || false;
      } else if (!cursorIsEtag(existingCursor)) {
        // Incremental first run (no ETag yet): single page to seed an ETag.
        const etag = response.headers.get('etag');
        newCursor[repoFullName] = etag || false;
      } else {
        // Incremental with existing ETag: paginate through ALL remaining pages
        // in a single invocation so we catch up completely.
        const firstPageEtag = response.headers.get('etag');

        while (nextPageUrl) {
          const pageResponse = await client.requestRaw(connection, nextPageUrl);

          if (!pageResponse.ok) {
            const errorText = await pageResponse.text().catch(() => 'Unknown error');
            client.logger.error('GitHub Events: failed to fetch subsequent events page', {
              connectionId: connection.id,
              repo: repoFullName,
              status: pageResponse.status,
              error: errorText,
            });
            break;
          }

          const pageEvents = ((await pageResponse.json()) as GithubEvent[]).filter(
            (event) => event.actor?.id.toString() === connection.externalId,
          );

          await Promise.all(
            pageEvents.map(async (event) => {
              if (event.type === 'PullRequestEvent') {
                const thisEvent = event as GithubPullRequestEvent;
                const detailsResponse = await client.requestRaw(
                  connection,
                  thisEvent.payload.pull_request.url,
                  {},
                );

                if (!detailsResponse.ok) {
                  const errorText = await detailsResponse.text().catch(() => 'Unknown error');
                  client.logger.error('GitHub Events: failed to fetch PR details', {
                    connectionId: connection.id,
                    repo: repoFullName,
                    status: detailsResponse.status,
                    error: errorText,
                  });

                  return;
                }

                event.payload.pull_request =
                  (await detailsResponse.json()) as GithubPullRequestEvent['payload']['pull_request'];

                return;
              } else {
                return;
              }
            }),
          );

          eventsMap[repoFullName].push(...pageEvents);

          client.logger.log('GitHub Events: fetched additional incremental page', {
            connectionId: connection.id,
            repo: repoFullName,
            eventCount: pageEvents.length,
          });

          const pageLinkHeader = pageResponse.headers.get('link');
          nextPageUrl = parseLinkHeader(pageLinkHeader, 'next');
        }

        // Save the ETag from the first response for future conditional requests.
        newCursor[repoFullName] = firstPageEtag || false;
      }

      client.logger.log('GitHub Events: fetched events for repo', {
        connectionId: connection.id,
        repo: repoFullName,
        eventCount: eventsMap[repoFullName].length,
        hasMorePages: cursorIsNextPageUrl(newCursor[repoFullName]),
      });
    }

    client.logger.log('GitHub Events sync call completed', {
      connectionId: connection.id,
      repoCount: repos.length,
      totalEvents: Object.values(eventsMap).reduce((sum, arr) => sum + arr.length, 0),
      hasMorePages: Object.values(newCursor).some((v) => typeof v === 'string' && v.startsWith('http')),
    });

    return {
      data: {
        events: eventsMap,
      },
      nextCursor: newCursor,
    };
  } catch (err) {
    client.logger.error('Failed to sync GitHub Events', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
