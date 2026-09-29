/**
 * Compatibility floor for the Memory HTTP API, advertised on `GET /api/health`.
 *
 * An integer, not a date and not a path segment. A dated version or `/api/v1`
 * is a shape you keep serving while outside clients pin it. This appliance and
 * its app are both ours, so a mismatch tells the user which side to update
 * instead of keeping yesterday's responses alive.
 *
 * Leave both numbers alone for a new page, a flag, an optional field, or an
 * endpoint only a new app calls. Bump `MIN_CLIENT_VERSION` only when an older
 * app would break or lie against this server.
 */
export const API_VERSION = 1;

export const MIN_CLIENT_VERSION = 1;
