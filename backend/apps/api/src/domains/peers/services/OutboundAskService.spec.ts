/**
 * `undici` is mocked for the SSRF suite at the bottom, which drives a REAL
 * `PeerAskClient` through this service. Every other test here uses a stubbed
 * client and never reaches the transport, so the mock is inert for them.
 */
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');

  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import { fetch as undiciFetch } from 'undici';

import { type PeerLink } from '../entities/PeerLinkEntity';
import type { AskerVisiblePeerReply } from '../protocol';

import { OutboundAskService, toStoredAnswer } from './OutboundAskService';
import { PeerAskClient } from './PeerAskClient';

const mockFetch = undiciFetch as unknown as jest.Mock;

const CTX = { userId: 'user-1' };

function link(overrides: Partial<PeerLink> = {}): PeerLink {
  return {
    id: 'link-1',
    ownerUserId: 'user-1',
    peerHandle: 'devon',
    memoryEndpoint: 'https://devon.example.com/agent/v1',
    trustTier: 'trusted',
    status: 'active',
    ...overrides,
  } as PeerLink;
}

const ANSWERED: AskerVisiblePeerReply = {
  askId: 'x',
  status: 'answered',
  answer: { form: 'existence', summary: '1 matching item.', disclosedCount: 1, withheldCount: 0 },
};

function makeService(
  overrides: {
    link?: PeerLink | null;
    response?: AskerVisiblePeerReply;
    poll?: AskerVisiblePeerReply;
    askStatus?: string;
    correlation?: unknown;
    storedAnswer?: unknown;
    /** Swap in a REAL PeerAskClient; the returned `client` stub stays unused. */
    peerClient?: PeerAskClient;
  } = {},
) {
  const peerLinkService = {
    findByHandle: jest.fn().mockResolvedValue(overrides.link === undefined ? link() : overrides.link),
    findById: jest.fn().mockResolvedValue(overrides.link === undefined ? link() : overrides.link),
  };
  const askRow = {
    id: 'ask-1',
    askerUserId: 'user-1',
    responderUserId: null,
    peerLinkId: 'link-1',
    direction: 'outbound',
    query: { queryType: 'content', prompt: 'photos?' },
    status: overrides.askStatus ?? 'delivered',
    consentBasis: null,
  };
  const askService = {
    create: jest.fn().mockResolvedValue(askRow),
    findById: jest.fn().mockResolvedValue(askRow),
  };
  const answerService = {
    create: jest.fn().mockResolvedValue({}),
    findByAskId: jest.fn().mockResolvedValue(overrides.storedAnswer ?? null),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  const correlationService = {
    record: jest.fn().mockResolvedValue({}),
    findByAskId: jest
      .fn()
      .mockResolvedValue(
        overrides.correlation === undefined
          ? { correlationId: 'corr-1', askId: 'ask-1' }
          : overrides.correlation,
      ),
  };
  const client = {
    send: jest.fn().mockResolvedValue(overrides.response ?? ANSWERED),
    poll: jest.fn().mockResolvedValue(overrides.poll ?? ANSWERED),
  };

  // `terminalize` reads the row back INSIDE the transaction rather than
  // trusting the handle it was given, so the mock has to be a real row that a
  // save can mutate — otherwise nothing here could show whether the terminal
  // status was ever written.
  const persisted = { ...askRow };
  const askRepository = {
    findOne: jest
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          where.id === persisted.id && where.askerUserId === persisted.askerUserId ? persisted : null,
        ),
      ),
    save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
  };
  const manager = { getRepository: jest.fn().mockReturnValue(askRepository) };
  const repositoryWithManager = {
    manager: {
      transaction: jest.fn().mockImplementation((work: (m: unknown) => Promise<unknown>) => work(manager)),
    },
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };

  const service = new OutboundAskService(
    peerLinkService as never,
    askService as never,
    answerService as never,
    auditService as never,
    correlationService as never,
    (overrides.peerClient ?? client) as never,
    repositoryWithManager as never,
    logger as never,
  );

  return {
    service,
    peerLinkService,
    askService,
    answerService,
    auditService,
    correlationService,
    client,
    persisted,
  };
}

const DTO = {
  handle: 'devon',
  prompt: 'Do you have photos of us?',
  request: { archetype: 'content' as const, subject: 'lake trip', dataClass: 'photos' },
};

describe('OutboundAskService.send', () => {
  it('records the ask locally BEFORE the request leaves, so a silent peer is still auditable', async () => {
    const { service, askService, client } = makeService();

    await service.send(CTX as never, DTO, 'token');

    expect(askService.create).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ direction: 'outbound', peerLinkId: 'link-1', responderUserId: null }),
    );
    // create happened before send
    expect(askService.create.mock.invocationCallOrder[0]).toBeLessThan(
      client.send.mock.invocationCallOrder[0],
    );
  });

  it('sends a fresh correlation id, never the local row id', async () => {
    const { service, client } = makeService();

    await service.send(CTX as never, DTO, 'token');

    const [, body] = client.send.mock.calls[0];
    expect(body.askId).toBeTruthy();
    expect(body.askId).not.toBe('ask-1'); // the local id must not leak to the peer
  });

  it('persists that correlation BEFORE the request leaves, or the answer is uncollectable', async () => {
    const { service, correlationService, client } = makeService();

    await service.send(CTX as never, DTO, 'token');

    const [, body] = client.send.mock.calls[0];
    expect(correlationService.record).toHaveBeenCalledWith(
      expect.objectContaining({ peerLinkId: 'link-1', askId: 'ask-1', correlationId: body.askId }),
    );
    // The id is minted here and returned to nobody. Recorded after the fetch, a
    // timeout on a request the peer DID process would lose the only handle this
    // box has on the answer it is about to approve.
    expect(correlationService.record.mock.invocationCallOrder[0]).toBeLessThan(
      client.send.mock.invocationCallOrder[0],
    );
  });

  it('refuses an unknown handle and a revoked link identically', async () => {
    for (const bad of [null, link({ status: 'revoked' })]) {
      const { service, client } = makeService({ link: bad });
      await expect(service.send(CTX as never, DTO, 'token')).rejects.toThrow(/No active peer link/);
      expect(client.send).not.toHaveBeenCalled();
    }
  });

  it('requires a peer access token', async () => {
    const { service, client } = makeService();
    await expect(service.send(CTX as never, DTO, '  ')).rejects.toThrow();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('audits an answered reply without claiming WE disclosed anything', async () => {
    const { service, auditService } = makeService();

    await service.send(CTX as never, DTO, 'token');

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'answered',
        disclosedEntities: [],
        // The peer disclosed one item TO US. This table is a record of what
        // THIS box disclosed, and that is nothing.
        disclosedCount: 0,
        responderUserId: null,
      }),
      expect.anything(),
    );
  });

  it('names the peer by HANDLE, not only by link id', async () => {
    const { service, auditService } = makeService();

    await service.send(CTX as never, DTO, 'token');

    // The inbound path has always denormalized the handle onto its audit rows;
    // this one recorded the link id alone, so an outbound history row could not
    // say who was asked once the link was revoked or re-pointed.
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ peerLinkId: 'link-1', peerHandle: 'devon' }),
      expect.anything(),
    );
  });

  it('PERSISTS the answer the peer gave, instead of dropping it on the floor', async () => {
    const { service, answerService, persisted } = makeService();

    await service.send(CTX as never, DTO, 'token');

    // Nothing used to write this row, so even an AUTO-answered federated ask
    // left the asker's box with no readable answer — the only copy lived in the
    // return value of the mutation.
    expect(answerService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: 'ask-1',
        // `answerSource` is the provenance that survives: this box did not
        // compute it, a peer did.
        answerSource: 'peer',
        answer: expect.objectContaining({ form: 'existence', disclosedCount: 1, consentBasis: null }),
      }),
      expect.anything(),
    );
    expect(persisted.status).toBe('answered');
  });

  it('writes the answer, the terminal status and the audit row in ONE transaction', async () => {
    const { service, answerService, auditService } = makeService();

    await service.send(CTX as never, DTO, 'token');

    // `AskAnswerService.create` is insert-only, so a failure between the answer
    // and its audit row is PERMANENT — the retry raises a conflict instead of
    // writing the missing audit.
    const [, answerManager] = answerService.create.mock.calls[0];
    const [, auditManager] = auditService.record.mock.calls[0];
    expect(answerManager).toBeDefined();
    expect(auditManager).toBe(answerManager);
  });

  it('records NOTHING terminal when the peer did not answer — the ask stays collectable', async () => {
    const { service, auditService, answerService, persisted } = makeService({
      response: { askId: 'x', status: 'delivered' },
    });

    const result = await service.send(CTX as never, DTO, 'token');

    expect(result.response.status).toBe('delivered');
    // It used to write `outcome: 'declined'` here while the ask row stayed at
    // `delivered` — the owner's own records contradicting each other about an
    // exchange still in progress — and a later collection would then have made
    // it TWO audit rows for one ask.
    expect(auditService.record).not.toHaveBeenCalled();
    expect(answerService.create).not.toHaveBeenCalled();
    expect(persisted.status).toBe('delivered');
  });
});

describe('OutboundAskService.pollForAnswer', () => {
  it('collects an answer the peer approved after the send returned', async () => {
    const { service, client, answerService, persisted } = makeService({
      response: { askId: 'x', status: 'delivered' },
    });

    // The send left it open...
    await service.send(CTX as never, DTO, 'token');
    expect(persisted.status).toBe('delivered');

    // ...and the poll is what brings the human-approved answer across. Before
    // this existed, `POST /agent/v1/ask`'s synchronous reply was the ONLY
    // channel, so an approved answer stayed on the responder's box forever.
    const result = await service.pollForAnswer(CTX as never, 'ask-1', 'token');

    expect(client.poll).toHaveBeenCalledWith(expect.objectContaining({ id: 'link-1' }), 'corr-1', 'token');
    expect(result.response.status).toBe('answered');
    expect(answerService.create).toHaveBeenCalled();
    expect(persisted.status).toBe('answered');
  });

  it('refuses an ask that is not the caller’s own outbound ask', async () => {
    const { service, client } = makeService();
    const { service: inbound } = makeService();

    await expect(service.pollForAnswer({ userId: 'someone-else' } as never, 'ask-1', 't')).rejects.toThrow(
      /No outbound ask/,
    );
    expect(client.poll).not.toHaveBeenCalled();
    void inbound;
  });

  it('does not call the peer again once the ask is already answered', async () => {
    const { service, client } = makeService({
      askStatus: 'answered',
      storedAnswer: {
        form: 'existence',
        summary: '1 matching item.',
        disclosedEntities: [],
        disclosedCount: 1,
        withheldCount: 0,
      },
    });

    const result = await service.pollForAnswer(CTX as never, 'ask-1', 'token');

    // `AskAnswerService.create` is insert-only: a second absorb would raise a
    // ConflictException that no retry can clear.
    expect(client.poll).not.toHaveBeenCalled();
    expect(result.response.answer?.disclosedCount).toBe(1);
  });

  it('says `delivered` rather than throwing for an ask minted before correlations existed', async () => {
    const { service, client } = makeService({ correlation: null });

    const result = await service.pollForAnswer(CTX as never, 'ask-1', 'token');

    expect(client.poll).not.toHaveBeenCalled();
    expect(result.response.status).toBe('delivered');
  });

  it('stops collecting once the peer link is revoked', async () => {
    const { service, client } = makeService({ link: link({ status: 'revoked' }) });

    const result = await service.pollForAnswer(CTX as never, 'ask-1', 'token');

    expect(client.poll).not.toHaveBeenCalled();
    expect(result.response.status).toBe('delivered');
  });
});

describe('toStoredAnswer', () => {
  it('maps the WIRE availability form onto the `attribute` storage form', () => {
    // `ci.ask_answers` CHECKs the five LOCAL forms; `availability` is a wire
    // form. Storing it verbatim fails the whole absorb and loses the answer.
    const stored = toStoredAnswer({ form: 'availability', summary: '4 free slots.' });

    expect(stored.form).toBe('attribute');
    expect(stored.summary).toBe('4 free slots.');
  });

  it('never records a consent basis — the responder’s grant id is theirs', () => {
    const stored = toStoredAnswer({ form: 'existence', summary: 'x', disclosedCount: 3 });

    // "Was this a standing pre-authorization or a human decision?" is exactly
    // the distinction PEER_ASK_PENDING exists to stop crossing; a basis stored
    // here would be that distinction, written down.
    expect(stored.consentBasis).toBeNull();
    expect(stored.disclosedCount).toBe(3);
  });
});

/**
 * ═══ THE SSRF GUARD, THROUGH THE SERVICE THAT CALLS IT ═══
 *
 * `PeerAskClient.spec.ts` proves the client refuses. This proves the REFUSAL
 * IS FAIL-CLOSED once it reaches the caller: nothing is persisted, no audit row
 * is written, the ask does not go terminal, and the owner is told what actually
 * happened.
 *
 * That distinction has teeth here. `absorb` writes an answer, terminalizes the
 * ask and records a disclosure in ONE transaction, and `AskAnswerService.create`
 * is insert-only — so an outbound path that mistook a refusal for an answer
 * would write a PERMANENT row claiming a peer answered a question this box
 * never actually asked anyone.
 *
 * A real `PeerAskClient` is used, with only the socket faked, so removing the
 * guard shows up here as a persisted answer rather than as a passing test.
 */
describe('OutboundAskService — a refused endpoint leaves no trace of an answer', () => {
  function realClient(): PeerAskClient {
    const logger = {
      setContext: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    return new PeerAskClient(unsignedSigner() as never, logger as never);
  }

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each([
    ['loopback — the reproduced case', 'https://127.0.0.1:11434'],
    ['cloud metadata', 'https://169.254.169.254/latest'],
    ['the tailnet', 'https://100.64.3.4/agent/v1'],
  ])('send() to %s dials nothing and persists nothing', async (_label, endpoint) => {
    const { service, answerService, auditService, persisted } = makeService({
      link: link({ memoryEndpoint: endpoint }),
      peerClient: realClient(),
    });

    const result = await service.send(CTX as never, DTO, 'token');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.response).toEqual(
      expect.objectContaining({ status: 'delivered', reason: 'Peer endpoint not permitted' }),
    );
    expect(answerService.create).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    // Still collectable later, if the owner repoints the link at a real peer.
    expect(persisted.status).toBe('delivered');
  });

  it('pollForAnswer() to a refused endpoint dials nothing and persists nothing', async () => {
    const { service, answerService, auditService, persisted } = makeService({
      link: link({ memoryEndpoint: 'https://127.0.0.1:11434' }),
      peerClient: realClient(),
    });

    const result = await service.pollForAnswer(CTX as never, 'ask-1', 'token');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.response).toEqual(
      expect.objectContaining({ status: 'delivered', reason: 'Peer endpoint not permitted' }),
    );
    expect(answerService.create).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(persisted.status).toBe('delivered');
  });

  it('a peer that answers the collect route with a 307 yields no stored answer', async () => {
    // The collect route is a GET, so a followed redirect would not carry the
    // ask body — but it would still have this box GET an internal URL of the
    // peer's choosing, and hand whatever came back to `normalize` as if the
    // peer had said it.
    const { service, answerService, auditService, persisted } = makeService({
      peerClient: realClient(),
    });
    mockFetch.mockResolvedValue({
      status: 307,
      ok: false,
      headers: new Map<string, string>(),
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
      json: async () => ({}),
    });

    const result = await service.pollForAnswer(CTX as never, 'ask-1', 'token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe('delivered');
    expect(result.response.answer).toBeUndefined();
    expect(answerService.create).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(persisted.status).toBe('delivered');
  });

  it('CONTROL: the same path DOES persist when the peer actually answers', async () => {
    // Without this, every assertion above would still pass if `absorb` had
    // simply stopped working.
    const { service, answerService, auditService, persisted } = makeService({
      peerClient: realClient(),
    });
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map<string, string>(),
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
      json: async () => ({
        status: 'answered',
        answer: { form: 'existence', summary: '1 matching item.', disclosedCount: 1, withheldCount: 0 },
      }),
    });

    const result = await service.pollForAnswer(CTX as never, 'ask-1', 'token');

    expect(result.response.status).toBe('answered');
    expect(answerService.create).toHaveBeenCalled();
    expect(auditService.record).toHaveBeenCalled();
    expect(persisted.status).toBe('answered');
  });
});

/**
 * A signer with no key configured, which is every box until an operator sets
 * `peers.signingKeyJwk`. These suites are about the call, not the signature.
 */
function unsignedSigner() {
  return { signOutbound: () => null };
}
