import { canonicalize } from './crypto/jcs';
import type { JsonObject } from './document';
import { registryTypeUri } from './typeUri';

/**
 * Error responses — SPEC §8 and the registry's `trust-task-error` specification.
 *
 * An error response is itself a Trust Task document, so one validation, signing and transport pipeline
 * serves a refusal as it serves a result. This file holds only what is PURE about one: the code table,
 * the payload, the bounds, and the HTTP status the HTTPS binding maps each code to. Deciding WHEN to
 * answer with one, and to whom, is the binding's job (see `TrustTasksService`).
 *
 * ═══ THE MESSAGE IS DERIVED FROM THE CODE, AND FROM NOTHING ELSE ═══
 *
 * SPEC §8.2.1: an error response goes to a party this box has just failed to validate, usually before
 * any authorization decision, and whoever receives it can keep it. So `message` is looked up from the
 * code and never composed from the request, the resolver, the key store or the link table — no
 * internal identifier, no contested identity, no verifier text. A sender that could vary one member
 * of a document and read the message back would have an identity- and reachability-probing
 * instrument paid for by this box. The reason a document was refused belongs in the operator's log.
 */

export const STANDARD_ERROR_CODES = [
  'malformedRequest',
  'unsupportedType',
  'unsupportedVersion',
  'unsupportedExtension',
  'expired',
  'proofRequired',
  'proofInvalid',
  'permissionDenied',
  'wrongRecipient',
  'identityMismatch',
  'idConflict',
  'cancelled',
  'taskFailed',
  'unavailable',
  'indeterminate',
  'internalError',
] as const;

export type StandardErrorCode = (typeof STANDARD_ERROR_CODES)[number];

/** The error specification version this box emits. 0.6 carries all sixteen codes above. */
export const ERROR_SPEC_VERSION = '0.6';
export const ERROR_TYPE_URI = registryTypeUri('trust-task-error', ERROR_SPEC_VERSION);

/** SPEC §8.3's "Default retryable" column; `taskFailed` varies, and `false` is the cautious default. */
const DEFAULT_RETRYABLE: Readonly<Record<StandardErrorCode, boolean>> = {
  malformedRequest: false,
  unsupportedType: false,
  unsupportedVersion: false,
  unsupportedExtension: false,
  expired: false,
  proofRequired: false,
  proofInvalid: false,
  permissionDenied: false,
  wrongRecipient: false,
  identityMismatch: false,
  idConflict: false,
  cancelled: false,
  taskFailed: false,
  unavailable: true,
  indeterminate: true,
  internalError: true,
};

const MESSAGES: Readonly<Record<StandardErrorCode, string>> = {
  malformedRequest: 'The document did not validate.',
  unsupportedType: 'The document type is not supported.',
  unsupportedVersion: 'The document type version is not supported.',
  unsupportedExtension: 'The document marks an extension critical that is not supported.',
  expired: 'The document is no longer acceptable.',
  proofRequired: 'A proof is required.',
  proofInvalid: 'The proof did not verify.',
  permissionDenied: 'The request is not permitted.',
  wrongRecipient: 'The document is addressed to another party.',
  identityMismatch: 'The document identity is inconsistent with the transport.',
  idConflict: 'A different document was already accepted under this id.',
  cancelled: 'The task was stopped.',
  taskFailed: 'The task could not be completed.',
  unavailable: 'The service is temporarily unavailable.',
  indeterminate: 'A determination could not be made.',
  internalError: 'An internal error occurred.',
};

/** HTTPS binding 0.3 §4. The code in the body is authoritative; the status is informative. */
const HTTP_STATUS: Readonly<Record<StandardErrorCode, number>> = {
  malformedRequest: 400,
  permissionDenied: 403,
  idConflict: 409,
  unsupportedType: 422,
  unsupportedVersion: 422,
  unsupportedExtension: 422,
  expired: 422,
  proofRequired: 422,
  proofInvalid: 422,
  identityMismatch: 422,
  wrongRecipient: 422,
  cancelled: 422,
  taskFailed: 422,
  unavailable: 503,
  indeterminate: 503,
  internalError: 500,
};

export function httpStatusFor(code: StandardErrorCode): number {
  return HTTP_STATUS[code];
}

/** SPEC §8.2.2: when a specification declares no bound, `details` may not exceed these. */
export const MAX_DETAILS_BYTES = 4096;
export const MAX_DETAILS_MEMBERS = 16;

/** `details` within SPEC §8.2.2's bound, or undefined — dropped whole rather than truncated. */
export function boundDetails(details: JsonObject | undefined): JsonObject | undefined {
  if (details === undefined) {
    return undefined;
  }

  if (Object.keys(details).length > MAX_DETAILS_MEMBERS) {
    return undefined;
  }

  try {
    return Buffer.byteLength(canonicalize(details), 'utf8') > MAX_DETAILS_BYTES ? undefined : details;
  } catch {
    return undefined;
  }
}

export interface ErrorPayloadInput {
  code: StandardErrorCode;
  retryable?: boolean;
  /** RFC 3339; meaningful only when retryable. */
  retryAfter?: string;
  inResponseTo?: { typeUri?: string; id?: string };
  details?: JsonObject;
}

/** The `payload` of a `trust-task-error` document. */
export function errorPayload(input: ErrorPayloadInput): JsonObject {
  const retryable = input.retryable ?? DEFAULT_RETRYABLE[input.code];
  const inResponseTo = input.inResponseTo;
  const details = boundDetails(input.details);

  return {
    code: input.code,
    ...(inResponseTo !== undefined && (inResponseTo.typeUri !== undefined || inResponseTo.id !== undefined)
      ? {
          inResponseTo: {
            ...(inResponseTo.typeUri === undefined ? {} : { typeUri: inResponseTo.typeUri }),
            ...(inResponseTo.id === undefined ? {} : { id: inResponseTo.id }),
          },
        }
      : {}),
    message: MESSAGES[input.code],
    retryable,
    ...(retryable && input.retryAfter !== undefined ? { retryAfter: input.retryAfter } : {}),
    ...(details === undefined ? {} : { details }),
  };
}
