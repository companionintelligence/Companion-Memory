import { canonicalizeBody, verifyConnectRequest } from '../connect-request-auth';

/**
 * canonicalizeBody must produce byte-identical output to the CI-Hub signer for
 * the same logical body, and — critically — must match what the verifier sees:
 * a JSON-reparsed wire body, which never has shared object references.
 */
describe('canonicalizeBody', () => {
  it('sorts keys recursively so key insertion order does not change the hash input', () => {
    expect(canonicalizeBody({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalizeBody({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('serializes a shared (non-circular) sub-object on every branch, matching a re-parsed wire body', () => {
    const shared = { x: 1 };
    const dag = { a: shared, b: shared };

    // The verifier re-parses the JSON body (JSON.parse yields no shared refs), so
    // an add-only cycle guard that nulled the second occurrence would diverge.
    expect(canonicalizeBody(dag)).toBe(canonicalizeBody(JSON.parse(JSON.stringify(dag))));
    expect(canonicalizeBody(dag)).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('breaks a genuine cycle instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    expect(() => canonicalizeBody(cyclic)).not.toThrow();
    expect(canonicalizeBody(cyclic)).toContain('"self":null');
  });

  it('throws (bounded) on a pathologically deep body rather than overflowing the stack', () => {
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      deep = { nested: deep };
    }

    expect(() => canonicalizeBody(deep)).toThrow(/depth/i);
  });
});

/**
 * The body is canonicalized pre-auth (its hash is part of the signed message),
 * so a hostile deeply-nested body must reject cleanly, not surface as a 500.
 */
describe('verifyConnectRequest deep-body handling', () => {
  it('returns bad_body (not a thrown error) for an over-deep body', () => {
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      deep = { nested: deep };
    }

    const result = verifyConnectRequest('secret', {
      method: 'POST',
      path: '/connect/exchange',
      timestamp: String(Date.now()),
      nonce: 'a-nonce',
      signature: 'deadbeef',
      body: deep,
    });

    expect(result).toEqual({ ok: false, reason: 'bad_body' });
  });
});
