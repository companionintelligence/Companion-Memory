import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncSlackChannelMessages, type SlackConversation, type SlackMessage } from '../slackApi';

type Responder = (endpoint: string) => unknown;

function createMockClient(respond: Responder) {
  return {
    logger: {
      log: jest.fn(),
      error: jest.fn(),
    },
    request: jest.fn(async (_connection: Connection, endpoint: string) => respond(endpoint)),
  } as unknown as BaseClient;
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'connection-1',
    externalId: 'U0AUTHED',
    ...overrides,
  } as Connection;
}

function conversation(id: string): SlackConversation {
  return { id, name: `channel-${id}`, is_channel: true };
}

function message(ts: string): SlackMessage {
  return { type: 'message', user: 'U08ABCDEF', text: `hello ${ts}`, ts };
}

/**
 * Routes by Slack method so a test only has to describe the one call it cares
 * about; conversations.list and users.list get empty-but-valid answers.
 */
function respondWith({
  conversations,
  history,
}: {
  conversations: SlackConversation[];
  history: Responder;
}): Responder {
  return (endpoint) => {
    if (endpoint.startsWith('/conversations.list')) {
      return { ok: true, channels: conversations };
    }

    if (endpoint.startsWith('/users.list')) {
      return { ok: true, members: [] };
    }

    return history(endpoint);
  };
}

describe('syncSlackChannelMessages', () => {
  it('keeps the page cursor when an incremental page has more to read', async () => {
    const client = createMockClient(
      respondWith({
        conversations: [conversation('C1')],
        history: () => ({
          ok: true,
          messages: [message('1700000000.000100')],
          has_more: true,
          response_metadata: { next_cursor: 'PAGE2' },
        }),
      }),
    );

    const result = await syncSlackChannelMessages({
      connection: createConnection(),
      client,
      nextCursor: { since: '2026-08-01T00:00:00.000Z' },
      historical: false,
    });

    // The unread page must still be reachable, and the shared watermark must
    // not have moved past it.
    expect(result.nextCursor).toEqual({
      C1: 'PAGE2',
      since: '2026-08-01T00:00:00.000Z',
    });
  });

  it('advances the since watermark only once every channel is fully read', async () => {
    const client = createMockClient(
      respondWith({
        conversations: [conversation('C1')],
        history: () => ({
          ok: true,
          messages: [message('1700000000.000100')],
        }),
      }),
    );

    const result = await syncSlackChannelMessages({
      connection: createConnection(),
      client,
      nextCursor: { since: '2026-08-01T00:00:00.000Z' },
      historical: false,
    });

    expect(Object.keys(result.nextCursor!)).toEqual(['since']);
    expect(result.nextCursor!.since).not.toBe('2026-08-01T00:00:00.000Z');
  });

  it('does not mark a channel backfilled when its first historical page fails', async () => {
    const client = createMockClient(
      respondWith({
        conversations: [conversation('C1'), conversation('C2')],
        history: (endpoint) => {
          if (endpoint.includes('channel=C1')) {
            throw new Error('ratelimited');
          }

          return { ok: true, messages: [message('1700000000.000100')] };
        },
      }),
    );

    const result = await syncSlackChannelMessages({
      connection: createConnection(),
      client,
      nextCursor: {},
      historical: true,
    });

    // `false` is the terminal sentinel: it makes every later run skip the
    // channel outright. A transient failure on the first page must not earn it.
    expect(result.nextCursor!.C1).not.toBe(false);
    expect(result.nextCursor!.C2).toBe(false);
  });

  it('preserves an existing historical cursor when that page fails', async () => {
    const client = createMockClient(
      respondWith({
        conversations: [conversation('C1')],
        history: () => {
          throw new Error('ratelimited');
        },
      }),
    );

    const result = await syncSlackChannelMessages({
      connection: createConnection(),
      client,
      nextCursor: { C1: 'PAGE3' },
      historical: true,
    });

    expect(result.nextCursor).toEqual({ C1: 'PAGE3' });
  });
});
