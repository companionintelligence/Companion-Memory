/**
 * Errors about the phone's replica that the UI needs to recognise, kept apart from
 * `nativeDatabase.ts` so the error states can import them without pulling the native
 * SQLite adapter into the browser bundle (the provider loads that module lazily, and
 * only on a phone).
 */

/** SQLITE_BUSY as the Capacitor SQLite plugin reports it on Android and iOS. */
export function isDatabaseLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';

  return /database is locked|SQLITE_BUSY|\(code 5\)/i.test(message);
}

/** The replica could not be opened because another connection held its write lock for the whole retry window. */
export class ReplicaLockedError extends Error {
  /** The SQLITE_BUSY error from the last attempt. A plain field: the web tsconfig's lib predates `ErrorOptions`. */
  readonly cause: unknown;

  constructor(dbFilename: string, cause: unknown) {
    super(
      `The local replica ${dbFilename} is locked by another connection — an earlier session of this app ` +
        'still holds a write transaction. Closing the app fully and reopening it frees it.',
    );
    this.name = 'ReplicaLockedError';
    this.cause = cause;
  }
}

export function isReplicaLockedError(error: unknown): error is ReplicaLockedError {
  return (
    error instanceof ReplicaLockedError || (error instanceof Error && error.name === 'ReplicaLockedError')
  );
}
