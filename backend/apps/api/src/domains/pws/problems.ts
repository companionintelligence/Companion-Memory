/**
 * Error responses: RFC 9457 problem details, with the `type` URIs of the PWS Error Type Registry
 * (https://w3c-ccg.github.io/portable-web-spaces-spec/#error-type-registry).
 *
 * Two rules from the specification shape everything that raises one of these:
 *
 *   - Maximum privacy. A request that lacks privilege for an *existing* target gets the same
 *     `not-found` as a request for an absent one. `notFound()` is the only constructor for it and
 *     it takes no argument, so a call site cannot leak which of the two it was.
 *   - Request and credential validation failures describe the request, not the target, and may
 *     be precise (`invalid-authorization-header`, `invalid-request-body`, ...). They must still be
 *     raised only after the caller has been authorized wherever the specification says so.
 */

export const PWS_NAMESPACE = 'https://w3id.org/pws#';

/** Registered kinds and their typical status code (Error Type Registry). */
export const ERROR_STATUS = {
  'not-found': 404,
  // Not in the v0.5 registry: named only to the holder of the capability and its invoking key (see `zcap.ts`).
  'capability-expired': 404,
  'invalid-id': 400,
  'reserved-id': 409,
  'id-conflict': 409,
  'invalid-request-body': 400,
  'invalid-cursor': 400,
  'missing-content-type': 400,
  'missing-authorization': 401,
  'invalid-authorization-header': 400,
  'controller-mismatch': 400,
  'unsupported-backend': 409,
  'encryption-immutable': 409,
  'encryption-history-log-governed': 409,
  'encryption-scheme-mismatch': 422,
  'unsupported-encryption-scheme': 400,
  'precondition-failed': 412,
  'quota-exceeded': 507,
  'payload-too-large': 413,
  'unsupported-operation': 501,
  'invalid-import': 400,
  'storage-error': 500,
  'internal-error': 500,
} as const;

export type ErrorKind = keyof typeof ERROR_STATUS;

const TITLES: Record<ErrorKind, string> = {
  'not-found': 'Not found',
  'capability-expired': 'Capability expired',
  'invalid-id': 'Invalid identifier',
  'reserved-id': 'Reserved identifier',
  'id-conflict': 'Identifier already in use',
  'invalid-request-body': 'Invalid request body',
  'invalid-cursor': 'Invalid pagination cursor',
  'missing-content-type': 'Missing Content-Type',
  'missing-authorization': 'Missing authorization',
  'invalid-authorization-header': 'Invalid authorization header',
  'controller-mismatch': 'Controller mismatch',
  'unsupported-backend': 'Unsupported backend',
  'encryption-immutable': 'Encryption descriptor is immutable',
  'encryption-history-log-governed': 'Encryption descriptor is governed by its history log',
  'encryption-scheme-mismatch': 'Encryption scheme mismatch',
  'unsupported-encryption-scheme': 'Unsupported encryption scheme',
  'precondition-failed': 'Precondition failed',
  'quota-exceeded': 'Quota exceeded',
  'payload-too-large': 'Payload too large',
  'unsupported-operation': 'Unsupported operation',
  'invalid-import': 'Invalid import',
  'storage-error': 'Storage error',
  'internal-error': 'Internal error',
};

export interface ProblemDetail {
  detail: string;
  pointer?: string;
}

export interface PwsErrorOptions {
  /** Overrides the registry's typical status (a kind "MAY be returned with more than one"). */
  status?: number;
  errors?: ProblemDetail[];
  /** Extra response headers (e.g. `Allow` on a 405). */
  headers?: Record<string, string>;
}

/** A failure that maps to one problem response. Thrown by operations, rendered by the handler. */
export class PwsError extends Error {
  readonly status: number;

  readonly errors: ProblemDetail[] | undefined;

  readonly headers: Record<string, string>;

  constructor(
    readonly kind: ErrorKind,
    readonly detail: string,
    options: PwsErrorOptions = {},
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'PwsError';
    this.status = options.status ?? ERROR_STATUS[kind];
    this.errors = options.errors;
    this.headers = options.headers ?? {};
  }

  get type(): string {
    return `${PWS_NAMESPACE}${this.kind}`;
  }

  /** The RFC 9457 body. */
  toProblem(): Record<string, unknown> {
    return {
      type: this.type,
      title: TITLES[this.kind],
      status: this.status,
      detail: this.detail,
      ...(this.errors ? { errors: this.errors } : {}),
    };
  }
}

/**
 * The merged "absent or not authorized" error. No parameters on purpose: the detail is fixed so
 * the two causes are byte-identical on the wire.
 */
export function notFound(): PwsError {
  return new PwsError('not-found', 'The requested resource was not found.');
}

export function invalidBody(detail: string, pointer?: string): PwsError {
  return new PwsError('invalid-request-body', detail, {
    errors: [{ detail, ...(pointer ? { pointer } : {}) }],
  });
}

/**
 * `405 Method Not Allowed` for a method a reserved endpoint does not implement. It has no entry
 * in the registry: its meaning is the status alone and the body uses RFC 9457's `about:blank`.
 */
export function methodNotAllowed(allow: readonly string[]): {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    status: 405,
    headers: { allow: allow.join(', ') },
    body: { type: 'about:blank', title: 'Method Not Allowed', status: 405 },
  };
}
