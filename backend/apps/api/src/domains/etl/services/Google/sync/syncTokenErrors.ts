/**
 * Whether `err` is Google refusing a stored sync token, so the sync has to start over without it.
 *
 * Calendar answers 410 GONE (`reason: 'fullSyncRequired'`). The People API (Contacts) answers 400
 * FAILED_PRECONDITION, "Sync token is expired. Clear local cache and retry call without the sync
 * token." (`reason: 'EXPIRED_SYNC_TOKEN'`), about seven days after the last sync. `BaseOAuth2Client.request`
 * throws an `Error` whose `.details` carries `{ code, message }` from the response body, falling back
 * to the HTTP status; the message check covers both providers and any shape that misses the code.
 */
export function isSyncTokenInvalidError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const details = (err as Error & { details?: { code?: number } }).details;

  if (details?.code === 410) {
    return true;
  }

  return /sync\s*token|fullsyncrequired|expired_sync_token|\b410\b/i.test(err.message);
}
