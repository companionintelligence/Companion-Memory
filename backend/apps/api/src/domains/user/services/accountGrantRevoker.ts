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
 */
export const ACCOUNT_GRANT_REVOKER = 'ACCOUNT_GRANT_REVOKER';

/** One connection's revocation outcome. */
export interface GrantRevocation {
  connectionId: string;
  providerId: string | null;
  /** Whether the provider (or CI Portal, for a brokered grant) accepted the revocation. */
  tokenRevoked: boolean;
}

export interface AccountGrantRevoker {
  /**
   * Revoke, with its provider, the grant of every connection the account has. Best-effort and
   * bounded per connection: a provider that fails or does not answer counts as not revoked, and
   * this never rejects for it. Holds no lock and runs outside any transaction, before the account
   * is ended.
   */
  revokeGrants(userId: string): Promise<GrantRevocation[]>;

  /**
   * In the transaction that ends the account: mark every connection of the account inactive, clear
   * its tokens, and append the account's `started` row to the deletion audit, which records whether
   * any grant was revoked. If it throws, the account is not ended.
   *
   * @returns the id of the audit row.
   */
  recordAccountEnd(manager: EntityManager, userId: string, revocations: GrantRevocation[]): Promise<string>;

  /**
   * Record, after its transaction has rolled back, an attempt to end the account that failed.
   * Best-effort: never rejects, so it never hides the failure it records.
   */
  recordAccountEndFailed(userId: string, revocations: GrantRevocation[], error: unknown): Promise<void>;

  /**
   * For the purge of an ended account: revoke the grant of every connection that still holds a
   * token, then mark it inactive, clear its tokens and record the outcome. Idempotent: a connection
   * whose tokens are already cleared is not touched again. A provider failure does not stop it.
   */
  revokeRemainingGrants(userId: string): Promise<GrantRevocation[]>;
}

/**
 * The {@link ACCOUNT_GRANT_REVOKER} binding, or `null` when there is none (a container assembled
 * without PrivacyModule, or a service built by hand with no ModuleRef). Never throws. The
 * application module always loads PrivacyModule, for the api and the worker alike.
 */
export function resolveAccountGrantRevoker(moduleRef: ModuleRef | undefined): AccountGrantRevoker | null {
  try {
    return moduleRef?.get<AccountGrantRevoker>(ACCOUNT_GRANT_REVOKER, { strict: false }) ?? null;
  } catch {
    return null;
  }
}
