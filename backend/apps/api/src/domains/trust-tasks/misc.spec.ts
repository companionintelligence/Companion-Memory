import { generateKeyPairSync } from 'node:crypto';

import { ECHO_TYPE, T0, echoSpec, memoryClaimStore, newParty, signedRequest } from './__tests__/testKit';
import {
  askRequestPayloadSchema,
  askResponsePayloadSchema,
  askCollectPayloadSchema,
  ASK_REQUEST_TYPE_URI,
  ASK_SPECS,
} from './askSpecs';
import { signerFromJwk } from './boxSigner';
import { verifyEddsaJcs2022Proof } from './crypto/dataIntegrity';
import { DISCOVERY_SPECS, discoveryResponsePayload, matchesPattern, supportedTypesFor } from './discovery';
import { parseRfc3339, validateStructure } from './document';
import { StoreDuplicateGuard } from './duplicateGuard';
import {
  MAX_DETAILS_BYTES,
  MAX_DETAILS_MEMBERS,
  STANDARD_ERROR_CODES,
  boundDetails,
  errorPayload,
  httpStatusFor,
} from './errors';
import {
  buildDocument,
  buildErrorResponse,
  buildSuccessResponse,
  isoSeconds,
  newDocumentId,
  signDocument,
} from './producer';
import { SpecRegistry, isConsequential } from './specs';
import { parseTypeUri } from './typeUri';

describe('parseRfc3339 / validateStructure', () => {
  it('reads RFC 3339 instants, with offsets and fractions', () => {
    expect(parseRfc3339('2026-11-05T12:00:00Z')).toBe(T0);
    expect(parseRfc3339('2026-11-05T12:00:00.250Z')).toBe(T0 + 250);
    expect(parseRfc3339('2026-11-05T04:00:00-08:00')).toBe(T0);
    expect(parseRfc3339('2026-11-05t12:00:00z')).toBe(T0);
  });

  it('refuses what is not a calendar instant', () => {
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-11-05T24:00:00Z',
      '2026-11-05T12:60:00Z',
      '2026-11-05T12:00:61Z',
      '2026-11-05',
      '2026-11-05T12:00:00',
      '2026-11-05T12:00:00+24:00',
      'x',
      3,
      null,
      '2026-11-05T12:00:00Z'.repeat(5),
    ]) {
      expect(parseRfc3339(bad)).toBeNull();
    }

    expect(parseRfc3339('2028-02-29T00:00:00Z')).not.toBeNull();
    expect(parseRfc3339('2027-02-29T00:00:00Z')).toBeNull();
  });

  it('reads an RFC 3339 leap second as the instant it labels — one second after :59 — and no later', () => {
    // 23:59:60Z is the leap second that follows 23:59:59Z; ECMAScript has no such second, so it is placed.
    expect(parseRfc3339('2026-12-31T23:59:60Z')).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
    expect(parseRfc3339('2026-11-05T12:00:60Z')).toBe(
      (parseRfc3339('2026-11-05T12:00:59Z') as number) + 1000,
    );
    expect(parseRfc3339('2026-12-31T23:59:60.5Z')).toBe(Date.UTC(2027, 0, 1, 0, 0, 0) + 500);
    expect(parseRfc3339('2026-12-31T15:59:60-08:00')).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
    expect(parseRfc3339('2026-12-31T23:59:61Z')).toBeNull();
  });

  it('returns the very object it was given, so a proof is verified over the document as received', () => {
    const received = { id: 'a', type: 't', payload: {}, 'x-experimental': true, unknown: [1] };
    const result = validateStructure(received);

    expect(result.ok && result.document).toBe(received);
  });
});

describe('error payloads (SPEC §8)', () => {
  it('has every standard code a message, a status and a retryable default', () => {
    for (const code of STANDARD_ERROR_CODES) {
      const payload = errorPayload({ code });

      expect(typeof payload.message).toBe('string');
      expect(typeof payload.retryable).toBe('boolean');
      expect(httpStatusFor(code)).toBeGreaterThanOrEqual(400);
    }

    expect(STANDARD_ERROR_CODES).toHaveLength(16);
  });

  it('maps statuses as the HTTPS binding does', () => {
    expect(httpStatusFor('malformedRequest')).toBe(400);
    expect(httpStatusFor('permissionDenied')).toBe(403);
    expect(httpStatusFor('idConflict')).toBe(409);
    expect(httpStatusFor('proofInvalid')).toBe(422);
    expect(httpStatusFor('unavailable')).toBe(503);
    expect(httpStatusFor('indeterminate')).toBe(503);
    expect(httpStatusFor('internalError')).toBe(500);
  });

  it('retries only what can succeed on retry, and drops retryAfter otherwise', () => {
    expect(errorPayload({ code: 'unavailable', retryAfter: '2026-11-05T12:05:00Z' })).toMatchObject({
      retryable: true,
      retryAfter: '2026-11-05T12:05:00Z',
    });
    expect(errorPayload({ code: 'expired', retryAfter: '2026-11-05T12:05:00Z' })).not.toHaveProperty(
      'retryAfter',
    );
  });

  it('omits an empty inResponseTo and keeps a partial one', () => {
    expect(errorPayload({ code: 'expired', inResponseTo: {} })).not.toHaveProperty('inResponseTo');
    expect(
      errorPayload({ code: 'expired', inResponseTo: { typeUri: 'https://x/spec/a/0.1' } }).inResponseTo,
    ).toEqual({ typeUri: 'https://x/spec/a/0.1' });
  });

  it('bounds details at 16 members and 4096 canonical bytes, dropping rather than truncating', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_DETAILS_MEMBERS + 1 }, (_, i) => [`k${i}`, i]));
    const big = { blob: 'x'.repeat(MAX_DETAILS_BYTES) };

    expect(boundDetails(many)).toBeUndefined();
    expect(boundDetails(big)).toBeUndefined();
    expect(boundDetails({ ok: 1 })).toEqual({ ok: 1 });
    expect(boundDetails({ n: Number.NaN })).toBeUndefined();
    expect(errorPayload({ code: 'taskFailed', details: big })).not.toHaveProperty('details');
  });

  it('never repeats caller-controlled text in the message', () => {
    expect(
      JSON.stringify(
        errorPayload({ code: 'identityMismatch', inResponseTo: { typeUri: 't', id: 'did:evil' } }).message,
      ),
    ).not.toContain('did:evil');
  });
});

describe('discovery', () => {
  const specs = [...DISCOVERY_SPECS, ...ASK_SPECS];

  it('matches slug globs the way SPEC §10.2 defines them, and nothing else', () => {
    expect(matchesPattern('acl/grant', '*')).toBe(true);
    expect(matchesPattern('acl/grant', 'acl/*')).toBe(true);
    expect(matchesPattern('acl/grant/sub', 'acl/*')).toBe(true);
    expect(matchesPattern('acl', 'acl/*')).toBe(false);
    expect(matchesPattern('aclx/grant', 'acl/*')).toBe(false);
    expect(matchesPattern('acl/grant', 'acl/grant')).toBe(true);
    expect(matchesPattern('acl/grant', 'acl/gr*')).toBe(false);
    expect(matchesPattern('acl/grant', '**')).toBe(false);
  });

  it('treats absent and empty patterns as "*", ORs patterns, and sorts', () => {
    const all = supportedTypesFor(specs, undefined);

    expect(supportedTypesFor(specs, [])).toEqual(all);
    expect(all).toEqual([...all].sort());
    // One Asks specification, and every version of discovery this box serves (0.1–0.4).
    expect(supportedTypesFor(specs, ['ask/request', 'trust-task-discovery'])).toEqual([
      'https://ci.computer/trust-tasks/spec/ask/request/0.1',
      'https://trusttasks.org/spec/trust-task-discovery/0.1',
      'https://trusttasks.org/spec/trust-task-discovery/0.2',
      'https://trusttasks.org/spec/trust-task-discovery/0.3',
      'https://trusttasks.org/spec/trust-task-discovery/0.4',
    ]);
    expect(supportedTypesFor(specs, ['nothing/*'])).toEqual([]);
  });

  it('states a window only in 0.4, whose schema admits it', () => {
    const window = { maxAgeSeconds: 300, clockSkewSeconds: 30 };

    expect(discoveryResponsePayload({ version: '0.4', specs, patterns: undefined, window })).toHaveProperty(
      'acceptanceWindow',
      window,
    );
    expect(
      discoveryResponsePayload({ version: '0.2', specs, patterns: undefined, window }),
    ).not.toHaveProperty('acceptanceWindow');
  });

  it('builds responses its own response schema accepts', () => {
    const window = { maxAgeSeconds: 300, clockSkewSeconds: 30 };

    for (const spec of DISCOVERY_SPECS) {
      const payload = discoveryResponsePayload({
        version: spec.version as '0.2' | '0.4',
        specs,
        patterns: ['*'],
        window,
      });

      expect(spec.response?.safeParse(payload).success).toBe(true);
    }
  });
});

describe('the specification registry', () => {
  it('finds by exact URI, and tells an unknown type from an unknown version', () => {
    const registry = new SpecRegistry().register(echoSpec());
    const parse = (uri: string) => {
      const parsed = parseTypeUri(uri);
      if (!parsed.ok) {
        throw new Error(uri);
      }

      return parsed.value;
    };

    expect(registry.find(parse(ECHO_TYPE))).toMatchObject({ found: { slug: 'test/echo' } });
    expect(registry.find(parse(`${ECHO_TYPE}#request`))).toMatchObject({ found: { slug: 'test/echo' } });
    expect(registry.find(parse('https://example.com/trust-tasks/spec/test/echo/0.2'))).toEqual({
      missing: 'unsupportedVersion',
    });
    expect(registry.find(parse('https://example.com/trust-tasks/spec/test/other/0.1'))).toEqual({
      missing: 'unsupportedType',
    });
    // The same slug under another authority is a different specification.
    expect(registry.find(parse('https://other.example/spec/test/echo/0.1'))).toEqual({
      missing: 'unsupportedType',
    });
  });

  it('refuses to register one specification twice', () => {
    expect(() => new SpecRegistry().register(echoSpec()).register(echoSpec())).toThrow(/registered twice/);
  });

  it('classifies consequence the way SPEC §3 defines it', () => {
    const none = { level: 'none' as const, rationale: 'r' };
    const quiet = {
      discloses: 'none' as const,
      ingests: 'none' as const,
      actsAsSubject: false,
      rationale: 'r',
    };

    expect(isConsequential(echoSpec({ sideEffects: none, exposure: quiet }))).toBe(false);
    expect(
      isConsequential(echoSpec({ sideEffects: { level: 'mutating', rationale: 'r' }, exposure: quiet })),
    ).toBe(true);
    expect(
      isConsequential(echoSpec({ sideEffects: none, exposure: { ...quiet, discloses: 'secret' } })),
    ).toBe(true);
    expect(
      isConsequential(echoSpec({ sideEffects: none, exposure: { ...quiet, discloses: 'metadata' } })),
    ).toBe(false);
    expect(
      isConsequential(echoSpec({ sideEffects: none, exposure: { ...quiet, actsAsSubject: true } })),
    ).toBe(true);
  });
});

describe('StoreDuplicateGuard', () => {
  const claim = (guard: StoreDuplicateGuard, id: string, digest: string, now = 1000) =>
    guard.claim({ id, digest, now, expiresAtMs: now + 60_000 });

  it('reports first, duplicate and conflict', async () => {
    const guard = new StoreDuplicateGuard(memoryClaimStore());

    expect(await claim(guard, 'a', 'd1')).toBe('first');
    expect(await claim(guard, 'a', 'd1')).toBe('duplicate');
    expect(await claim(guard, 'a', 'd2')).toBe('conflict');
    expect(await claim(guard, 'b', 'd1')).toBe('first');
  });

  it('never reports two concurrent arrivals of the same bytes as a conflict', async () => {
    const guard = new StoreDuplicateGuard(memoryClaimStore());

    const outcomes = await Promise.all([
      claim(guard, 'a', 'd1'),
      claim(guard, 'a', 'd1'),
      claim(guard, 'a', 'd1'),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'first')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'conflict')).toHaveLength(0);
  });

  it('lets an id be used again once the record has expired', async () => {
    const guard = new StoreDuplicateGuard(memoryClaimStore());

    expect(await claim(guard, 'a', 'd1', 1000)).toBe('first');
    expect(await claim(guard, 'a', 'd2', 62_000)).toBe('first');
  });

  it('reads a store that fails closed (returns false) as a duplicate: nothing executes', async () => {
    const guard = new StoreDuplicateGuard({ claimOnce: async () => false });

    expect(await claim(guard, 'a', 'd1')).toBe('duplicate');
  });
});

describe('producing documents (SPEC §7.1, §13.1)', () => {
  const box = newParty();
  const peer = newParty();

  it('mints unguessable, never-reused identifiers', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newDocumentId()));

    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('rounds timestamps down to the second', () => {
    expect(isoSeconds(T0 + 999)).toBe('2026-11-05T12:00:00Z');
  });

  it('answers on the request’s thread, with a fresh id, from the box to the peer, signed for authentication', () => {
    const request = {
      id: 'urn:uuid:req',
      type: `${ECHO_TYPE}#request`,
      payload: {},
      threadId: 'urn:uuid:thread',
    };
    const response = buildSuccessResponse({
      request,
      payload: { echoed: 'hi' },
      signer: box,
      recipient: peer.vid,
      now: T0,
    });

    expect(response).toMatchObject({
      type: `${ECHO_TYPE}#response`,
      issuer: box.vid,
      recipient: peer.vid,
      threadId: 'urn:uuid:thread',
      issuedAt: '2026-11-05T12:00:00Z',
    });
    expect(response.id).not.toBe(request.id);
    expect(response.proof).toMatchObject({ proofPurpose: 'authentication', created: '2026-11-05T12:00:00Z' });
    expect(verifyEddsaJcs2022Proof(response, box.publicKey)).toBe(true);
  });

  it('uses the request’s id as the thread when the request opened one', () => {
    const response = buildSuccessResponse({
      request: { id: 'urn:uuid:req', type: ECHO_TYPE, payload: {} },
      payload: {},
      signer: box,
      recipient: peer.vid,
      now: T0,
    });

    expect(response.threadId).toBe('urn:uuid:req');
  });

  it('gives an error about a document too malformed to have an id a thread that joins to nothing', () => {
    const one = buildErrorResponse({
      signer: box,
      recipient: peer.vid,
      payload: { code: 'malformedRequest' },
      now: T0,
    });
    const two = buildErrorResponse({
      signer: box,
      recipient: peer.vid,
      payload: { code: 'malformedRequest' },
      now: T0,
    });

    expect(one.threadId).toMatch(/^urn:uuid:/);
    expect(one.threadId).not.toBe(two.threadId);
  });

  it('signs a built document so that it verifies and a changed one does not', () => {
    const signed = signDocument(
      buildDocument({
        type: ECHO_TYPE,
        issuer: box.vid,
        recipient: peer.vid,
        payload: { message: 'x' },
        now: T0,
      }),
      box,
      T0,
    );

    expect(verifyEddsaJcs2022Proof(signed, box.publicKey)).toBe(true);
    expect(verifyEddsaJcs2022Proof({ ...signed, payload: { message: 'y' } }, box.publicKey)).toBe(false);
  });
});

describe('signerFromJwk', () => {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.privateKey.export({ format: 'jwk' });

  it('accepts a private JWK as an object or a JSON string and derives a self-certifying VID', () => {
    const fromObject = signerFromJwk(jwk);
    const fromString = signerFromJwk(JSON.stringify(jwk));

    expect(fromObject?.vid).toBe(`did:keri:D${jwk.x}`);
    expect(fromString?.vid).toBe(fromObject?.vid);
    expect(fromObject?.verificationMethod).toBe(`did:keri:D${jwk.x}#D${jwk.x}`);
  });

  it('refuses anything it cannot sign with — without throwing', () => {
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    const bad: unknown[] = [
      undefined,
      null,
      '',
      '   ',
      '{',
      42,
      {},
      { ...jwk, kty: 'RSA' },
      { ...jwk, crv: 'Ed448' },
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      { ...jwk, d: undefined },
      { ...jwk, x: other.x },
      { ...jwk, x: 'AAAA' },
    ];

    for (const candidate of bad) {
      expect(signerFromJwk(candidate)).toBeNull();
    }
  });
});

describe('the Companion Asks specifications', () => {
  const ask = {
    askId: 'ask-2026-11-05-0001',
    askerHandle: 'alice',
    prompt: 'Free Friday?',
    request: { archetype: 'availability', from: '2026-11-06T11:00:00Z', to: '2026-11-06T14:00:00Z' },
  };

  it('are private specifications, named under an authority that is not the registry', () => {
    for (const spec of ASK_SPECS) {
      const parsed = parseTypeUri(spec.typeUri);

      expect(parsed).toMatchObject({ ok: true, value: { registry: false, reserved: false } });
    }
  });

  it('declare what SPEC §7.3 says a consequential task must: proof, recipient, issuedAt', () => {
    for (const spec of ASK_SPECS.filter(isConsequential)) {
      expect(spec.proof).toEqual({ request: 'REQUIRED', response: 'REQUIRED' });
      expect(spec.parties.recipient).toBe('REQUIRED');
      expect(spec.issuedAt).toBe('REQUIRED');
      expect(spec.bearer).toBe(false);
    }

    expect(ASK_SPECS.map((spec) => [spec.slug, isConsequential(spec), spec.repeatSafe])).toEqual([
      ['ask/request', true, false],
      // A read, but of a thing that must not leave the box twice: see `repeatSafe` in `askSpecs.ts`.
      ['ask/collect', true, false],
    ]);
  });

  it('close the request payload at every level', () => {
    expect(askRequestPayloadSchema.safeParse(ask).success).toBe(true);
    expect(askRequestPayloadSchema.safeParse({ ...ask, extra: 1 }).success).toBe(false);
    expect(askRequestPayloadSchema.safeParse({ ...ask, request: { ...ask.request, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      askRequestPayloadSchema.safeParse({ ...ask, actor: { kind: 'person', label: 'A', extra: 1 } }).success,
    ).toBe(false);
    expect(askRequestPayloadSchema.safeParse({ ...ask, actor: { kind: 'person' } }).success).toBe(true);
    expect(
      askRequestPayloadSchema.safeParse({ ...ask, request: { archetype: 'sql', subject: 'x' } }).success,
    ).toBe(false);
    expect(askRequestPayloadSchema.safeParse({ ...ask, askId: 'short' }).success).toBe(false);
  });

  it('state a bound for every free-text member, and it is the bound the schema enforces', () => {
    const request = ASK_SPECS.find((spec) => spec.slug === 'ask/request');
    const base = { askId: 'ask-2026-11-05-0001', askerHandle: 'a', prompt: 'p' };
    const relationship = { archetype: 'relationship', subject: 's' };
    const withText: Record<string, (text: string) => unknown> = {
      askerHandle: (text) => ({ ...base, askerHandle: text, request: relationship }),
      prompt: (text) => ({ ...base, prompt: text, request: relationship }),
      purpose: (text) => ({ ...base, purpose: text, request: relationship }),
      'actor.label': (text) => ({ ...base, actor: { kind: 'person', label: text }, request: relationship }),
      'request.subject': (text) => ({ ...base, request: { archetype: 'content', subject: text } }),
      'request.identifiers': (text) => ({ ...base, request: { ...relationship, identifiers: [text] } }),
      'request.dataClass': (text) => ({
        ...base,
        request: { archetype: 'content', subject: 's', dataClass: text },
      }),
      'request.purpose': (text) => ({
        ...base,
        request: { archetype: 'availability', from: ask.request.from, to: ask.request.to, purpose: text },
      }),
    };

    // A member added to the contract without a stated bound — or the reverse — fails here.
    expect((request?.freeText ?? []).map((entry) => entry.member).sort()).toEqual(
      Object.keys(withText).sort(),
    );
    for (const entry of request?.freeText ?? []) {
      const build = withText[entry.member] as (text: string) => unknown;

      expect(askRequestPayloadSchema.safeParse(build('x'.repeat(entry.maxLength))).success).toBe(true);
      expect(askRequestPayloadSchema.safeParse(build('x'.repeat(entry.maxLength + 1))).success).toBe(false);
    }
  });

  it('fit the largest legitimate request inside the document bound, even written entirely as six-byte escapes', () => {
    const request = ASK_SPECS.find((spec) => spec.slug === 'ask/request');
    // U+0001 is written as `\u0001` by JSON.stringify: six bytes for each of the characters the schema counts.
    const text = (length: number) => String.fromCharCode(1).repeat(length);
    const payload = {
      actor: { kind: 'third-party-agent', label: text(80) },
      askId: 'x'.repeat(64),
      askerHandle: text(120),
      prompt: text(500),
      purpose: text(200),
      request: {
        archetype: 'relationship',
        subject: text(200),
        identifiers: [text(200), text(200), text(200), text(200), text(200)],
      },
    };
    expect(askRequestPayloadSchema.safeParse(payload).success).toBe(true);

    const document = signedRequest({
      from: newParty(),
      to: newParty().vid,
      type: ASK_REQUEST_TYPE_URI,
      payload,
      at: T0,
    });
    const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');

    expect(bytes).toBeGreaterThan(12_000);
    expect(bytes).toBeLessThanOrEqual(request?.maxDocumentBytes ?? 0);
  });

  it('say what a performed task achieves and bound every document', () => {
    for (const spec of [...ASK_SPECS, ...DISCOVERY_SPECS]) {
      expect(spec.outcome.length).toBeGreaterThan(20);
      expect(spec.maxDocumentBytes).toBeGreaterThanOrEqual(4096);
      expect(Array.isArray(spec.freeText)).toBe(true);
    }
  });

  it('bound the collect payload exactly as the poll route bounds its path segment', () => {
    expect(askCollectPayloadSchema.safeParse({ askId: 'ask-2026-11-05-0001' }).success).toBe(true);
    expect(askCollectPayloadSchema.safeParse({ askId: 'ask/../x-0001' }).success).toBe(false);
    expect(askCollectPayloadSchema.safeParse({ askId: 'ask-2026-11-05-0001', more: 1 }).success).toBe(false);
  });

  it('have a response with no vocabulary for a refusal — ADR-0001', () => {
    const base = { askId: 'ask-2026-11-05-0001' };

    expect(
      askResponsePayloadSchema.safeParse({ ...base, status: 'pending', reason: 'No answer is available' })
        .success,
    ).toBe(true);
    expect(
      askResponsePayloadSchema.safeParse({
        ...base,
        status: 'answered',
        answer: { form: 'boolean', summary: 'Yes.' },
      }).success,
    ).toBe(true);

    for (const status of ['declined', 'pending_review', 'denied', 'expired', 'delivered']) {
      expect(askResponsePayloadSchema.safeParse({ ...base, status }).success).toBe(false);
    }

    expect(askResponsePayloadSchema.safeParse({ ...base, status: 'pending', grantId: 'g1' }).success).toBe(
      false,
    );
  });
});
