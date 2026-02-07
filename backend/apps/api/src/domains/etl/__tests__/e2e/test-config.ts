/**
 * E2E Test Configuration
 * 
 * Central configuration for all ETL E2E tests
 */

export const TEST_CONFIG = {
  /** Test database configuration */
  database: {
    type: 'postgres' as const,
    database: 'ci_test',
    synchronize: false,
    dropSchema: false,
  },

  /** Mock API configuration */
  mockApi: {
    enabled: true,
    baseUrl: 'http://localhost:3000/mock-api',
  },

  /** Test timeouts */
  timeouts: {
    sync: 30000,
    api: 10000,
    transform: 5000,
  },

  /** Test data limits */
  limits: {
    maxRecords: 100,
    pageSize: 50,
  },

  /** Provider IDs for testing */
  providers: {
    google: 'google',
    microsoft: 'microsoft',
    facebook: 'facebook',
    discord: 'discord',
    slack: 'slack',
    telegram: 'telegram',
    signal: 'signal',
    twitter: 'twitter',
    linkedin: 'linkedin',
    instagram: 'instagram',
    reddit: 'reddit',
    github: 'github',
    dropbox: 'dropbox',
    box: 'box',
    nextcloud: 'nextcloud',
    notion: 'notion',
    trello: 'trello',
    asana: 'asana',
    zoom: 'zoom',
    spotify: 'spotify',
    twitch: 'twitch',
    steam: 'steam',
    shopify: 'shopify',
    stripe: 'stripe',
    openai: 'openai',
    anthropic: 'anthropic',
  },

  /** Expected data types for validation */
  dataTypes: {
    communication: ['email', 'message', 'chat', 'dm'],
    content: ['file', 'document', 'photo', 'video', 'audio', 'post'],
    event: ['meeting', 'reminder', 'task', 'calendar_event'],
    relationship: ['contact', 'friend', 'follower', 'connection'],
    transaction: ['purchase', 'payment', 'subscription', 'order'],
    media: ['song', 'playlist', 'video', 'stream', 'game'],
  },
};

export const REQUIRED_FIELDS = {
  communication: ['externalId', 'type', 'platform', 'timestamp', 'content'],
  content: ['externalId', 'type', 'platform', 'timestamp', 'title'],
  event: ['externalId', 'type', 'platform', 'timestamp', 'title'],
  relationship: ['externalId', 'type', 'platform', 'name'],
  transaction: ['externalId', 'type', 'platform', 'timestamp', 'amount'],
  media: ['externalId', 'type', 'platform', 'timestamp', 'title'],
};
