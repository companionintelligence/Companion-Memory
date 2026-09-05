import { ApiError, UnreachableError } from '../client';
import { GraphQLApiError, MemoryGraphQLClient } from '../graphqlClient';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };

    calls.push(call);

    return responder(call);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const gql = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });

const gqlErrors = (errors: Array<{ message: string; extensions?: { code?: string } }>, status = 200) =>
  new Response(JSON.stringify({ errors }), { status, headers: { 'content-type': 'application/json' } });

describe('MemoryGraphQLClient', () => {
  it('posts one document to /graphql with the api key as x-api-key', async () => {
    const { fetchImpl, calls } = stubFetch(() => gql({ myPeerLinks: [] }));
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'secret', fetchImpl });

    await client.myPeerLinks();

    expect(calls[0].url).toBe('http://box:3030/graphql');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['x-api-key']).toBe('secret');
    expect(JSON.parse(calls[0].body as string).query).toContain('myPeerLinks');
  });

  it('omits an absent api key entirely rather than sending an empty one', async () => {
    const { fetchImpl, calls } = stubFetch(() => gql({ myPeerLinks: [] }));
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: null, fetchImpl });

    await client.myPeerLinks();

    expect(calls[0].headers['x-api-key']).toBeUndefined();
  });

  it('unwraps the named field from the response envelope', async () => {
    const { fetchImpl } = stubFetch(() =>
      gql({
        myPeerLinks: [
          {
            id: 'pl_1',
            peerHandle: 'alice@portal.example',
            displayName: null,
            memoryEndpoint: 'https://alice.example',
            status: 'active',
            trustTier: 'peer',
            personEntityId: null,
            avatarUrl: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            revokedAt: null,
          },
        ],
      }),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    const links = await client.myPeerLinks();

    expect(links).toHaveLength(1);
    expect(links[0].peerHandle).toBe('alice@portal.example');
  });

  it('surfaces a GraphQL error with the resolver’s own message, mapped to an HTTP-like status', async () => {
    const { fetchImpl } = stubFetch(() =>
      gqlErrors([
        {
          message: 'A grant must name exactly one of granteeId / granteePeerLinkId',
          extensions: { code: 'BAD_USER_INPUT' },
        },
      ]),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    await expect(
      client.createAskGrant({
        granteeId: 'u1',
        granteePeerLinkId: 'pl1',
        queryType: 'content',
        mode: 'review',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('exactly one of granteeId'),
    });
  });

  it('is an ApiError, so main.ts’s existing exit-code mapping needs no new case', async () => {
    const { fetchImpl } = stubFetch(() =>
      gqlErrors([{ message: 'nope', extensions: { code: 'FORBIDDEN' } }]),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    await expect(client.myPeerLinks()).rejects.toBeInstanceOf(ApiError);
    await expect(client.myPeerLinks()).rejects.toBeInstanceOf(GraphQLApiError);
  });

  it('treats BAD_REQUEST the same as BAD_USER_INPUT — a live appliance running an older image answers with the former', async () => {
    const { fetchImpl } = stubFetch(() =>
      gqlErrors([
        {
          message: 'queryType must be one of: relationship, content, availability, attribute, identity',
          extensions: { code: 'BAD_REQUEST' },
        },
      ]),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    await expect(
      client.createAsk({ responderId: 'u1', query: { queryType: 'pictures', prompt: 'hi' } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('treats an unauthenticated key as a 401, like the REST client does', async () => {
    const { fetchImpl } = stubFetch(() =>
      gqlErrors([{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }]),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'bad', fetchImpl });

    await expect(client.myPeerLinks()).rejects.toMatchObject({ status: 401 });
  });

  it('masks nothing further — a masked internal error still carries its correlation id', async () => {
    const { fetchImpl } = stubFetch(() =>
      gqlErrors([{ message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }]),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    await expect(client.myPeerLinks()).rejects.toMatchObject({
      status: 500,
      message: 'Internal server error',
    });
  });

  it('falls back to the transport-failure wording when the appliance answers with no GraphQL body at all', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    await expect(client.myPeerLinks()).rejects.toMatchObject({ status: 502 });
  });

  it('names an unreachable appliance rather than leaking a socket error', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: null, fetchImpl });

    await expect(client.myPeerLinks()).rejects.toBeInstanceOf(UnreachableError);
  });

  it('sends redactItemIds and disclosureForm through runAsk unchanged', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      gql({ runAsk: { success: true, ask: null, answer: null, disclosedCount: 1, withheldCount: 2 } }),
    );
    const client = new MemoryGraphQLClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    await client.runAsk('ask_1', { redactItemIds: ['e1', 'e2'], disclosureForm: 'boolean' });

    const body = JSON.parse(calls[0].body as string);

    expect(body.variables).toEqual({ id: 'ask_1', redactItemIds: ['e1', 'e2'], disclosureForm: 'boolean' });
  });
});
