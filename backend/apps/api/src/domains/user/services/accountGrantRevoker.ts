import type { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';

/**
 * Revokes the provider grants (the OAuth tokens held for each connection) of an account that is
 * being ended. The privacy domain's `DataDeletionService` implements it and `PrivacyModule` binds
 * {@link ACCOUNT_GRANT_REVOKER} to it.
 *
 * A token rather than the class, because the privacy and connections domains both depend on this
 * one: importing them here would close a cycle. So this domain owns the contract and privacy
 * supplies it; `UserService` and `AccountPurgeService` resolve it lazily with
 * `moduleRef.get(ACCOUNT_GRANT_REVOKER, { strict: false })`, the pattern `SELF_ENTITY_PROVISIONER`
 * uses.
 *
 * The order every account delete follows:
 *
 * 1. Under the lock every sign-up takes, the last-administrator rule is decided and the account is
 *    ended; in that same transaction {@link AccountGrantRevoker.recordAccountEnd} marks each of its
 *    connections inactive and revocation-pending, its tokens kept, and writes the `started` audit row.
 *    Nothing outside the database has happened yet, so a refused request has revoked nothing.
 * 2. After the commit, with no lock held, {@link AccountGrantRevoker.revokePendingGrants} asks each
 *    provider. A connection whose grant was revoked, or that had nothing to revoke, has its tokens
 *    and its pending mark cleared. One whose revocation failed keeps both.
 * 3. The purge calls {@link AccountGrantRevoker.revokePendingGrants} again before it deletes any row,
 *    and fails the run (to be retried) while a revocation still fails.
 */
export const ACCOUNT_GRANT_REVOKER = 'ACCOUNT_GRANT_REVOKER';

/**
 * - `revoked`: the provider (or CI Portal, for a brokered grant) accepted the revocation.
 * - `not_applicable`: there was nothing to revoke (no token, or a provider with no way to revoke).
 * - `failed`: there was a grant to revoke and the provider did not confirm it, did not answer in
 *   time, or the request failed.
 */
export type RevocationOutcome = 'revoked' | 'not_applicable' | 'failed';

/** One connection's revocation attempt. */
export interface GrantRevocation {
  connectionId: string;
  providerId: string | null;
  outcome: RevocationOutcome;
  /** `outcome === 'revoked'`. */
  tokenRevoked: boolean;
}

/**
 * What the account-level rows of `ci.data_deletion_audit` record about the account's grants, in
 * their `revocations` column: every connection `pending` on the `started` row, and each one's final
 * outcome on the `completed` row.
 */
export interface RevocationSummary {
  revoked: number;
  notApplicable: number;
  failed: number;
  pending: number;
  connections: Array<{
    connectionId: string;
    providerId: string | null;
    outcome: RevocationOutcome | 'pending';
  }>;
}

export interface AccountGrantRevoker {
  /**
   * In the transaction that ends the account, after the last-administrator rule has passed under
   * the lock: mark every connection of the account inactive and revocation-pending, keeping its
   * tokens, and append the account's `started` audit row with every connection pending. If it
   * throws, the account is not ended. Makes no network call.
   *
   * @returns the id of the audit row.
   */
  recordAccountEnd(manager: EntityManager, userId: string): Promise<string>;

  /**
   * Revoke, with its provider, the grant of every connection of an ended account that is
   * revocation-pending or still holds a token, one at a time, each bounded in time. Holds no lock
   * and runs outside any transaction. Each outcome is recorded in the audit trail. A connection
   * whose grant was revoked or had nothing to revoke has its tokens and pending mark cleared; one
   * whose revocation failed keeps both, for the next attempt. Idempotent: a cleared connection is
   * not asked again.
   *
   * A provider failure never rejects (it is an outcome); a database failure does.
   */
  revokePendingGrants(userId: string): Promise<GrantRevocation[]>;

  /**
   * Record, after its transaction has rolled back, an attempt to end the account that failed.
   * Best-effort: never rejects, so it never hides the failure it records.
   */
  recordAccountEndFailed(userId: string, error: unknown): Promise<void>;
}

/** Nothing could be resolved for {@link ACCOUNT_GRANT_REVOKER}: an account delete must not go on. */
export class AccountGrantRevokerUnavailable extends Error {
  constructor(cause: unknown) {
    super(
      `No provider is bound to ${ACCOUNT_GRANT_REVOKER}, so the account's provider grants cannot be ` +
        `revoked and the account is not deleted (PrivacyModule binds it). Cause: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AccountGrantRevokerUnavailable';
  }
}

/**
 * The {@link ACCOUNT_GRANT_REVOKER} binding. Throws {@link AccountGrantRevokerUnavailable} when there
 * is none (a container assembled without PrivacyModule, or a service built by hand with no
 * ModuleRef): ending an account, or purging one, without revoking its grants would leave them live
 * with the providers, so both refuse instead. The application module always loads PrivacyModule,
 * for the api and the worker alike.
 */
export function requireAccountGrantRevoker(moduleRef: ModuleRef | undefined): AccountGrantRevoker {
  let revoker: AccountGrantRevoker | undefined;

  try {
    if (!moduleRef) {
      throw new Error('the service was built without a ModuleRef');
    }

    revoker = moduleRef.get<AccountGrantRevoker>(ACCOUNT_GRANT_REVOKER, { strict: false });
  } catch (error) {
    throw new AccountGrantRevokerUnavailable(error);
  }

  if (revoker == null) {
    throw new AccountGrantRevokerUnavailable(new Error('the binding resolved to nothing'));
  }

  return revoker;
}

/** The summary of a set of outcomes, with `pending` for connections not yet attempted. */
export function summarizeRevocations(
  connections: Array<{
    connectionId: string;
    providerId: string | null;
    outcome: RevocationOutcome | 'pending';
  }>,
): RevocationSummary {
  const count = (outcome: RevocationOutcome | 'pending') =>
    connections.filter((connection) => connection.outcome === outcome).length;

  return {
    revoked: count('revoked'),
    notApplicable: count('not_applicable'),
    failed: count('failed'),
    pending: count('pending'),
    connections: connections.map(({ connectionId, providerId, outcome }) => ({
      connectionId,
      providerId,
      outcome,
    })),
  };
}

/**
 * The `token_revoked` of an account-level audit row: true only when every grant that needed revoking
 * was revoked, false when any failed or is still pending, null when there was nothing to revoke.
 */
export function accountTokenRevoked(summary: RevocationSummary): boolean | null {
  if (summary.failed > 0 || summary.pending > 0) {
    return false;
  }

  return summary.revoked > 0 ? true : null;
}
