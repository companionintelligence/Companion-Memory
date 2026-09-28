import { DatabaseCrashedError } from '@ci/common/persistence';

/**
 * The database crashed while the push had a statement in flight, so the push
 * stopped: the stage fails at once, and every row it had not settled is left
 * `pending`.
 *
 * Not resent in-process, and no row marked `failed` for it. A statement can be
 * what crashes Postgres (a TimescaleDB 2.28 segfault during a bulk upsert is
 * the precedent), and from the client "met a crash" and "caused one" are the
 * same error. Waiting for recovery and sending it again restarted the whole
 * appliance's database every time it came back; isolating the suspect row
 * in-process (resend the batch, then each row alone, quarantine the one that
 * crashes it) cost several crashes per poison row, never isolated it at all
 * when recovery was slow, and quarantined GOOD rows when every write crashed
 * the server. See `common/persistence/transientDatabaseError.ts`.
 *
 * So the recovery is a person's: re-drive the push once the database is
 * healthy. A stage failed this way is recorded `failed` (the stage worker waits
 * out the recovering database to record it, so the recovery sweep does not
 * re-run it), and `retryFailedPush` re-drives a push that failed with rows
 * `pending`. If the re-driven push crashes the database AGAIN at the same
 * place, the data in that batch is the suspect — the error log names the
 * staged rows that were in flight. Isolating a poison row automatically is a
 * known follow-up, not done here.
 *
 * Transient (it extends {@link DatabaseCrashedError}), so nothing in the push
 * quarantines a row over it, and no nested wait resends past it.
 */
export class DatabaseCrashedDuringPushError extends DatabaseCrashedError {
  constructor(
    readonly runId: string,
    operation: string,
    cause: unknown,
  ) {
    super(
      operation,
      cause,
      `the database crashed while this push was ${operation}; rows are left pending — ` +
        `re-drive with \`ci push --run ${runId} --retry-failed\` once the database is healthy ` +
        `(last error: ${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'DatabaseCrashedDuringPushError';
  }
}
