import { T0, draft, memoryClaimStore, newParty, sign, signedRequest } from './__tests__/testKit';
import { ASK_COLLECT_TYPE_URI, ASK_REQUEST_TYPE_URI } from './askSpecs';
import { verifyEddsaJcs2022Proof } from './crypto/dataIntegrity';
import { StoreDuplicateGuard } from './duplicateGuard';
import {
  SOVEREIGN_ISSUER,
  TrustTasksEngine,
  type AskBackend,
  type EngineDeps,
  type EngineReply,
  type PeerIdentity,
} from './engine';
import { ERROR_TYPE_URI } from './errors';
import { registryTypeUri } from './typeUri';
import { SovereignKeriVidResolver } from './vid';

const box = newParty();
const alice = newParty();

const ASK_ID = 'ask-2026-11-05-0001';
const ASK_BODY = {
  askId: ASK_ID,
  askerHandle: 'alice',
  prompt: 'Are you free for lunch on Friday?',
  request: {
    archetype: 'availability',
    from: '2026-11-06T11:00:00Z',
    to: '2026-11-06T14:00:00Z',
    minMinutes: 60,
  },
};
const PENDING = { askId: ASK_ID, status: 'pending', reason: 'No answer is available' } as const;
const ANSWERED = {
  askId: ASK_ID,
  status: 'answered',
  answer: {
    form: 'availability',
    summary: 'Free 12:00–13:00',
    free: [{ start: '2026-11-06T12:00:00Z', end: '2026-11-06T13:00:00Z' }],
  },
} as const;

interface Harness {
  engine: TrustTasksEngine;
  calls: {
    handle: [PeerIdentity, unknown, unknown][];
    result: [PeerIdentity, string][];
    consume: PeerIdentity[];
    poll: PeerIdentity[];
  };
  logs: string[];
  backend: { handle: AskBackend['handle']; result: AskBackend['result'] };
}

function harness(
  overrides: Partial<EngineDeps> = {},
  replies: { handle?: unknown; result?: unknown } = {},
): Harness {
  const calls: Harness['calls'] = { handle: [], result: [], consume: [], poll: [] };
  const logs: string[] = [];
  const backend: Harness['backend'] = {
    handle: async (identity, body, channel) => {
      calls.handle.push([identity, body, channel]);

      return (replies.handle ?? ANSWERED) as never;
    },
    result: async (identity, askId) => {
      calls.result.push([identity, askId]);

      return (replies.result ?? PENDING) as never;
    },
  };

  const engine = new TrustTasksEngine({
    signer: box,
    resolver: new SovereignKeriVidResolver(),
    guard: new StoreDuplicateGuard(memoryClaimStore()),
    asks: backend,
    throttle: {
      consume: async (identity) => void calls.consume.push(identity),
      consumePoll: async (identity) => void calls.poll.push(identity),
    },
    admit: async (vid) => vid === alice.vid,
    provenance: (vid, verifiedAt) => ({
      keyThumbprint: `thumb:${vid.slice(-4)}`,
      verifiedAt,
      covered: ['trust-task:eddsa-jcs-2022'],
    }),
    now: () => T0,
    log: (message) => void logs.push(message),
    ...overrides,
  });

  return { engine, calls, logs, backend };
}

const documentOf = (reply: EngineReply) => {
  expect(reply.kind).toBe('document');

  return reply as Extract<EngineReply, { kind: 'document' }>;
};

const askRequest = (payload: object = ASK_BODY, extra: object = {}) =>
  signedRequest({
    from: alice,
    to: box.vid,
    type: ASK_REQUEST_TYPE_URI,
    payload: payload as never,
    extra: extra as never,
  });

describe('TrustTasksEngine', () => {
  describe('ask/request — a second door into the same four gates', () => {
    it('hands the verified peer and the ask to the ask pipeline exactly as the sovereign peer path does', async () => {
      const { engine, calls } = harness();

      const reply = documentOf(await engine.handle(askRequest()));

      expect(calls.consume).toEqual([{ issuer: SOVEREIGN_ISSUER, subject: alice.vid }]);
      expect(calls.handle).toHaveLength(1);

      const [identity, body, channel] = calls.handle[0] as [
        PeerIdentity,
        typeof ASK_BODY,
        { keyThumbprint: string; covered: string[]; verifiedAt: Date },
      ];
      expect(identity).toEqual({ issuer: 'did:keri', subject: alice.vid });
      expect(body).toEqual(ASK_BODY);
      expect(channel.covered).toEqual(['trust-task:eddsa-jcs-2022']);
      expect(channel.verifiedAt).toEqual(new Date(T0));
      expect(reply.status).toBe(200);
    });

    it('answers with a signed #response correlated to the request, from the box to the asker', async () => {
      const { engine } = harness();
      const request = askRequest();

      const { document } = documentOf(await engine.handle(request));

      expect(document).toMatchObject({
        type: `${ASK_REQUEST_TYPE_URI}#response`,
        issuer: box.vid,
        recipient: alice.vid,
        threadId: request.id,
        payload: ANSWERED,
      });
      expect(document.id).not.toBe(request.id);
      expect(document.proof).toMatchObject({
        cryptosuite: 'eddsa-jcs-2022',
        proofPurpose: 'authentication',
        verificationMethod: box.verificationMethod,
      });
      expect(verifyEddsaJcs2022Proof(document, box.publicKey)).toBe(true);
    });

    it('answers a non-answer with the one uninformative reply — ADR-0001 survives the new door', async () => {
      const { engine } = harness({}, { handle: PENDING });

      const { status, document } = documentOf(await engine.handle(askRequest()));

      expect(status).toBe(200);
      expect(document.payload).toEqual(PENDING);
      // A refused, declined, expired or unknown ask is a 200 `pending`, never `permissionDenied`.
      expect(document.type).not.toBe(ERROR_TYPE_URI);
    });

    it('does not execute the same document twice, and hands nothing back to the replay', async () => {
      const { engine, calls } = harness({}, { result: ANSWERED });
      const request = askRequest();

      documentOf(await engine.handle(request));
      const second = await engine.handle(JSON.parse(JSON.stringify(request)));

      expect(second).toEqual({ kind: 'absorbed' });
      expect(calls.handle).toHaveLength(1);
      // The stored answer is not read for the replay either: a captured document fetches nothing.
      expect(calls.result).toHaveLength(0);
    });

    it('does not burn a document id on a throttled attempt: the identical bytes work once the budget relents', async () => {
      let denied = true;
      const { engine, calls } = harness({
        throttle: {
          consume: async (identity) => {
            if (denied) {
              throw Object.assign(new Error('too many'), {
                getStatus: () => 429,
                getResponse: () => ({ statusCode: 429, message: 'Too many asks', retryAfterMs: 12_300 }),
              });
            }

            calls.consume.push(identity);
          },
          consumePoll: async () => undefined,
        },
      });
      const request = askRequest();

      const throttled = documentOf(await engine.handle(request));

      expect(throttled.status).toBe(503);
      expect(throttled.document.payload).toMatchObject({
        code: 'unavailable',
        retryable: true,
        // 12.3 s from T0, rounded UP to the next whole second.
        retryAfter: '2026-11-05T12:00:13Z',
      });
      expect(calls.handle).toHaveLength(0);

      denied = false;
      const retried = documentOf(await engine.handle(JSON.parse(JSON.stringify(request))));

      expect(retried.status).toBe(200);
      expect(calls.handle).toHaveLength(1);
    });

    it('carries the request’s parentThreadId onto its reply (SPEC 7.1)', async () => {
      const { engine } = harness();
      const request = askRequest(ASK_BODY, { parentThreadId: 'urn:uuid:outer exchange' });

      const { document } = documentOf(await engine.handle(request));

      expect(document.parentThreadId).toBe('urn:uuid:outer exchange');
    });

    it('answers a different document under an accepted id with idConflict and executes nothing', async () => {
      const { engine, calls } = harness();
      const original = askRequest(ASK_BODY, { id: 'urn:uuid:one-id' });
      const different = askRequest(
        { ...ASK_BODY, prompt: 'A different question?' },
        { id: 'urn:uuid:one-id' },
      );

      documentOf(await engine.handle(original));
      const reply = documentOf(await engine.handle(different));

      expect(reply.status).toBe(409);
      expect(reply.document.payload).toMatchObject({ code: 'idConflict', retryable: false });
      expect(calls.handle).toHaveLength(1);
    });

    it('closes the payload: an unrecognized member is malformedRequest, answered to the admitted sender', async () => {
      const { engine, calls } = harness();

      const reply = documentOf(await engine.handle(askRequest({ ...ASK_BODY, sneaky: true })));

      expect(reply.status).toBe(400);
      expect(reply.document.payload).toMatchObject({ code: 'malformedRequest' });
      expect(calls.handle).toHaveLength(0);
    });

    it('closes the nested request too', async () => {
      const { engine } = harness();
      const nested = { ...ASK_BODY, request: { ...ASK_BODY.request, extra: 1 } };

      expect(documentOf(await engine.handle(askRequest(nested))).document.payload).toMatchObject({
        code: 'malformedRequest',
      });
    });
  });

  describe('ask/collect', () => {
    it('is a read: it spends the poll budget, evaluates nothing, and returns the recorded outcome', async () => {
      const { engine, calls } = harness({}, { result: ANSWERED });
      const request = signedRequest({
        from: alice,
        to: box.vid,
        type: ASK_COLLECT_TYPE_URI,
        payload: { askId: ASK_ID },
      });

      const { document } = documentOf(await engine.handle(request));

      expect(calls.poll).toEqual([{ issuer: 'did:keri', subject: alice.vid }]);
      expect(calls.consume).toEqual([]);
      expect(calls.handle).toEqual([]);
      expect(document.payload).toEqual(ANSWERED);
      expect(document.type).toBe(`${ASK_COLLECT_TYPE_URI}#response`);
    });

    it('is single-use like every other document: the identical collect is absorbed, a fresh one is answered', async () => {
      const { engine, calls } = harness({}, { result: PENDING });
      const collect = () =>
        signedRequest({
          from: alice,
          to: box.vid,
          type: ASK_COLLECT_TYPE_URI,
          payload: { askId: ASK_ID },
        });
      const request = collect();

      documentOf(await engine.handle(request));
      // A captured collect document reads nothing back...
      expect(await engine.handle(JSON.parse(JSON.stringify(request)))).toEqual({ kind: 'absorbed' });
      // ...and a producer that lost the response simply asks again with a new document.
      documentOf(await engine.handle(collect()));

      expect(calls.result).toHaveLength(2);
    });
  });

  describe('trust-task-discovery', () => {
    const discover = (version: '0.1' | '0.2' | '0.3' | '0.4', payload: object = {}) =>
      signedRequest({
        from: alice,
        to: box.vid,
        type: registryTypeUri('trust-task-discovery', version),
        payload: payload as never,
      });

    it('lists every served type, bare and sorted, with the window on 0.4', async () => {
      const { engine } = harness();

      const { document } = documentOf(await engine.handle(discover('0.4')));

      expect(document.type).toBe(`${registryTypeUri('trust-task-discovery', '0.4')}#response`);
      expect(document.payload).toEqual({
        frameworkVersion: '0.7.0',
        acceptanceWindow: { maxAgeSeconds: 300, clockSkewSeconds: 30 },
        supportedTypes: [
          ASK_COLLECT_TYPE_URI,
          ASK_REQUEST_TYPE_URI,
          registryTypeUri('trust-task-discovery', '0.1'),
          registryTypeUri('trust-task-discovery', '0.2'),
          registryTypeUri('trust-task-discovery', '0.3'),
          registryTypeUri('trust-task-discovery', '0.4'),
        ].sort(),
      });
    });

    it('answers 0.2 in 0.2: its closed response schema has no acceptanceWindow', async () => {
      const { engine } = harness();

      const { document } = documentOf(await engine.handle(discover('0.2')));

      expect(document.payload).not.toHaveProperty('acceptanceWindow');
      expect(document.type).toBe(`${registryTypeUri('trust-task-discovery', '0.2')}#response`);
    });

    it('answers every served version in the version it was asked (SPEC 5.2)', async () => {
      const { engine } = harness();

      for (const [version, hasWindow, frameworkVersion] of [
        ['0.1', false, '0.7'],
        ['0.2', false, '0.7.0'],
        ['0.3', true, '0.7.0'],
        ['0.4', true, '0.7.0'],
      ] as const) {
        const { document } = documentOf(await engine.handle(discover(version)));

        expect(document.type).toBe(`${registryTypeUri('trust-task-discovery', version)}#response`);
        expect(document.payload).toMatchObject({ frameworkVersion });
        if (hasWindow) {
          expect(document.payload).toHaveProperty('acceptanceWindow', expect.anything());
        } else {
          expect(document.payload).not.toHaveProperty('acceptanceWindow');
        }
      }
    });

    it('spends the poll budget, like any other read', async () => {
      const { engine, calls } = harness();

      documentOf(await engine.handle(discover('0.4')));

      expect(calls.poll).toEqual([{ issuer: 'did:keri', subject: alice.vid }]);
      expect(calls.consume).toEqual([]);
    });

    it('filters by slug pattern', async () => {
      const { engine } = harness();

      const { document } = documentOf(await engine.handle(discover('0.4', { patterns: ['ask/*'] })));

      expect((document.payload as { supportedTypes: string[] }).supportedTypes).toEqual([
        ASK_COLLECT_TYPE_URI,
        ASK_REQUEST_TYPE_URI,
      ]);
    });

    it('bounds the pattern list', async () => {
      const { engine } = harness();
      const patterns = Array.from({ length: 17 }, (_, index) => `p${index}`);

      expect(documentOf(await engine.handle(discover('0.4', { patterns }))).document.payload).toMatchObject({
        code: 'malformedRequest',
      });
    });

    it('is only for parties this box deals with', async () => {
      const { engine } = harness({ admit: async () => false });

      expect(await engine.handle(discover('0.4'))).toEqual({ kind: 'refused' });
    });
  });

  describe('what a stranger is told — nothing', () => {
    const strangers: [string, () => unknown][] = [
      ['an unparseable document', () => 'nope'],
      ['a tampered document', () => ({ ...askRequest(), payload: { ...ASK_BODY, prompt: 'changed' } })],
      ['a document with no proof', () => ({ ...askRequest(), proof: undefined })],
      [
        'a forgery under the peer’s name',
        () =>
          sign(draft({ from: alice, to: box.vid, type: ASK_REQUEST_TYPE_URI, payload: ASK_BODY }), {
            verificationMethod: alice.verificationMethod,
            privateKey: newParty().privateKey,
          }),
      ],
      [
        'a document for another box',
        () =>
          signedRequest({ from: alice, to: newParty().vid, type: ASK_REQUEST_TYPE_URI, payload: ASK_BODY }),
      ],
      [
        'a type this box does not serve',
        () => signedRequest({ from: alice, to: box.vid, type: 'https://example.com/spec/x/0.1' }),
      ],
      [
        'a stale document',
        () =>
          signedRequest({
            from: alice,
            to: box.vid,
            type: ASK_REQUEST_TYPE_URI,
            payload: ASK_BODY,
            at: T0 - 3_600_000,
          }),
      ],
    ];

    for (const [label, build] of strangers) {
      it(`${label}: a bare refusal, logged for the operator`, async () => {
        const { engine, logs, calls } = harness();

        expect(await engine.handle(build())).toEqual({ kind: 'refused' });
        expect(logs.length).toBeGreaterThan(0);
        expect(calls.handle).toHaveLength(0);
      });
    }

    it('and an unlinked sender with a perfect proof is told no more than a forger', async () => {
      const stranger = newParty();
      const { engine } = harness();

      expect(
        await engine.handle(
          signedRequest({ from: stranger, to: box.vid, type: ASK_REQUEST_TYPE_URI, payload: ASK_BODY }),
        ),
      ).toEqual({
        kind: 'refused',
      });
    });
  });

  describe('what an admitted peer is told when its document is refused', () => {
    it('a signed trust-task-error with a fixed message, the request’s identity and no internals', async () => {
      const { engine } = harness();
      const bad = askRequest({ ...ASK_BODY, askId: 'short' });

      const reply = documentOf(await engine.handle(bad));

      expect(reply.status).toBe(400);
      expect(reply.document).toMatchObject({
        type: ERROR_TYPE_URI,
        issuer: box.vid,
        recipient: alice.vid,
        threadId: bad.id,
        payload: {
          code: 'malformedRequest',
          message: 'The document did not validate.',
          retryable: false,
          inResponseTo: { typeUri: ASK_REQUEST_TYPE_URI, id: bad.id },
        },
      });
      expect(verifyEddsaJcs2022Proof(reply.document, box.publicKey)).toBe(true);
      expect(JSON.stringify(reply.document)).not.toMatch(/askId|short|schema|zod|payload does not/);
    });
  });

  describe('when the pipeline behind it fails', () => {
    const failing = (error: unknown): Partial<EngineDeps> => ({
      asks: {
        handle: async () => {
          throw error;
        },
        result: async () => PENDING as never,
      },
    });

    it('reports a failure after acceptance as NOT retryable: the identical bytes would be absorbed', async () => {
      const { engine } = harness(failing(new Error('boom')));
      const request = askRequest();

      const reply = documentOf(await engine.handle(request));

      expect(reply.status).toBe(500);
      expect(reply.document.payload).toMatchObject({ code: 'internalError', retryable: false });
      // The producer is told to send a new document, because the same bytes get nothing more.
      expect(await engine.handle(JSON.parse(JSON.stringify(request)))).toEqual({ kind: 'absorbed' });
    });

    it('reports the ask pipeline’s own 400 as the asker’s mistake, as the peer route does', async () => {
      for (const status of [400, 422]) {
        const { engine } = harness(
          failing(Object.assign(new Error('Malformed ask'), { getStatus: () => status })),
        );

        const reply = documentOf(await engine.handle(askRequest()));

        expect(reply.status).toBe(400);
        expect(reply.document.payload).toMatchObject({ code: 'malformedRequest', retryable: false });
        expect(JSON.stringify(reply.document)).not.toContain('Malformed ask');
      }
    });

    it('turns a document away as unavailable, retryable, when the budget cannot be consulted', async () => {
      const { engine, calls } = harness({
        throttle: {
          consume: async () => {
            throw new Error('store down');
          },
          consumePoll: async () => undefined,
        },
      });

      const reply = documentOf(await engine.handle(askRequest()));

      expect(reply.status).toBe(503);
      expect(reply.document.payload).toMatchObject({ code: 'unavailable', retryable: true });
      expect(calls.handle).toHaveLength(0);
    });

    it('refuses, as to any stranger, when the link vanished between admission and the handler', async () => {
      for (const status of [401, 403, 404]) {
        const { engine } = harness(failing(Object.assign(new Error('gone'), { getStatus: () => status })));

        expect(await engine.handle(askRequest())).toEqual({ kind: 'refused' });
      }
    });

    it('reports an internalError without leaking the cause', async () => {
      const { engine, logs } = harness(failing(new Error('relation "ci.asks" does not exist')));

      const reply = documentOf(await engine.handle(askRequest()));

      expect(reply.status).toBe(500);
      expect(reply.document.payload).toMatchObject({
        code: 'internalError',
        message: 'An internal error occurred.',
      });
      expect(JSON.stringify(reply.document)).not.toContain('relation');
      expect(logs.join('\n')).toContain('relation "ci.asks" does not exist');
    });

    it('does not send a response the specification does not describe — a status outside answered/pending is a bug here', async () => {
      const { engine } = harness(
        {},
        { handle: { askId: ASK_ID, status: 'declined', reason: 'Not permitted' } },
      );

      const reply = documentOf(await engine.handle(askRequest()));

      expect(reply.status).toBe(500);
      expect(reply.document.payload).toMatchObject({ code: 'internalError' });
      expect(JSON.stringify(reply.document)).not.toContain('declined');
    });
  });

  it('exposes the box’s own VID, which peers address documents to', () => {
    expect(harness().engine.vid).toBe(box.vid);
  });
});
