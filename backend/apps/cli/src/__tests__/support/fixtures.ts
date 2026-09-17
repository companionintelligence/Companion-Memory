import type {
  AskAnswerSummary,
  AskAuditSummary,
  AskGrantSummary,
  AskSummary,
  PeerLinkSummary,
} from '../../graphqlClient';

/**
 * Minimal, internally-consistent fixtures for the memory-surface response
 * shapes, in the same spirit as `doctor.test.ts`'s `finding()`: typed as the
 * real thing so a test's stub cannot drift from what {@link MemoryGraphQLClient}
 * actually promises to return.
 */

export const peerLinkFixture = (over: Partial<PeerLinkSummary> = {}): PeerLinkSummary => ({
  id: 'pl_1',
  peerHandle: 'alice@portal.example',
  displayName: 'Alice',
  memoryEndpoint: 'https://alice.example:3030',
  status: 'active',
  trustTier: 'peer',
  personEntityId: null,
  avatarUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  revokedAt: null,
  ...over,
});

export const grantFixture = (over: Partial<AskGrantSummary> = {}): AskGrantSummary => ({
  id: 'grant_1',
  granteeId: 'user_1',
  granteePeerLinkId: null,
  queryType: 'content',
  dataClass: 'photos',
  mode: 'review',
  purpose: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  revokedAt: null,
  expiresAt: null,
  revocationReason: null,
  version: 1,
  supersedesGrantId: null,
  active: true,
  lastUsedAt: null,
  useCount: 0,
  ...over,
});

export const askFixture = (over: Partial<AskSummary> = {}): AskSummary => ({
  id: 'ask_1',
  direction: 'inbound',
  status: 'delivered',
  askerId: 'user_2',
  responderId: 'user_1',
  peerHandle: null,
  broadcastId: null,
  consentBasis: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: null,
  query: {
    queryType: 'content',
    prompt: 'Do you have photos from the lake trip?',
    dataClass: 'photos',
    purpose: null,
    actor: null,
  },
  ...over,
});

export const askAnswerFixture = (over: Partial<AskAnswerSummary> = {}): AskAnswerSummary => ({
  id: 'answer_1',
  askId: 'ask_1',
  answerSource: 'self',
  consentBasis: 'grant:grant_1',
  createdAt: '2026-08-01T00:00:00.000Z',
  disclosedCount: 3,
  withheldCount: 0,
  form: 'existence',
  summary: 'Yes, there are photos.',
  items: [],
  ...over,
});

export const askAuditFixture = (over: Partial<AskAuditSummary> = {}): AskAuditSummary => ({
  id: 'audit_1',
  askId: 'ask_1',
  askerId: 'user_2',
  responderId: 'user_1',
  peerHandle: null,
  consentBasis: 'grant:grant_1',
  outcome: 'answered',
  createdAt: '2026-08-01T00:00:00.000Z',
  disclosedCount: 3,
  query: {
    queryType: 'content',
    prompt: 'Do you have photos from the lake trip?',
    dataClass: 'photos',
    purpose: null,
    actor: null,
  },
  ...over,
});
