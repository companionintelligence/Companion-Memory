import { ApiError, describeFailureBody, UnreachableError, type ClientOptions } from './client';

/**
 * The CLI's second client, for the half of the memory surface that has no REST
 * equivalent: peer links, standing ask-grants, and the ask lifecycle itself
 * (epic #1712). {@link ImportApiClient} cannot grow these — they are GraphQL-only,
 * served at `POST /graphql` (the Apollo driver's own default; there is no
 * `/api` prefix on this process, see `domains/graphql/index.ts` and
 * `GraphQLController`'s comment about the reverse proxy stripping one for
 * *public* ingress only) — and forcing a REST shape onto a GraphQL schema would
 * mean re-inventing exactly the query language the schema already is.
 *
 * Deliberately not a codegen'd Apollo Client: this is one process sending a
 * handful of fixed documents to one server it already trusts, over the same
 * minimal `fetch` + `x-api-key` pattern {@link ImportApiClient} uses. Every
 * response shape below is RESTATED rather than imported from
 * `domains/graphql/types/*` for the same reason `IngestStatus` is restated in
 * `client.ts`: this is an HTTP client, entitled to the response body and not to
 * the server's internal types, and reaching into another domain's resolver
 * types is exactly what `no-cross-domain-internals` forbids.
 */
export class MemoryGraphQLClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  // ---------------------------------------------------------------------------
  // Self-check
  // ---------------------------------------------------------------------------

  /** Who the api key resolves to. Used by `doctor --graphql`; null answers nothing about the failure mode — the caller already has the thrown error for that. */
  me(): Promise<MeSummary | null> {
    return this.query<{ me: MeSummary | null }>('me', `query Me { me { id name email avatarUrl } }`).then(
      (data) => data.me,
    );
  }

  // ---------------------------------------------------------------------------
  // Peer links
  // ---------------------------------------------------------------------------

  myPeerLinks(): Promise<PeerLinkSummary[]> {
    return this.query<{ myPeerLinks: PeerLinkSummary[] }>(
      'myPeerLinks',
      `query MyPeerLinks { myPeerLinks { ${PEER_LINK_FIELDS} } }`,
    ).then((data) => data.myPeerLinks);
  }

  createPeerLink(input: {
    peerHandle: string;
    memoryEndpoint: string;
    displayName?: string;
    trustTier?: string;
    peerIssuer?: string;
    peerSubject?: string;
  }): Promise<PeerLinkPayload> {
    return this.mutate<{ createPeerLink: PeerLinkPayload }>(
      'createPeerLink',
      `mutation CreatePeerLink($input: CreatePeerLinkInput!) {
        createPeerLink(input: $input) { success peerLink { ${PEER_LINK_FIELDS} } }
      }`,
      { input },
    ).then((data) => data.createPeerLink);
  }

  updatePeerLink(input: {
    id: string;
    displayName?: string;
    trustTier?: string;
    peerIssuer?: string;
    peerSubject?: string;
  }): Promise<PeerLinkPayload> {
    return this.mutate<{ updatePeerLink: PeerLinkPayload }>(
      'updatePeerLink',
      `mutation UpdatePeerLink($input: UpdatePeerLinkInput!) {
        updatePeerLink(input: $input) { success peerLink { ${PEER_LINK_FIELDS} } }
      }`,
      { input },
    ).then((data) => data.updatePeerLink);
  }

  revokePeerLink(id: string): Promise<PeerLinkPayload> {
    return this.mutate<{ revokePeerLink: PeerLinkPayload }>(
      'revokePeerLink',
      `mutation RevokePeerLink($id: ID!) {
        revokePeerLink(id: $id) { success peerLink { ${PEER_LINK_FIELDS} } }
      }`,
      { id },
    ).then((data) => data.revokePeerLink);
  }

  // ---------------------------------------------------------------------------
  // Ask grants
  // ---------------------------------------------------------------------------

  myAskGrants(): Promise<AskGrantSummary[]> {
    return this.query<{ myAskGrants: AskGrantSummary[] }>(
      'myAskGrants',
      `query MyAskGrants { myAskGrants { ${ASK_GRANT_FIELDS} } }`,
    ).then((data) => data.myAskGrants);
  }

  myAskGrantHistory(): Promise<AskGrantSummary[]> {
    return this.query<{ myAskGrantHistory: AskGrantSummary[] }>(
      'myAskGrantHistory',
      `query MyAskGrantHistory { myAskGrantHistory { ${ASK_GRANT_FIELDS} } }`,
    ).then((data) => data.myAskGrantHistory);
  }

  askGrant(id: string): Promise<AskGrantSummary | null> {
    return this.query<{ askGrant: AskGrantSummary | null }>(
      'askGrant',
      `query AskGrant($id: ID!) { askGrant(id: $id) { ${ASK_GRANT_FIELDS} } }`,
      { id },
    ).then((data) => data.askGrant);
  }

  createAskGrant(input: {
    granteeId?: string;
    granteePeerLinkId?: string;
    queryType: string;
    dataClass?: string;
    dataClasses?: string[];
    maxDisclosure?: string;
    mode: string;
    purpose?: string;
  }): Promise<AskGrantPayload> {
    return this.mutate<{ createAskGrant: AskGrantPayload }>(
      'createAskGrant',
      `mutation CreateAskGrant($input: CreateAskGrantInput!) {
        createAskGrant(input: $input) { success grant { ${ASK_GRANT_FIELDS} } }
      }`,
      { input },
    ).then((data) => data.createAskGrant);
  }

  updateAskGrant(
    id: string,
    input: {
      mode?: string;
      dataClass?: string;
      dataClasses?: string[];
      maxDisclosure?: string;
      purpose?: string;
      expiresAt?: string;
      clearExpiry?: boolean;
    },
  ): Promise<AskGrantPayload> {
    return this.mutate<{ updateAskGrant: AskGrantPayload }>(
      'updateAskGrant',
      `mutation UpdateAskGrant($id: ID!, $input: UpdateAskGrantInput!) {
        updateAskGrant(id: $id, input: $input) { success grant { ${ASK_GRANT_FIELDS} } }
      }`,
      { id, input },
    ).then((data) => data.updateAskGrant);
  }

  revokeAskGrant(id: string): Promise<AskGrantPayload> {
    return this.mutate<{ revokeAskGrant: AskGrantPayload }>(
      'revokeAskGrant',
      `mutation RevokeAskGrant($id: ID!) {
        revokeAskGrant(id: $id) { success grant { ${ASK_GRANT_FIELDS} } }
      }`,
      { id },
    ).then((data) => data.revokeAskGrant);
  }

  // ---------------------------------------------------------------------------
  // Asks
  // ---------------------------------------------------------------------------

  askInbox(): Promise<AskSummary[]> {
    return this.query<{ askInbox: AskSummary[] }>(
      'askInbox',
      `query AskInbox { askInbox { ${ASK_FIELDS} } }`,
    ).then((data) => data.askInbox);
  }

  askOutbox(): Promise<AskSummary[]> {
    return this.query<{ askOutbox: AskSummary[] }>(
      'askOutbox',
      `query AskOutbox { askOutbox { ${ASK_FIELDS} } }`,
    ).then((data) => data.askOutbox);
  }

  ask(id: string): Promise<AskSummary | null> {
    return this.query<{ ask: AskSummary | null }>(
      'ask',
      `query Ask($id: ID!) { ask(id: $id) { ${ASK_FIELDS} } }`,
      { id },
    ).then((data) => data.ask);
  }

  createAsk(input: {
    responderId: string;
    query: { queryType: string; prompt: string; dataClass?: string };
  }): Promise<CreateAskPayload> {
    return this.mutate<{ createAsk: CreateAskPayload }>(
      'createAsk',
      `mutation CreateAsk($input: CreateAskInput!) {
        createAsk(input: $input) { success decision ask { ${ASK_FIELDS} } }
      }`,
      { input },
    ).then((data) => data.createAsk);
  }

  approveAsk(id: string): Promise<AskPayload> {
    return this.mutate<{ approveAsk: AskPayload }>(
      'approveAsk',
      `mutation ApproveAsk($id: ID!) { approveAsk(id: $id) { success ask { ${ASK_FIELDS} } } }`,
      { id },
    ).then((data) => data.approveAsk);
  }

  declineAsk(id: string): Promise<AskPayload> {
    return this.mutate<{ declineAsk: AskPayload }>(
      'declineAsk',
      `mutation DeclineAsk($id: ID!) { declineAsk(id: $id) { success ask { ${ASK_FIELDS} } } }`,
      { id },
    ).then((data) => data.declineAsk);
  }

  runAsk(
    id: string,
    options: { redactItemIds?: string[]; disclosureForm?: string } = {},
  ): Promise<RunAskPayload> {
    return this.mutate<{ runAsk: RunAskPayload }>(
      'runAsk',
      `mutation RunAsk($id: ID!, $redactItemIds: [String!], $disclosureForm: AnswerForm) {
        runAsk(id: $id, redactItemIds: $redactItemIds, disclosureForm: $disclosureForm) {
          success
          ask { ${ASK_FIELDS} }
          answer { ${ASK_ANSWER_FIELDS} }
          disclosedCount
          withheldCount
        }
      }`,
      { id, redactItemIds: options.redactItemIds, disclosureForm: options.disclosureForm },
    ).then((data) => data.runAsk);
  }

  askAnswer(id: string): Promise<AskAnswerSummary | null> {
    return this.query<{ askAnswer: AskAnswerSummary | null }>(
      'askAnswer',
      `query AskAnswer($id: ID!) { askAnswer(id: $id) { ${ASK_ANSWER_FIELDS} } }`,
      { id },
    ).then((data) => data.askAnswer);
  }

  askDisclosureHistory(input?: {
    counterpartyKey?: string;
    from?: string;
    to?: string;
    limit?: number;
    outcomes?: string[];
  }): Promise<AskDisclosureHistoryPayload> {
    return this.query<{ askDisclosureHistory: AskDisclosureHistoryPayload }>(
      'askDisclosureHistory',
      `query AskDisclosureHistory($input: AskDisclosureHistoryInput) {
        askDisclosureHistory(input: $input) { truncated rows { ${ASK_AUDIT_FIELDS} } }
      }`,
      { input },
    ).then((data) => data.askDisclosureHistory);
  }

  /** The federated half: an ask sent to a linked peer's own appliance. */
  sendPeerAsk(input: {
    handle: string;
    prompt: string;
    archetype: string;
    subject?: string;
    dataClass?: string;
    from?: string;
    to?: string;
    minMinutes?: number;
    purpose?: string;
    peerAccessToken: string;
  }): Promise<SendPeerAskPayload> {
    return this.mutate<{ sendPeerAsk: SendPeerAskPayload }>(
      'sendPeerAsk',
      `mutation SendPeerAsk($input: SendPeerAskInput!) {
        sendPeerAsk(input: $input) {
          success
          status
          reason
          ask { ${ASK_FIELDS} }
          answer { ${ASK_ANSWER_FIELDS} }
        }
      }`,
      { input },
    ).then((data) => data.sendPeerAsk);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private query<T>(operation: string, query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.request<T>(operation, query, variables);
  }

  private mutate<T>(operation: string, query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.request<T>(operation, query, variables);
  }

  /**
   * One POST, one document. No batching, no persisted queries, no cache — the
   * things a real GraphQL client earns its complexity with all assume a page
   * making many overlapping requests over a session; this is a script making
   * one call and exiting.
   *
   * Both failure shapes this appliance can produce are handled: a transport
   * failure (proxy down, body-parser rejection, a bare 5xx with no GraphQL body
   * at all) reuses {@link describeFailureBody}, the exact wording
   * {@link ImportApiClient} gives a REST caller for the same failure. A GraphQL
   * error — the far more common case, since a rejected mutation (a block grant,
   * a malformed queryType, "only the responder may run this ask") is a normal
   * 200-with-`errors[]` response — is surfaced as {@link GraphQLApiError}
   * carrying the resolver's OWN message verbatim; see `formatError.ts` for why
   * that message is safe to show (deliberate `HttpException`s pass through
   * unmasked, everything else becomes `Internal server error`).
   */
  private async request<T>(
    operation: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL('/graphql', this.options.baseUrl);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };

    if (this.options.apiKey) {
      headers['x-api-key'] = this.options.apiKey;
    }

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new UnreachableError(this.options.baseUrl, err);
    }

    const text = await response.text();
    let body: GraphQLResponseBody<T> | null = null;

    try {
      body = text.length > 0 ? (JSON.parse(text) as GraphQLResponseBody<T>) : null;
    } catch {
      body = null;
    }

    if (body?.errors != null && body.errors.length > 0) {
      const [first, ...rest] = body.errors;
      const code =
        typeof first.extensions?.code === 'string' ? first.extensions.code : 'INTERNAL_SERVER_ERROR';
      const suffix = rest.length > 0 ? ` (+${rest.length} more error${rest.length === 1 ? '' : 's'})` : '';

      throw new GraphQLApiError(code, `${first.message}${suffix}`, operation);
    }

    if (!response.ok) {
      throw new ApiError(
        response.status,
        describeFailureBody(response.status, text, Boolean(this.options.apiKey), response.statusText),
        `graphql:${operation}`,
      );
    }

    if (body == null || !('data' in body) || body.data === undefined) {
      throw new ApiError(502, 'the appliance answered with no data and no error', `graphql:${operation}`);
    }

    return body.data;
  }
}

interface GraphQLResponseBody<T> {
  data?: T;
  errors?: Array<{ message: string; path?: Array<string | number>; extensions?: { code?: string } }>;
}

/**
 * A GraphQL-level refusal — the resolver ran and said no. Extends
 * {@link ApiError} rather than standing apart so `main.ts`'s existing
 * `err instanceof ApiError` branch (exit 1 for `status >= 500`, exit 2
 * otherwise) needs no new case: `extensions.code` maps onto the same HTTP
 * statuses Apollo's own error formatting would set on the response, so a
 * malformed queryType is exit 2 exactly like a REST 400, and a masked
 * `INTERNAL_SERVER_ERROR` is exit 1 exactly like a REST 500.
 *
 * Both `BAD_USER_INPUT` (`formatError.ts`'s own `CODES_BY_STATUS` mapping, on
 * this checkout) and `BAD_REQUEST` (what a live appliance running an image
 * built before that mapping landed actually answered with, verified against a
 * running `ci-server-desktop` stack during this change) are treated as the
 * same 400 — an operator's fleet is never running one exact commit everywhere,
 * and a CLI that only recognized today's spelling would regress the moment a
 * box lagged a deploy behind. `GRAPHQL_VALIDATION_FAILED` and
 * `GRAPHQL_PARSE_FAILED` are Apollo's own codes for a request that never
 * reached a resolver at all — an unknown enum value on `--mode` / `--tier` /
 * `--max-disclosure` / `--disclosure-form` takes this path, not a resolver
 * throw, so it needs the same 400 treatment.
 */
export class GraphQLApiError extends ApiError {
  constructor(
    readonly code: string,
    message: string,
    operation: string,
  ) {
    super(STATUS_BY_CODE[code] ?? 500, message, `graphql:${operation}`);
    this.name = 'GraphQLApiError';
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  BAD_USER_INPUT: 400,
  BAD_REQUEST: 400,
  GRAPHQL_VALIDATION_FAILED: 400,
  GRAPHQL_PARSE_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

// ---------------------------------------------------------------------------
// Response shapes — restated from the schema, not imported. See the class
// docstring for why.
// ---------------------------------------------------------------------------

export interface MeSummary {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

const PEER_LINK_FIELDS = `
  id peerHandle displayName memoryEndpoint status trustTier personEntityId
  avatarUrl createdAt updatedAt revokedAt
`;

export interface PeerLinkSummary {
  id: string;
  peerHandle: string;
  displayName: string | null;
  memoryEndpoint: string;
  status: 'active' | 'pending' | 'revoked';
  trustTier: 'family' | 'peer' | 'stranger' | 'trusted';
  personEntityId: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface PeerLinkPayload {
  success: boolean;
  peerLink: PeerLinkSummary | null;
}

const ASK_GRANT_FIELDS = `
  id granteeId granteePeerLinkId queryType dataClass mode purpose
  createdAt updatedAt revokedAt expiresAt revocationReason version
  supersedesGrantId active lastUsedAt useCount
`;

export interface AskGrantSummary {
  id: string;
  granteeId: string | null;
  granteePeerLinkId: string | null;
  queryType: string;
  dataClass: string | null;
  mode: 'auto' | 'review' | 'block';
  purpose: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  revocationReason: string | null;
  version: number;
  supersedesGrantId: string | null;
  active: boolean;
  lastUsedAt: string | null;
  useCount: number;
}

export interface AskGrantPayload {
  success: boolean;
  grant: AskGrantSummary | null;
}

export interface AskActorSummary {
  kind: string;
  label: string | null;
}

export interface AskQuerySummary {
  queryType: string;
  prompt: string;
  dataClass: string | null;
  purpose: string | null;
  actor: AskActorSummary | null;
}

const ASK_FIELDS = `
  id direction status askerId responderId peerHandle broadcastId consentBasis
  createdAt updatedAt expiresAt
  query { queryType prompt dataClass purpose actor { kind label } }
`;

export interface AskSummary {
  id: string;
  direction: string;
  status: 'sent' | 'delivered' | 'under_review' | 'answering' | 'answered' | 'declined' | 'expired';
  askerId: string | null;
  responderId: string | null;
  peerHandle: string | null;
  broadcastId: string | null;
  consentBasis: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  query: AskQuerySummary;
}

export interface CreateAskPayload {
  success: boolean;
  decision: string | null;
  ask: AskSummary | null;
}

export interface AskPayload {
  success: boolean;
  ask: AskSummary | null;
}

const ASK_ANSWER_FIELDS = `
  id askId answerSource consentBasis createdAt disclosedCount withheldCount
  form summary items { id type }
`;

export interface DisclosedItemSummary {
  id: string;
  type: string;
}

export interface AskAnswerSummary {
  id: string;
  askId: string;
  answerSource: 'peer' | 'self';
  consentBasis: string | null;
  createdAt: string;
  disclosedCount: number;
  withheldCount: number;
  form: 'attribute' | 'boolean' | 'existence' | 'identity' | 'retrieval';
  summary: string | null;
  items: DisclosedItemSummary[];
}

export interface RunAskPayload {
  success: boolean;
  ask: AskSummary | null;
  answer: AskAnswerSummary | null;
  disclosedCount: number | null;
  withheldCount: number | null;
}

export interface SendPeerAskPayload {
  success: boolean;
  status: string | null;
  reason: string | null;
  ask: AskSummary | null;
  answer: AskAnswerSummary | null;
}

const ASK_AUDIT_FIELDS = `
  id askId askerId responderId peerHandle consentBasis outcome createdAt
  disclosedCount
  query { queryType prompt dataClass purpose actor { kind label } }
`;

export interface AskAuditSummary {
  id: string;
  askId: string | null;
  askerId: string | null;
  responderId: string | null;
  peerHandle: string | null;
  consentBasis: string | null;
  outcome: 'answered' | 'auto_answered' | 'declined' | 'expired';
  createdAt: string;
  disclosedCount: number;
  query: AskQuerySummary;
}

export interface AskDisclosureHistoryPayload {
  rows: AskAuditSummary[];
  truncated: boolean;
}
