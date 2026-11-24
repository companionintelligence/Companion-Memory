/**
 * Every failure this domain raises is a {@link DidcommError} with a stable `code`.
 *
 * Messages are written for logs. They never contain key material, plaintext bodies or whole
 * envelopes, and they name the check that failed, not the secret that would have passed it. A
 * receiver that reports a failure to a remote party should send {@link problemCodeFor}, not the
 * message: DIDComm problem reports carry fixed, statically associated text on purpose.
 */
export type DidcommErrorCode =
  | 'invalid-argument'
  | 'malformed-message'
  | 'malformed-envelope'
  | 'too-large'
  | 'unsupported-algorithm'
  | 'unsupported-did-method'
  | 'did-resolution-failed'
  | 'did-document-invalid'
  | 'invalid-key'
  | 'key-not-found'
  | 'secret-not-found'
  | 'decryption-failed'
  | 'signature-invalid'
  | 'not-authorized'
  | 'inconsistent-layers'
  | 'policy-violation'
  | 'expired'
  | 'replayed'
  | 'routing-failed';

export class DidcommError extends Error {
  readonly code: DidcommErrorCode;

  constructor(code: DidcommErrorCode, message: string) {
    super(message);
    this.name = 'DidcommError';
    this.code = code;
  }
}

/**
 * The DIDComm problem code (`e.<scope>.<descriptors>`, DIDComm Messaging v2.1 "Problem Codes") for a
 * failure. Scope `m` says the one message is rejected and nothing else is undone.
 *
 * Deliberately coarse. A receiver that said *which* check failed (wrong key, bad tag, unknown
 * sender) would hand an attacker an oracle; every cryptographic failure maps to the same code.
 */
export function problemCodeFor(error: unknown): string {
  if (!(error instanceof DidcommError)) {
    return 'e.m.me';
  }

  switch (error.code) {
    case 'decryption-failed':
    case 'signature-invalid':
    case 'invalid-key':
    case 'unsupported-algorithm':
    case 'inconsistent-layers':
      return 'e.m.trust.crypto';
    case 'not-authorized':
    case 'policy-violation':
    case 'replayed':
      return 'e.m.trust';
    case 'expired':
      return 'e.m.req.time';
    case 'too-large':
      return 'e.m.me.res.storage.message_too_big';
    case 'unsupported-did-method':
    case 'did-resolution-failed':
    case 'did-document-invalid':
    case 'key-not-found':
      return 'e.m.did';
    case 'routing-failed':
      return 'e.m.xfer';
    case 'secret-not-found':
      // The message was fine; this agent holds no key it names.
      return 'e.m.trust.crypto';
    case 'invalid-argument':
      return 'e.m.me';
    case 'malformed-message':
    case 'malformed-envelope':
      return 'e.m.msg';
  }
}
