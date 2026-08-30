import { GitHubEventsTransformService } from '../transform/TransformEvents';

/**
 * GitHub events carried source_system + source_id but no source_type, which
 * disables both EventService.createOne's find-or-create and
 * events_source_triple_uniq (NULLs are distinct to it); content rows carried
 * no triple, and the issue-comment pre-check searched a bare numeric
 * external_id with no type scope — able to false-match another provider's
 * numeric id. These tests pin the hardened triples and the scoped search.
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

function build() {
  const deps = makeDeps();
  const service = new GitHubEventsTransformService(
    deps.contentService as never,
    deps.eventService as never,
    makeLogger() as never,
  );

  return { service, ...deps };
}

const connection = { id: 'conn-1', externalId: '123' } as never;

function syncJobWithEvents(events: unknown[]) {
  return {
    id: 'job-1',
    userId: 'user-1',
    connectionId: 'conn-1',
    data: { events: { all: events } },
  } as never;
}

describe('GitHub provenance triples', () => {
  it('stamps the full triple on an event (PushEvent)', async () => {
    const { service, eventService } = build();

    await service.transform({
      connection,
      syncJob: syncJobWithEvents([
        {
          id: '111',
          type: 'PushEvent',
          actor: { id: 123 },
          repo: { name: 'org/repo' },
          created_at: '2026-08-20T10:00:00Z',
          payload: { ref: 'refs/heads/main' },
        },
      ]),
    });

    expect(eventService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'github_events',
        source_id: '111',
      }),
    );
  });

  it('stamps a prefixed content triple for an issue comment and scopes its pre-check by type', async () => {
    const { service, contentService } = build();

    await service.transform({
      connection,
      syncJob: syncJobWithEvents([
        {
          id: '222',
          type: 'IssueCommentEvent',
          actor: { id: 123 },
          repo: { name: 'org/repo' },
          created_at: '2026-08-20T10:00:00Z',
          payload: {
            issue: { number: 5 },
            comment: { id: 987, body: 'hi', html_url: 'https://github.com/org/repo/issues/5#c-987' },
          },
        },
      ]),
    });

    // The bare numeric comment id must not be matched against other
    // providers' numeric external ids.
    expect(contentService.search).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { type: 'github_comment', external_id: '987' },
    );
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'github',
        source_id: 'issue_comment:987',
      }),
    );
  });

  it('skips events by other actors entirely', async () => {
    const { service, eventService, contentService } = build();

    await service.transform({
      connection,
      syncJob: syncJobWithEvents([
        {
          id: '333',
          type: 'PushEvent',
          actor: { id: 999 },
          repo: { name: 'org/repo' },
          created_at: '2026-08-20T10:00:00Z',
          payload: { ref: 'refs/heads/main' },
        },
      ]),
    });

    expect(eventService.create).not.toHaveBeenCalled();
    expect(contentService.create).not.toHaveBeenCalled();
  });
});
