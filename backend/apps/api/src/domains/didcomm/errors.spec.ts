import { DidcommError, type DidcommErrorCode, problemCodeFor } from './errors';

describe('DidcommError', () => {
  it('carries a stable code and a name', () => {
    const error = new DidcommError('expired', 'message has expired');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DidcommError');
    expect(error.code).toBe('expired');
  });
});

describe('problemCodeFor', () => {
  const expected: Record<DidcommErrorCode, string> = {
    'invalid-argument': 'e.m.me',
    'malformed-message': 'e.m.msg',
    'malformed-envelope': 'e.m.msg',
    'too-large': 'e.m.me.res.storage.message_too_big',
    'unsupported-algorithm': 'e.m.trust.crypto',
    'unsupported-did-method': 'e.m.did',
    'did-resolution-failed': 'e.m.did',
    'did-document-invalid': 'e.m.did',
    'invalid-key': 'e.m.trust.crypto',
    'key-not-found': 'e.m.did',
    'secret-not-found': 'e.m.trust.crypto',
    'decryption-failed': 'e.m.trust.crypto',
    'signature-invalid': 'e.m.trust.crypto',
    'not-authorized': 'e.m.trust',
    'inconsistent-layers': 'e.m.trust.crypto',
    'policy-violation': 'e.m.trust',
    expired: 'e.m.req.time',
    replayed: 'e.m.trust',
    'routing-failed': 'e.m.xfer',
  };

  it.each(Object.entries(expected))('maps %s to %s', (code, problem) => {
    expect(problemCodeFor(new DidcommError(code as DidcommErrorCode, 'x'))).toBe(problem);
  });

  it('treats a foreign error as an internal one and never echoes its text', () => {
    expect(problemCodeFor(new Error('secret detail'))).toBe('e.m.me');
    expect(problemCodeFor('nope')).toBe('e.m.me');
  });

  it('gives every cryptographic failure the same code, so the code is not an oracle', () => {
    const codes = ['decryption-failed', 'signature-invalid', 'invalid-key'] as const;

    expect(new Set(codes.map((code) => problemCodeFor(new DidcommError(code, 'x')))).size).toBe(1);
  });

  it('only emits codes in the sorter.scope.descriptor grammar', () => {
    for (const problem of Object.values(expected)) {
      expect(problem).toMatch(/^e\.(p|m)(\.[a-z][a-z_-]*)*$/);
    }
  });
});
