/**
 * Mock Implementations for Testing
 */

import type { Connection } from '@ci/domains/connections';

/**
 * Creates a mock Connection entity for testing
 */
export function createMockConnection(
  providerId: string,
  overrides: Partial<Connection> = {},
): Connection {
  return {
    id: `conn-${Math.random().toString(36).substring(7)}`,
    userId: 'test-user-id',
    providerId,
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    tokenExpiry: new Date(Date.now() + 3600000), // 1 hour from now
    activeEndpoints: [],
    syncState: {},
    scopes: [],
    accountIdentifier: 'test@example.com',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Connection;
}

/**
 * Creates a mock Logger service
 */
export function createMockLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    setContext: jest.fn(),
  };
}

/**
 * Mock fetch response helper
 */
export function mockFetchResponse(data: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: new Map([['content-type', 'application/json']]),
  });
}

/**
 * Mock fetch error helper
 */
export function mockFetchError(message: string) {
  (global.fetch as jest.Mock).mockRejectedValueOnce(new Error(message));
}

/**
 * Mock OAuth token response
 */
export function mockTokenResponse(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> = {}) {
  return {
    access_token: 'new-access-token',
    refresh_token: 'new-refresh-token',
    expires_in: 3600,
    ...overrides,
  };
}

/**
 * Creates a mock RequestContext
 */
export function createMockContext(userId: string = 'test-user-id') {
  return {
    userId,
    requestId: `req-${Math.random().toString(36).substring(7)}`,
    timestamp: new Date(),
  };
}

/**
 * Creates mock sync response data
 */
export function createMockSyncResponse(api: string, data: unknown = {}) {
  return {
    success: true,
    message: `Synced ${api}`,
    data: {
      results: [{ api, data, syncState: {} }],
      errors: [],
    },
  };
}

// Google-specific mocks
export const googleMocks = {
  calendarList: {
    items: [
      { id: 'primary', summary: 'Primary Calendar', primary: true },
      { id: 'work', summary: 'Work Calendar', primary: false },
    ],
  },
  
  calendarEvents: {
    items: [
      {
        id: 'event-1',
        summary: 'Test Meeting',
        start: { dateTime: '2026-02-07T10:00:00Z' },
        end: { dateTime: '2026-02-07T11:00:00Z' },
      },
    ],
    nextPageToken: null,
  },
  
  gmailMessages: {
    messages: [
      { id: 'msg-1', threadId: 'thread-1' },
      { id: 'msg-2', threadId: 'thread-2' },
    ],
    nextPageToken: null,
  },
  
  gmailMessage: (id: string) => ({
    id,
    threadId: `thread-${id}`,
    snippet: 'Test email content',
    payload: {
      headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'recipient@example.com' },
        { name: 'Subject', value: 'Test Subject' },
      ],
    },
  }),
};

// Microsoft-specific mocks
export const microsoftMocks = {
  mailMessages: {
    value: [
      {
        id: 'mail-1',
        subject: 'Test Email',
        from: { emailAddress: { address: 'sender@example.com' } },
        receivedDateTime: '2026-02-07T10:00:00Z',
      },
    ],
    '@odata.nextLink': null,
  },
  
  calendars: {
    value: [
      { id: 'cal-1', name: 'Calendar', isDefaultCalendar: true },
    ],
  },
  
  calendarEvents: {
    value: [
      {
        id: 'event-1',
        subject: 'Test Meeting',
        start: { dateTime: '2026-02-07T10:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-02-07T11:00:00', timeZone: 'UTC' },
      },
    ],
    '@odata.nextLink': null,
  },
};

// Facebook-specific mocks
export const facebookMocks = {
  posts: {
    data: [
      {
        id: 'post-1',
        message: 'Test post content',
        created_time: '2026-02-07T10:00:00+0000',
      },
    ],
    paging: { next: null },
  },
  
  photos: {
    data: [
      {
        id: 'photo-1',
        name: 'Test Photo',
        created_time: '2026-02-07T10:00:00+0000',
      },
    ],
    paging: { next: null },
  },
};
