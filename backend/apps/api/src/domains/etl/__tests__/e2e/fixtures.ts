/**
 * E2E Test Data Fixtures
 * 
 * Pre-defined test data for all providers
 */

import type { Connection } from '@ci/domains/connections';

/**
 * Google provider test fixtures
 */
export const GOOGLE_FIXTURES = {
  connection: (overrides?: Partial<Connection>) => ({
    id: 'test-google-conn',
    userId: 'test-user',
    providerId: 'google',
    providerName: 'Google',
    accessToken: 'mock-google-token',
    activeEndpoints: ['Gmail', 'Calendar', 'Drive', 'YouTube', 'Contacts'],
    syncState: {},
    ...overrides,
  }),
  
  sources: ['Gmail', 'Calendar', 'Drive', 'YouTube', 'Contacts'],
  
  expectedDataTypes: {
    Gmail: 'communication',
    Calendar: 'event',
    Drive: 'content',
    YouTube: 'media',
    Contacts: 'relationship',
  },
};

/**
 * Microsoft provider test fixtures
 */
export const MICROSOFT_FIXTURES = {
  connection: (overrides?: Partial<Connection>) => ({
    id: 'test-microsoft-conn',
    userId: 'test-user',
    providerId: 'microsoft',
    providerName: 'Microsoft',
    accessToken: 'mock-microsoft-token',
    activeEndpoints: ['Outlook', 'Calendar', 'OneDrive'],
    syncState: {},
    ...overrides,
  }),
  
  sources: ['Outlook', 'Calendar', 'OneDrive'],
  
  expectedDataTypes: {
    Outlook: 'communication',
    Calendar: 'event',
    OneDrive: 'content',
  },
};

/**
 * Facebook provider test fixtures
 */
export const FACEBOOK_FIXTURES = {
  connection: (overrides?: Partial<Connection>) => ({
    id: 'test-facebook-conn',
    userId: 'test-user',
    providerId: 'facebook',
    providerName: 'Facebook',
    accessToken: 'mock-facebook-token',
    activeEndpoints: ['Posts', 'Photos', 'Videos', 'Friends'],
    syncState: {},
    ...overrides,
  }),
  
  sources: ['Posts', 'Photos', 'Videos', 'Friends'],
  
  expectedDataTypes: {
    Posts: 'content',
    Photos: 'content',
    Videos: 'content',
    Friends: 'relationship',
  },
};

/**
 * Communication platforms fixtures
 */
export const COMMUNICATION_FIXTURES = {
  discord: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-discord-conn',
      userId: 'test-user',
      providerId: 'discord',
      providerName: 'Discord',
      accessToken: 'mock-discord-token',
      activeEndpoints: ['Messages', 'Guilds'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Messages', 'Guilds'],
  },
  
  slack: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-slack-conn',
      userId: 'test-user',
      providerId: 'slack',
      providerName: 'Slack',
      accessToken: 'mock-slack-token',
      activeEndpoints: ['Messages', 'Files'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Messages', 'Files'],
  },
  
  telegram: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-telegram-conn',
      userId: 'test-user',
      providerId: 'telegram',
      providerName: 'Telegram',
      accessToken: 'mock-telegram-token',
      activeEndpoints: ['Messages'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Messages'],
  },
  
  signal: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-signal-conn',
      userId: 'test-user',
      providerId: 'signal',
      providerName: 'Signal',
      accessToken: 'mock-signal-token',
      activeEndpoints: ['Messages'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Messages'],
  },
};

/**
 * Social media fixtures
 */
export const SOCIAL_FIXTURES = {
  twitter: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-twitter-conn',
      userId: 'test-user',
      providerId: 'twitter',
      providerName: 'Twitter',
      accessToken: 'mock-twitter-token',
      activeEndpoints: ['Tweets', 'Likes'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Tweets', 'Likes'],
  },
  
  linkedin: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-linkedin-conn',
      userId: 'test-user',
      providerId: 'linkedin',
      providerName: 'LinkedIn',
      accessToken: 'mock-linkedin-token',
      activeEndpoints: ['Posts', 'Connections'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Posts', 'Connections'],
  },
  
  instagram: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-instagram-conn',
      userId: 'test-user',
      providerId: 'instagram',
      providerName: 'Instagram',
      accessToken: 'mock-instagram-token',
      activeEndpoints: ['Media'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Media'],
  },
  
  reddit: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-reddit-conn',
      userId: 'test-user',
      providerId: 'reddit',
      providerName: 'Reddit',
      accessToken: 'mock-reddit-token',
      activeEndpoints: ['Posts', 'Comments', 'Saved'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Posts', 'Comments', 'Saved'],
  },
};

/**
 * Storage platform fixtures
 */
export const STORAGE_FIXTURES = {
  dropbox: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-dropbox-conn',
      userId: 'test-user',
      providerId: 'dropbox',
      providerName: 'Dropbox',
      accessToken: 'mock-dropbox-token',
      activeEndpoints: ['Files'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Files'],
  },
  
  box: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-box-conn',
      userId: 'test-user',
      providerId: 'box',
      providerName: 'Box',
      accessToken: 'mock-box-token',
      activeEndpoints: ['Files'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Files'],
  },
  
  nextcloud: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-nextcloud-conn',
      userId: 'test-user',
      providerId: 'nextcloud',
      providerName: 'Nextcloud',
      accessToken: 'mock-nextcloud-token',
      activeEndpoints: ['Files', 'Contacts', 'Calendar'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Files', 'Contacts', 'Calendar'],
  },
};

/**
 * Productivity platform fixtures
 */
export const PRODUCTIVITY_FIXTURES = {
  notion: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-notion-conn',
      userId: 'test-user',
      providerId: 'notion',
      providerName: 'Notion',
      accessToken: 'mock-notion-token',
      activeEndpoints: ['Pages', 'Databases'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Pages', 'Databases'],
  },
  
  trello: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-trello-conn',
      userId: 'test-user',
      providerId: 'trello',
      providerName: 'Trello',
      accessToken: 'mock-trello-token',
      activeEndpoints: ['Boards', 'Cards'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Boards', 'Cards'],
  },
  
  asana: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-asana-conn',
      userId: 'test-user',
      providerId: 'asana',
      providerName: 'Asana',
      accessToken: 'mock-asana-token',
      activeEndpoints: ['Tasks', 'Projects'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Tasks', 'Projects'],
  },
  
  zoom: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-zoom-conn',
      userId: 'test-user',
      providerId: 'zoom',
      providerName: 'Zoom',
      accessToken: 'mock-zoom-token',
      activeEndpoints: ['Meetings', 'Recordings'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Meetings', 'Recordings'],
  },
};

/**
 * Entertainment platform fixtures
 */
export const ENTERTAINMENT_FIXTURES = {
  spotify: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-spotify-conn',
      userId: 'test-user',
      providerId: 'spotify',
      providerName: 'Spotify',
      accessToken: 'mock-spotify-token',
      activeEndpoints: ['Playlists', 'Tracks', 'History'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Playlists', 'Tracks', 'History'],
  },
  
  twitch: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-twitch-conn',
      userId: 'test-user',
      providerId: 'twitch',
      providerName: 'Twitch',
      accessToken: 'mock-twitch-token',
      activeEndpoints: ['Videos', 'Follows', 'Clips'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Videos', 'Follows', 'Clips'],
  },
  
  steam: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-steam-conn',
      userId: 'test-user',
      providerId: 'steam',
      providerName: 'Steam',
      accessToken: 'mock-steam-token',
      activeEndpoints: ['Games', 'Achievements', 'Recent'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Games', 'Achievements', 'Recent'],
  },
};

/**
 * Business platform fixtures
 */
export const BUSINESS_FIXTURES = {
  shopify: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-shopify-conn',
      userId: 'test-user',
      providerId: 'shopify',
      providerName: 'Shopify',
      accessToken: 'mock-shopify-token',
      activeEndpoints: ['Orders', 'Products', 'Customers'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Orders', 'Products', 'Customers'],
  },
  
  stripe: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-stripe-conn',
      userId: 'test-user',
      providerId: 'stripe',
      providerName: 'Stripe',
      accessToken: 'mock-stripe-token',
      activeEndpoints: ['Payments', 'Customers', 'Subscriptions'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Payments', 'Customers', 'Subscriptions'],
  },
};

/**
 * AI platform fixtures
 */
export const AI_FIXTURES = {
  openai: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-openai-conn',
      userId: 'test-user',
      providerId: 'openai',
      providerName: 'OpenAI',
      accessToken: 'mock-openai-token',
      activeEndpoints: ['Conversations', 'Models'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Conversations', 'Models'],
  },
  
  anthropic: {
    connection: (overrides?: Partial<Connection>) => ({
      id: 'test-anthropic-conn',
      userId: 'test-user',
      providerId: 'anthropic',
      providerName: 'Anthropic',
      accessToken: 'mock-anthropic-token',
      activeEndpoints: ['Messages'],
      syncState: {},
      ...overrides,
    }),
    sources: ['Messages'],
  },
};

/**
 * Rate limiting test data
 */
export const RATE_LIMIT_FIXTURES = {
  low: { requestsPerSecond: 1, burstSize: 5 },
  medium: { requestsPerSecond: 10, burstSize: 20 },
  high: { requestsPerSecond: 100, burstSize: 200 },
};
