import {
  ECHO_TYPE,
  T0,
  draft,
  echoSpec,
  memoryClaimStore,
  newParty,
  sign,
  signedRequest,
} from './__tests__/testKit';
import { TrustTaskConsumer, type Accepted, type ConsumerOptions, type Rejection } from './consumer';
import { createEddsaJcs2022Proof } from './crypto/dataIntegrity';
import { StoreDuplicateGuard } from './duplicateGuard';
import { SpecRegistry, type TaskSpecification } from './specs';
import { SovereignKeriVidResolver, sovereignVerificationMethodId, type VidResolver } from './vid';

const box = newParty();
const alice = newParty();

function consumerFor(spec: TaskSpecification = echoSpec(), options: Partial<ConsumerOptions> = {}) {
  const store = memoryClaimStore();
  const consumer = new TrustTaskConsumer({
    localVid: box.vid,
    specs: new SpecRegistry().register(spec),
    resolver: new SovereignKeriVidResolver(),
    guard: new StoreDuplicateGuard(store),
    now: () => T0,
    ...options,
  });

  return { consumer, store };
}

const accepted = (result: unknown): Accepted => {
  expect((result as { kind: string }).kind).toBe('accepted');

  return result as Accepted;
};

const rejected = (result: unknown, code: string): Rejection => {
  expect(result).toMatchObject({ kind: 'rejected', code });

  return result as Rejection;
};

describe('TrustTaskConsumer', () => {
  describe('a well-formed, signed request', () => {
    it('is accepted, with the issuer the proof established and the payload the schema parsed', async () => {
      const { consumer } = consumerFor();
      const request = signedRequest({ from: alice, to: box.vid, payload: { message: 'hi' } });

      const result = accepted(await consumer.consume(request));

      expect(result).toMatchObject({
        issuer: alice.vid,
        payload: { message: 'hi' },
        verificationMethod: alice.verificationMethod,
        duplicate: false,
      });
      expect(result.spec.slug).toBe('test/echo');
      expect(result.document).toBe(request);
    });

    it('accepts an explicit #request fragment', async () => {
      const { consumer } = consumerFor();

      accepted(
        await consumer.consume(signedRequest({ from: alice, to: box.vid, type: `${ECHO_TYPE}#request` })),
      );
    });
  });

  describe('shape and type — SPEC §7.2 items 1 and 3', () => {
    const cases: [string, unknown, string][] = [
      ['a non-object', 'nope', 'malformedRequest'],
      ['an array', [], 'malformedRequest'],
      ['a document with no id', { type: ECHO_TYPE, payload: {} }, 'malformedRequest'],
      ['a payload that is not an object', { id: 'x', type: ECHO_TYPE, payload: [] }, 'malformedRequest'],
      [
        'an issuedAt that is not RFC 3339',
        { id: 'x', type: ECHO_TYPE, payload: {}, issuedAt: 'yesterday' },
        'malformedRequest',
      ],
      [
        'an issuer with whitespace',
        { id: 'x', type: ECHO_TYPE, payload: {}, issuer: 'did: bad' },
        'malformedRequest',
      ],
      ['a type that is not a Type URI', { id: 'x', type: 'echo', payload: {} }, 'malformedRequest'],
      [
        'an http Type URI',
        { id: 'x', type: 'http://example.com/trust-tasks/spec/test/echo/0.1', payload: {} },
        'malformedRequest',
      ],
      [
        'a binding URI used as a type',
        { id: 'x', type: 'https://trusttasks.org/binding/https/0.3', payload: {} },
        'malformedRequest',
      ],
      [
        'a type this box does not serve',
        { id: 'x', type: 'https://example.com/trust-tasks/spec/test/other/0.1', payload: {} },
        'unsupportedType',
      ],
      [
        'a known type at a version it does not serve',
        { id: 'x', type: 'https://example.com/trust-tasks/spec/test/echo/0.2', payload: {} },
        'unsupportedVersion',
      ],
      [
        'a #response variant, which is somebody’s reply and not a task',
        { id: 'x', type: `${ECHO_TYPE}#response`, payload: {} },
        'unsupportedType',
      ],
    ];

    for (const [label, input, code] of cases) {
      it(`refuses ${label} as ${code}, before the sender is established`, async () => {
        const { consumer } = consumerFor();

        expect(rejected(await consumer.consume(input), code)).toMatchObject({
          stage: 'unauthenticated',
          addressTo: null,
        });
      });
    }
  });

  describe('the freshness window — SPEC §7.2 items 4 and 13', () => {
    const at = (offsetSeconds: number, extra: Record<string, unknown> = {}) =>
      signedRequest({ from: alice, to: box.vid, at: T0 + offsetSeconds * 1000, extra });

    it('accepts a document issued just now, a little in the future (skew), and a little in the past', async () => {
      const { consumer } = consumerFor();

      accepted(await consumer.consume(at(0)));
      accepted(await consumer.consume(at(30)));
      accepted(await consumer.consume(at(-299)));
    });

    it('refuses a document issued beyond the skew in the future as malformed, not expired', async () => {
      const { consumer } = consumerFor();

      rejected(await consumer.consume(at(31)), 'malformedRequest');
    });

    it('refuses a document older than the maximum age plus skew as expired', async () => {
      const { consumer } = consumerFor();

      accepted(await consumer.consume(at(-329)));
      rejected(await consumer.consume(at(-331)), 'expired');
    });

    it('refuses a document whose expiry is at or before its issue time as malformed', async () => {
      const { consumer } = consumerFor();

      rejected(await consumer.consume(at(0, { expiresAt: new Date(T0).toISOString() })), 'malformedRequest');
      rejected(
        await consumer.consume(at(0, { expiresAt: new Date(T0 - 1000).toISOString() })),
        'malformedRequest',
      );
    });

    it('refuses a document at the instant its expiresAt is reached (the bound is inclusive)', async () => {
      const { consumer } = consumerFor();
      const expiring = (offsetSeconds: number) =>
        at(-10, { expiresAt: new Date(T0 + offsetSeconds * 1000).toISOString() });

      accepted(await consumer.consume(expiring(1)));
      rejected(await consumer.consume(expiring(0)), 'expired');
    });

    it('applies the maximum age even to a document that states a far-future expiry', async () => {
      const { consumer } = consumerFor();

      rejected(
        await consumer.consume(at(-400, { expiresAt: new Date(T0 + 86_400_000).toISOString() })),
        'expired',
      );
    });

    it('requires issuedAt when the specification does', async () => {
      const { consumer } = consumerFor();
      const unsigned = draft({ from: alice, to: box.vid });
      delete (unsigned as { issuedAt?: string }).issuedAt;

      rejected(await consumer.consume(sign(unsigned, alice)), 'malformedRequest');
    });
  });

  describe('the parties — SPEC §4.8 and §7.2 items 5 and 6', () => {
    it('refuses a document addressed to another party as wrongRecipient', async () => {
      const { consumer } = consumerFor();

      rejected(await consumer.consume(signedRequest({ from: alice, to: newParty().vid })), 'wrongRecipient');
    });

    it('refuses a document with no issuer, or no recipient, when the specification requires them', async () => {
      const { consumer } = consumerFor();
      const noIssuer = draft({ from: alice, to: box.vid });
      delete (noIssuer as { issuer?: string }).issuer;
      const noRecipient = draft({ from: alice, to: box.vid });
      delete (noRecipient as { recipient?: string }).recipient;

      rejected(await consumer.consume(sign(noIssuer, alice)), 'malformedRequest');
      rejected(await consumer.consume(sign(noRecipient, alice)), 'malformedRequest');
    });

    it('refuses an in-band issuer that disagrees with the transport sender, and addresses the sender, not the contested issuer', async () => {
      const { consumer } = consumerFor();
      const mallory = newParty();
      const request = signedRequest({ from: alice, to: box.vid });

      const result = rejected(await consumer.consume(request, { sender: mallory.vid }), 'identityMismatch');

      expect(result.addressTo).toBe(mallory.vid);
      // The document's id is omitted: the party addressed did not necessarily compose it (§8.2).
      expect(result.inResponseTo).toEqual({ typeUri: ECHO_TYPE });
    });

    it('refuses an in-band recipient that disagrees with the transport recipient', async () => {
      const { consumer } = consumerFor();

      rejected(
        await consumer.consume(signedRequest({ from: alice, to: box.vid }), { recipient: newParty().vid }),
        'identityMismatch',
      );
    });
  });

  describe('the proof — SPEC §4.7, §4.8.2 and §7.2 items 7 and 8', () => {
    it('refuses a missing proof as proofRequired when the specification requires one', async () => {
      const { consumer } = consumerFor();

      rejected(await consumer.consume(draft({ from: alice, to: box.vid })), 'proofRequired');
    });

    it('refuses a proof with no in-band recipient on a non-bearer specification, as malformed', async () => {
      const { consumer } = consumerFor(echoSpec({ parties: { issuer: 'REQUIRED', recipient: 'OPTIONAL' } }));
      const unsigned = draft({ from: alice, to: box.vid });
      delete (unsigned as { recipient?: string }).recipient;

      const result = rejected(await consumer.consume(sign(unsigned, alice)), 'malformedRequest');

      expect(result.reason).toMatch(/recipient/);
    });

    it('accepts a proof with no recipient on a bearer specification', async () => {
      const { consumer } = consumerFor(
        echoSpec({ bearer: true, parties: { issuer: 'REQUIRED', recipient: 'OPTIONAL' } }),
      );
      const unsigned = draft({ from: alice, to: box.vid });
      delete (unsigned as { recipient?: string }).recipient;

      accepted(await consumer.consume(sign(unsigned, alice)));
    });

    it('refuses a tampered document as proofInvalid', async () => {
      const { consumer } = consumerFor();
      const request = signedRequest({ from: alice, to: box.vid, payload: { message: 'pay alice' } });

      rejected(await consumer.consume({ ...request, payload: { message: 'pay mallory' } }), 'proofInvalid');
      rejected(
        await consumer.consume({ ...request, recipient: box.vid, issuedAt: '2026-11-05T12:00:01Z' }),
        'proofInvalid',
      );
    });

    it('refuses a document signed by a key that is not the issuer’s — the impersonation case', async () => {
      const { consumer } = consumerFor();
      const mallory = newParty();
      // Mallory claims to be Alice, naming Alice’s method, but can only sign with Mallory’s key.
      const forged = sign(draft({ from: alice, to: box.vid }), {
        verificationMethod: alice.verificationMethod,
        privateKey: mallory.privateKey,
      });

      rejected(await consumer.consume(forged), 'proofInvalid');
    });

    it('refuses a verification method that belongs to another identifier, even if the signature is valid', async () => {
      const { consumer } = consumerFor();
      const mallory = newParty();
      // A perfectly valid signature by Mallory, over a document claiming Alice as issuer.
      const forged = sign(draft({ from: alice, to: box.vid }), mallory);

      rejected(await consumer.consume(forged), 'proofInvalid');
    });

    it('refuses a cryptosuite it does not verify — an unsupported suite is a failure, not an absence', async () => {
      const { consumer } = consumerFor();
      const request = signedRequest({ from: alice, to: box.vid });
      const swapped = { ...request, proof: { ...(request.proof as object), cryptosuite: 'ecdsa-jcs-2019' } };

      rejected(await consumer.consume(swapped), 'proofInvalid');
    });

    it('refuses a proof purpose that is not a signing relationship', async () => {
      const { consumer } = consumerFor();

      rejected(
        await consumer.consume(
          sign(draft({ from: alice, to: box.vid }), alice, { proofPurpose: 'keyAgreement' }),
        ),
        'proofInvalid',
      );
      rejected(
        await consumer.consume(
          sign(draft({ from: alice, to: box.vid }), alice, { proofPurpose: 'whatever' }),
        ),
        'proofInvalid',
      );
    });

    it('accepts any signing relationship the issuer’s controller document lists the method under', async () => {
      const { consumer } = consumerFor();

      accepted(
        await consumer.consume(
          sign(draft({ from: alice, to: box.vid }), alice, { proofPurpose: 'assertionMethod' }),
        ),
      );
    });

    it('refuses an issuer it cannot resolve as proofInvalid, and a resolver that fails as indeterminate', async () => {
      const unknown = 'did:web:example.com';
      const request = sign(
        { ...draft({ from: alice, to: box.vid }), issuer: unknown },
        { verificationMethod: `${unknown}#key-1`, privateKey: alice.privateKey },
      );

      rejected(await consumerFor().consumer.consume(request), 'proofInvalid');

      const failing: VidResolver = {
        resolve: async () => {
          throw new Error('network');
        },
      };

      rejected(
        await consumerFor(echoSpec(), { resolver: failing }).consumer.consume(
          signedRequest({ from: alice, to: box.vid }),
        ),
        'indeterminate',
      );
    });

    it('verifies over the document as received, whatever its member order or the key order of the proof', async () => {
      const { consumer } = consumerFor();
      const request = signedRequest({ from: alice, to: box.vid });
      const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(request).reverse())));

      accepted(await consumer.consume(reordered));
    });

    it('does not let a verification method id differ from the one the controller document lists', async () => {
      const { consumer } = consumerFor();
      const unsigned = draft({ from: alice, to: box.vid });
      const proof = createEddsaJcs2022Proof(unsigned, {
        verificationMethod: `${alice.vid}#not-the-key`,
        privateKey: alice.privateKey,
        created: '2026-11-05T12:00:00Z',
      });

      rejected(await consumer.consume({ ...unsigned, proof }), 'proofInvalid');
      expect(sovereignVerificationMethodId(alice.vid)).not.toBe(`${alice.vid}#not-the-key`);
    });
  });

  describe('admission — authentication is not authorization (SPEC §7.2 item 10)', () => {
    it('looks a claimed sender up BEFORE its proof, so a stranger costs no cryptography, and says nothing', async () => {
      const seen: unknown[] = [];
      let resolved = 0;
      const resolver: VidResolver = {
        resolve: async (vid) => (resolved++, new SovereignKeriVidResolver().resolve(vid)),
      };
      const { consumer } = consumerFor(echoSpec(), {
        resolver,
        admit: async (vid) => (seen.push(vid), false),
      });

      const result = rejected(
        await consumer.consume(signedRequest({ from: alice, to: box.vid, payload: { not: 'valid' } })),
        'permissionDenied',
      );

      expect(seen).toEqual([alice.vid]);
      expect(resolved).toBe(0);
      expect(result).toMatchObject({ stage: 'unauthenticated', addressTo: null });
    });

    it('checks the proof only for a sender it admits, and admits nobody on a forged proof alone', async () => {
      let resolved = 0;
      const resolver: VidResolver = {
        resolve: async (vid) => (resolved++, new SovereignKeriVidResolver().resolve(vid)),
      };
      const { consumer } = consumerFor(echoSpec(), { resolver, admit: async () => true });
      const forged = sign(draft({ from: alice, to: box.vid }), {
        verificationMethod: alice.verificationMethod,
        privateKey: newParty().privateKey,
      });

      expect(rejected(await consumer.consume(forged), 'proofInvalid')).toMatchObject({
        stage: 'unauthenticated',
      });
      expect(resolved).toBe(1);
    });

    it('treats an admitted sender as authenticated, so its later refusals are answerable', async () => {
      const { consumer } = consumerFor(echoSpec(), { admit: async () => true });

      const result = rejected(
        await consumer.consume(signedRequest({ from: alice, to: box.vid, payload: { extra: 1 } })),
        'malformedRequest',
      );

      expect(result).toMatchObject({ stage: 'authenticated', addressTo: alice.vid });
    });

    it('does not run the payload schema for a stranger', async () => {
      let parsed = 0;
      const spec = echoSpec({
        request: {
          safeParse: () => ((parsed += 1), { success: true, data: {} }),
        } as unknown as TaskSpecification['request'],
      });
      const { consumer } = consumerFor(spec, { admit: async () => false });

      await consumer.consume(signedRequest({ from: alice, to: box.vid }));

      expect(parsed).toBe(0);
    });

    it('refuses a sender with no proof and no transport identity: nobody has been authenticated', async () => {
      const { consumer } = consumerFor(echoSpec({ proof: { request: 'OPTIONAL', response: 'OPTIONAL' } }));

      rejected(await consumer.consume(draft({ from: alice, to: box.vid })), 'permissionDenied');
    });

    it('accepts an unsigned document when the transport authenticated the sender and the specification allows it', async () => {
      const { consumer } = consumerFor(echoSpec({ proof: { request: 'OPTIONAL', response: 'OPTIONAL' } }));

      const result = accepted(
        await consumer.consume(draft({ from: alice, to: box.vid }), {
          sender: alice.vid,
          recipient: box.vid,
        }),
      );

      expect(result.issuer).toBe(alice.vid);
      expect(result.verificationMethod).toBeUndefined();
    });
  });

  describe('the size bound — SPEC §7.3 item 21', () => {
    it('refuses a document larger than the specification allows before anything is looked up or hashed', async () => {
      let lookups = 0;
      let resolved = 0;
      const { consumer } = consumerFor(echoSpec({ maxDocumentBytes: 600 }), {
        admit: async () => (lookups++, true),
        resolver: { resolve: async (vid) => (resolved++, new SovereignKeriVidResolver().resolve(vid)) },
      });
      const request = signedRequest({ from: alice, to: box.vid });

      rejected(await consumer.consume(request, {}, { bytes: 601 }), 'malformedRequest');
      expect(lookups + resolved).toBe(0);
      accepted(await consumer.consume(request, {}, { bytes: 600 }));
    });

    it('measures the document itself when the binding does not say how large the body was', async () => {
      const { consumer } = consumerFor(echoSpec({ maxDocumentBytes: 200 }));

      rejected(await consumer.consume(signedRequest({ from: alice, to: box.vid })), 'malformedRequest');
    });
  });

  describe('the per-peer budget', () => {
    it('is spent once, for the proved and admitted sender, after the proof and before the claim', async () => {
      const order: string[] = [];
      const { consumer } = consumerFor(echoSpec(), {
        admit: async () => (order.push('admit'), true),
        resolver: {
          resolve: async (vid) => (order.push('resolve'), new SovereignKeriVidResolver().resolve(vid)),
        },
        throttle: async (issuer) => (order.push(`throttle:${issuer === alice.vid}`), { allowed: true }),
        guard: { claim: async () => (order.push('claim'), 'first' as const) },
      });

      accepted(await consumer.consume(signedRequest({ from: alice, to: box.vid })));

      expect(order).toEqual(['admit', 'resolve', 'throttle:true', 'claim']);
    });

    it('turns a document away as unavailable, with the wait — and does not burn its id', async () => {
      let allowed = false;
      const { consumer, store } = consumerFor(echoSpec(), {
        throttle: async () => (allowed ? { allowed: true } : { allowed: false, retryAfterMs: 7000 }),
      });
      const request = signedRequest({ from: alice, to: box.vid });

      const turnedAway = rejected(await consumer.consume(request), 'unavailable');

      expect(turnedAway).toMatchObject({ stage: 'authenticated', addressTo: alice.vid, retryAfterMs: 7000 });
      expect(store.claims.size).toBe(0);

      // The byte-identical retry is a first arrival, not an absorbed duplicate.
      allowed = true;
      expect(accepted(await consumer.consume(JSON.parse(JSON.stringify(request)))).duplicate).toBe(false);
    });

    it('fails closed when the budget cannot be consulted', async () => {
      const { consumer, store } = consumerFor(echoSpec(), {
        throttle: async () => {
          throw new Error('down');
        },
      });

      const result = rejected(
        await consumer.consume(signedRequest({ from: alice, to: box.vid })),
        'unavailable',
      );

      expect(result.stage).toBe('authenticated');
      expect(store.claims.size).toBe(0);
    });

    it('is never spent for a stranger or for a document refused earlier', async () => {
      let spent = 0;
      const throttle = async () => (spent++, { allowed: true as const });

      await consumerFor(echoSpec(), { throttle, admit: async () => false }).consumer.consume(
        signedRequest({ from: alice, to: box.vid }),
      );
      await consumerFor(echoSpec(), { throttle }).consumer.consume(
        signedRequest({ from: alice, to: newParty().vid }),
      );

      expect(spent).toBe(0);
    });

    it('is spent before the payload is parsed: a flood of invalid payloads from one peer is still throttled', async () => {
      let spent = 0;
      const { consumer } = consumerFor(echoSpec(), { throttle: async () => (spent++, { allowed: true }) });

      rejected(
        await consumer.consume(signedRequest({ from: alice, to: box.vid, payload: { message: 1 } })),
        'malformedRequest',
      );

      expect(spent).toBe(1);
    });
  });

  describe('opaque and identifier-like members', () => {
    it('refuses a control character in the document id — it becomes part of the duplicate-record key', async () => {
      const { consumer } = consumerFor();

      for (const control of [0, 1, 10, 127]) {
        const id = `urn:uuid:${String.fromCharCode(control)}x`;

        rejected(await consumer.consume(signedRequest({ from: alice, to: box.vid, id })), 'malformedRequest');
      }
    });

    it('accepts a thread identifier of any form (SPEC 4.9), whitespace included', async () => {
      const { consumer } = consumerFor();

      accepted(
        await consumer.consume(
          signedRequest({
            from: alice,
            to: box.vid,
            extra: { threadId: 'a thread with spaces', parentThreadId: 'an outer thread' },
          }),
        ),
      );
    });

    it('accepts an RFC 3339 leap second, placed on the instant it labels', async () => {
      const { consumer } = consumerFor();
      // 11:59:60Z is the leap second after 11:59:59Z, i.e. the same instant as 12:00:00Z.
      const request = sign(
        draft({ from: alice, to: box.vid, extra: { issuedAt: '2026-11-05T11:59:60Z' } }),
        alice,
      );

      accepted(await consumer.consume(request));
    });
  });

  describe('the payload — SPEC §7.2 item 2', () => {
    it('refuses a payload the closed schema does not describe, addressed to the admitted sender', async () => {
      const { consumer } = consumerFor();
      const request = signedRequest({ from: alice, to: box.vid, payload: { message: 'hi', extra: true } });

      const result = rejected(await consumer.consume(request), 'malformedRequest');

      expect(result.threadId).toBe(request.id);
      expect(result.inResponseTo).toEqual({ typeUri: ECHO_TYPE, id: request.id });
    });

    it('carries the request’s own threadId into the rejection when it has one', async () => {
      const { consumer } = consumerFor();
      const request = signedRequest({
        from: alice,
        to: box.vid,
        payload: { message: 1 },
        extra: { threadId: 'urn:uuid:thread-1' },
      });

      expect(rejected(await consumer.consume(request), 'malformedRequest').threadId).toBe(
        'urn:uuid:thread-1',
      );
    });
  });

  describe('duplicate execution — SPEC §7.2 item 11', () => {
    it('absorbs the identical document arriving again instead of treating it as new', async () => {
      const { consumer } = consumerFor();
      const request = signedRequest({ from: alice, to: box.vid });

      expect(accepted(await consumer.consume(request)).duplicate).toBe(false);
      expect(accepted(await consumer.consume(JSON.parse(JSON.stringify(request)))).duplicate).toBe(true);
    });

    it('refuses a DIFFERENT document under an id already accepted as idConflict', async () => {
      const { consumer } = consumerFor();
      const original = signedRequest({
        from: alice,
        to: box.vid,
        id: 'urn:uuid:fixed',
        payload: { message: 'one' },
      });
      const different = signedRequest({
        from: alice,
        to: box.vid,
        id: 'urn:uuid:fixed',
        payload: { message: 'two' },
      });

      accepted(await consumer.consume(original));
      rejected(await consumer.consume(different), 'idConflict');
    });

    it('treats a re-signed copy of identical content as a different document — the re-stamped retry', async () => {
      const { consumer } = consumerFor();
      const unsigned = draft({ from: alice, to: box.vid, id: 'urn:uuid:fixed' });

      accepted(await consumer.consume(sign(unsigned, alice, { created: '2026-11-05T12:00:00Z' })));
      rejected(
        await consumer.consume(sign(unsigned, alice, { created: '2026-11-05T12:00:01Z' })),
        'idConflict',
      );
    });

    it('does not burn the id of a document it refuses', async () => {
      const { consumer } = consumerFor();
      const bad = signedRequest({ from: alice, to: box.vid, id: 'urn:uuid:fixed', payload: { message: 1 } });
      const good = signedRequest({
        from: alice,
        to: box.vid,
        id: 'urn:uuid:fixed',
        payload: { message: 'ok' },
      });

      rejected(await consumer.consume(bad), 'malformedRequest');
      expect(accepted(await consumer.consume(good)).duplicate).toBe(false);
    });

    it('fails closed, as unavailable, when the record cannot be consulted', async () => {
      const { consumer } = consumerFor(echoSpec(), {
        guard: {
          claim: async () => {
            throw new Error('down');
          },
        },
      });

      const result = rejected(
        await consumer.consume(signedRequest({ from: alice, to: box.vid })),
        'unavailable',
      );

      expect(result.stage).toBe('authenticated');
    });

    it('keeps the record for the acceptance window plus its skew, and no longer', async () => {
      const { consumer, store } = consumerFor();

      accepted(await consumer.consume(signedRequest({ from: alice, to: box.vid })));

      // issued at T0, max age 300 s, skew 30 s, +1 s slack.
      for (const expiry of store.claims.values()) {
        expect(expiry).toBe(T0 + 300_000 + 30_000 + 1000);
      }
    });

    it('does not apply the guard to a specification that is not consequential, or is declared safe to repeat', async () => {
      const readOnly = echoSpec({ sideEffects: { level: 'none', rationale: 'read' } });
      const repeatable = echoSpec({ repeatSafe: true });

      for (const spec of [readOnly, repeatable]) {
        const { consumer, store } = consumerFor(spec);
        const request = signedRequest({ from: alice, to: box.vid });

        expect(accepted(await consumer.consume(request)).duplicate).toBe(false);
        expect(accepted(await consumer.consume(request)).duplicate).toBe(false);
        expect(store.claims.size).toBe(0);
      }
    });
  });

  it('never puts the reason on anything but the rejection’s internal field', async () => {
    const { consumer } = consumerFor();
    const result = await consumer.consume(signedRequest({ from: alice, to: newParty().vid }));

    expect(Object.keys(result).sort()).toEqual([
      'addressTo',
      'code',
      'inResponseTo',
      'kind',
      'reason',
      'stage',
      'threadId',
    ]);
  });
});
