import type { LoggerService } from '@ci/common/logging';

import { syncRepositoryEvents } from '../services/GitHub/sync/SyncRepositoryEvents';
import { GitHubRepositoryEventsTransformService } from '../services/GitHub/transform/TransformRepositoryEvents';

describe('GitHub repository events ETL', () => {
  const connection = {
    id: 'connection-1',
    createdAt: new Date('2026-05-01T00:00:00Z'),
  };

  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    setContext: jest.fn(),
  } as unknown as LoggerService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('syncRepositoryEvents', () => {
    it('fetches accessible repositories first and then fetches events for the selected repository', async () => {
      const request = jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 1,
            name: 'repo-one',
            full_name: 'octocat/repo-one',
            html_url: 'https://github.com/octocat/repo-one',
            private: true,
            owner: { login: 'octocat' },
          },
        ])
        .mockResolvedValueOnce(
          Array.from({ length: 100 }, (_, index) => ({
            id: `event-${index}`,
            type: 'PushEvent',
            actor: { id: 1, login: 'octocat' },
            repo: {
              id: 1,
              name: 'octocat/repo-one',
              url: 'https://api.github.com/repos/octocat/repo-one',
            },
            payload: { ref: 'refs/heads/main', size: 1, commits: [] },
            public: false,
            created_at: '2026-05-26T10:00:00Z',
          })),
        );

      const result = await syncRepositoryEvents({
        connection: connection as never,
        client: { logger, request } as never,
        nextCursor: {},
        historical: true,
      });

      expect(request).toHaveBeenNthCalledWith(
        1,
        connection,
        '/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&direction=desc&per_page=100&page=1',
      );
      expect(request).toHaveBeenNthCalledWith(
        2,
        connection,
        '/repos/octocat/repo-one/events?per_page=100&page=1',
      );
      expect(result.data).toEqual({
        repoEvents: [
          {
            repository: {
              id: 1,
              name: 'repo-one',
              full_name: 'octocat/repo-one',
              html_url: 'https://github.com/octocat/repo-one',
              private: true,
              owner: { login: 'octocat' },
            },
            events: expect.any(Array),
          },
        ],
      });
      expect(result.nextCursor).toEqual({
        repoPage: 1,
        repoIndex: 0,
        eventPage: 2,
      });
    });

    it('filters incremental results using the since cursor and advances to the next repository', async () => {
      const request = jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 1,
            name: 'repo-one',
            full_name: 'octocat/repo-one',
            html_url: 'https://github.com/octocat/repo-one',
            private: true,
            owner: { login: 'octocat' },
          },
          {
            id: 2,
            name: 'repo-two',
            full_name: 'octocat/repo-two',
            html_url: 'https://github.com/octocat/repo-two',
            private: false,
            owner: { login: 'octocat' },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'event-new',
            type: 'IssuesEvent',
            actor: { id: 1, login: 'octocat' },
            repo: {
              id: 1,
              name: 'octocat/repo-one',
              url: 'https://api.github.com/repos/octocat/repo-one',
            },
            payload: { action: 'opened' },
            public: false,
            created_at: '2026-05-26T10:00:00Z',
          },
          {
            id: 'event-old',
            type: 'IssuesEvent',
            actor: { id: 1, login: 'octocat' },
            repo: {
              id: 1,
              name: 'octocat/repo-one',
              url: 'https://api.github.com/repos/octocat/repo-one',
            },
            payload: { action: 'opened' },
            public: false,
            created_at: '2026-05-20T10:00:00Z',
          },
        ]);

      const result = await syncRepositoryEvents({
        connection: connection as never,
        client: { logger, request } as never,
        nextCursor: {
          since: '2026-05-25T00:00:00Z',
          repoPage: 1,
          repoIndex: 0,
        },
        historical: false,
      });

      expect(result.data).toEqual({
        repoEvents: [
          {
            repository: expect.objectContaining({
              full_name: 'octocat/repo-one',
            }),
            events: [
              expect.objectContaining({
                id: 'event-new',
              }),
            ],
          },
        ],
      });
      expect(result.nextCursor).toEqual({
        since: '2026-05-25T00:00:00Z',
        repoPage: 1,
        repoIndex: 1,
      });
    });
  });

  describe('GitHubRepositoryEventsTransformService', () => {
    it('creates GitHub content and events for supported repository activity types', async () => {
      const contentService = {
        search: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue([]),
      };
      const eventService = {
        search: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue([]),
      };

      const service = new GitHubRepositoryEventsTransformService(
        contentService as never,
        eventService as never,
        logger,
      );

      await service.transform({
        connection: { id: 'connection-1' } as never,
        syncJob: {
          userId: 'user-1',
          data: {
            repoEvents: [
              {
                repository: {
                  id: 1,
                  name: 'repo-one',
                  full_name: 'octocat/repo-one',
                  html_url: 'https://github.com/octocat/repo-one',
                  private: true,
                  owner: { login: 'octocat' },
                },
                events: [
                  {
                    id: 'push-1',
                    type: 'PushEvent',
                    actor: { id: 1, login: 'octocat' },
                    repo: {
                      id: 1,
                      name: 'octocat/repo-one',
                      url: 'https://api.github.com/repos/octocat/repo-one',
                    },
                    payload: {
                      ref: 'refs/heads/main',
                      size: 2,
                      commits: [],
                    },
                    public: false,
                    created_at: '2026-05-26T10:00:00Z',
                  },
                  {
                    id: 'pr-1',
                    type: 'PullRequestEvent',
                    actor: { id: 1, login: 'octocat' },
                    repo: {
                      id: 1,
                      name: 'octocat/repo-one',
                      url: 'https://api.github.com/repos/octocat/repo-one',
                    },
                    payload: {
                      action: 'opened',
                      pull_request: {
                        id: 11,
                        number: 7,
                        title: 'Add feature',
                        body: 'Details',
                        html_url: 'https://github.com/octocat/repo-one/pull/7',
                        state: 'open',
                        merged: false,
                      },
                    },
                    public: false,
                    created_at: '2026-05-26T10:05:00Z',
                  },
                  {
                    id: 'issue-1',
                    type: 'IssuesEvent',
                    actor: { id: 1, login: 'octocat' },
                    repo: {
                      id: 1,
                      name: 'octocat/repo-one',
                      url: 'https://api.github.com/repos/octocat/repo-one',
                    },
                    payload: {
                      action: 'opened',
                      issue: {
                        id: 21,
                        number: 3,
                        title: 'Bug report',
                        body: 'Needs fixing',
                        html_url: 'https://github.com/octocat/repo-one/issues/3',
                        state: 'open',
                      },
                    },
                    public: false,
                    created_at: '2026-05-26T10:10:00Z',
                  },
                ],
              },
            ],
          },
        } as never,
      });

      expect(contentService.create).toHaveBeenCalledTimes(2);
      expect(contentService.create).toHaveBeenCalledWith(
        { userId: 'user-1' },
        expect.objectContaining({
          type: 'pull_request',
          external_id: 'github:pull_request:11',
        }),
      );
      expect(contentService.create).toHaveBeenCalledWith(
        { userId: 'user-1' },
        expect.objectContaining({
          type: 'issue',
          external_id: 'github:issue:21',
        }),
      );
      expect(eventService.create).toHaveBeenCalledTimes(3);
      expect(eventService.create).toHaveBeenCalledWith(
        { userId: 'user-1' },
        expect.objectContaining({
          source_id: 'push-1',
          event_type: 'github_push',
        }),
      );
      expect(eventService.create).toHaveBeenCalledWith(
        { userId: 'user-1' },
        expect.objectContaining({
          source_id: 'pr-1',
          event_type: 'github_pull_request_opened',
        }),
      );
      expect(eventService.create).toHaveBeenCalledWith(
        { userId: 'user-1' },
        expect.objectContaining({
          source_id: 'issue-1',
          event_type: 'github_issue_opened',
        }),
      );
    });
  });
});
