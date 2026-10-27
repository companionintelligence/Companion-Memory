import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import {
  BaseOAuth2Client,
  ClientFactory,
  CloudOAuthProxyService,
  ConnectionEntity,
  ProviderKeyService,
  type BaseClient,
  type Connection,
} from '@ci/domains/connections';
import { OrphanCleanupService } from '@ci/domains/search-ingress';
import {
  AccountPurgeService,
  LastAdminDeletionRefused,
  UserService,
  type AccountPurgeOutcome,
  type DeletionOptions,
} from '@ci/domains/user';

import { CONNECTION_SCOPED_TABLES, type ConnectionScopedTable } from '../dataDeletionPlan';
import { DataDeletionAuditEntity } from '../entities/DataDeletionAuditEntity';

/**
 * How long an account delete waits on one connection's revocation (the provider,
 * and CI Portal for a brokered one). Revoking is best-effort, and the requests
 * have no timeout of their own. They run before the account is ended and hold no
 * lock, but the person is waiting on the request. Past this the grant counts as
 * not revoked, as any other failed revocation does, and the delete goes on.
 */
export const REVOCATION_DEADLINE_MS = 10_000;

/**
 * How long `POST /users/me/delete` waits for the purge before it answers. The
 * account is already ended by then (nobody can sign in to it, its keys and
 * sessions are gone); what this bounds is only whether the answer can say the
 * rows are gone too. A purge still running past it carries on, and the answer
 * says `deleting`.
 */
export const IMMEDIATE_PURGE_WAIT_MS = 30_000;

/**
 * How long the `failed` audit row of an account delete that never ended the
 * account may wait for a connection. Written after that transaction has rolled
 * back, but a pool that stays full (requests queued behind something else) must
 * not hold the failing request for good: past this the failure is only logged.
 */
export const FAILED_AUDIT_DEADLINE_MS = 10_000;

/** Result of a single per-connection disconnect + purge. */
export interface DisconnectResult {
  connectionId: string;
  providerId: string | null;
  /** Whether the provider accepted the OAuth token for revocation. */
  tokenRevoked: boolean;
  /** Per-table row counts purged (e.g. { "ci.communications": 42 }). */
  deletedCounts: Record<string, number>;
  /**
   * Rows this connection delivered that SURVIVED the purge because
   * ci.record_sources shows another arrival still evidences them (e.g. the
   * same email also came from a Takeout import). Their connection_id link is
   * cleared; the records stay.
   */
  retainedCounts: Record<string, number>;
  totalDeleted: number;
  auditId: string;
}

/** Result of a full account deletion. */
export interface AccountDeletionResult {
  userId: string;
  /**
   * `deleted`: the account and every row of it are gone. `deleting`: the account is
   * ended (nobody can sign in to it, its sessions, API keys and provider tokens are
   * gone) and the purge of its rows is still running, or will be finished by the
   * hourly purge; `ci.data_deletion_audit` gets its `completed` row then.
   */
  status: 'deleted' | 'deleting';
  /** Per-connection revocation outcome, keyed by connection id. */
  revocations: Array<{ connectionId: string; providerId: string | null; tokenRevoked: boolean }>;
  /** Per-table row counts purged. Empty while `deleting`. */
  deletedCounts: Record<string, number>;
  /**
   * Rows that named this account and were kept with that reference removed:
   * `ci.ask_audit` rows another account is a party to, `ci.users.created_by` of
   * accounts this one created, and the other columns the purge detaches.
   */
  detachedCounts: Record<string, number>;
  totalDeleted: number;
  /** Stored file objects removed from the object store. */
  deletedObjects: number;
  /** True once the ci.users row itself has been removed. */
  userDeleted: boolean;
  /** The `started` audit row, written when the account was ended. */
  auditId: string;
}

/**
 * Implements CASA/ASVS V8 user-data deletion for ci-memory (the primary store of
 * Google-derived user data). Two granularities:
 *
 *  1. {@link disconnectConnection} — disconnect ONE connection: revoke its OAuth
 *     grant with the provider (Google requires this), then hard-delete the
 *     connection and the data derived from it, and reap the now-orphaned search
 *     index rows. Scoped to the connection's owner.
 *
 *  2. {@link deleteAccount} — delete the WHOLE account: revoke every connection's
 *     grant, end the account in one short transaction, then purge every row of it
 *     through the batched, resumable account purge (`AccountPurgeService`), and
 *     reap the search index.
 *
 * Both are owner-scoped and audit-logged (ci.data_deletion_audit). A disconnect
 * of a connection already gone 404s; an account already ended has nothing left
 * to sign in with, and its purge finishes on its own.
 */
@Injectable()
export class DataDeletionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
    @InjectRepository(DataDeletionAuditEntity)
    private readonly auditRepository: Repository<DataDeletionAuditEntity>,
    private readonly clientFactory: ClientFactory,
    private readonly orphanCleanupService: OrphanCleanupService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly cloudOAuthProxyService: CloudOAuthProxyService,
    private readonly logger: LoggerService,
    private readonly userService: UserService,
    private readonly accountPurgeService: AccountPurgeService,
  ) {
    this.logger.setContext(DataDeletionService.name);
  }

  /**
   * Disconnect a single connection: revoke the provider grant, hard-delete the
   * connection, purge the data derived from it, and reap orphaned search rows.
   *
   * Owner-scoped: throws NotFoundException if the connection does not exist OR is
   * not owned by the caller (so a caller can never disconnect another user's
   * connection, and enumeration is not possible).
   */
  async disconnectConnection(context: UserServiceContext, connectionId: string): Promise<DisconnectResult> {
    // Owner scoping: load the connection ONLY if it belongs to the caller.
    const connection = await this.connectionRepository.findOne({
      where: { id: connectionId, userId: context.userId },
      relations: ['provider'],
    });

    if (connection == null) {
      throw new NotFoundException('Connection not found');
    }

    const providerId = connection.providerId ?? null;

    // 1) Revoke the OAuth grant with the provider (best-effort; never blocks).
    const tokenRevoked = await this.revokeConnectionGrant(connection);

    // 2) Purge data DERIVED from this connection (top-level connection_id links).
    const deletedCounts: Record<string, number> = {};
    const retainedCounts: Record<string, number> = {};

    // 2a) This connection's own arrivals leave the multi-provenance ledger
    // FIRST, so they cannot count as "evidence" protecting their own rows in
    // the guarded deletes below (docs/design/cross-pipeline-identity.md §5).
    const ledgerDeleted = await this.deleteConnectionArrivals(context.userId, connectionId);
    if (ledgerDeleted > 0) {
      deletedCounts['ci.record_sources'] = ledgerDeleted;
    }

    for (const scoped of CONNECTION_SCOPED_TABLES) {
      if (scoped.recordTable != null && scoped.pkColumn != null && scoped.userColumn != null) {
        // Ledgered table: delete only rows with NO remaining arrival from any
        // other source — a record the import (or another connection) also
        // delivered survives the disconnect. Rows that predate the ledger
        // (no arrivals at all) keep the old behavior and are purged.
        const deleted = await this.deleteConnectionRowsWithoutOtherEvidence(scoped, connectionId);
        if (deleted > 0) {
          deletedCounts[`${scoped.schema}.${scoped.table}`] = deleted;
        }

        // Survivors keep their data but must not dangle a link to a
        // connection row deleted below.
        const retained = await this.unlinkSurvivors(scoped, connectionId);
        if (retained > 0) {
          retainedCounts[`${scoped.schema}.${scoped.table}`] = retained;
        }

        continue;
      }

      const count = await this.deleteWhere(
        scoped.schema,
        scoped.table,
        scoped.connectionColumn,
        connectionId,
      );
      if (count > 0) {
        deletedCounts[`${scoped.schema}.${scoped.table}`] = count;
      }
    }

    // Graph entities/relationships derived from this connection carry the
    // connection id inside their JSONB `properties`, scoped to the owner.
    const graphEntities = await this.deleteGraphByConnection('entities', context.userId, connectionId);
    if (graphEntities > 0) {
      deletedCounts['ci.entities'] = graphEntities;
    }

    const graphRelationships = await this.deleteGraphByConnection(
      'relationships',
      context.userId,
      connectionId,
    );
    if (graphRelationships > 0) {
      deletedCounts['ci.relationships'] = graphRelationships;
    }

    // 3) Delete the connection row itself (hard delete — supersedes the old
    // soft-delete that left tokens + derived data orphaned).
    const connDeleted = await this.deleteWhere('ci', 'connections', 'id', connectionId);
    if (connDeleted > 0) {
      deletedCounts['ci.connections'] = connDeleted;
    }

    // 4) Reap search-index rows whose source row we just deleted.
    await this.cleanupSearchIndex();

    const totalDeleted = sumCounts(deletedCounts);

    const auditId = await this.writeAudit({
      subjectUserId: context.userId,
      requestedByUserId: context.userId,
      scope: 'connection',
      connectionId,
      providerId,
      tokenRevoked,
      deletedCounts,
      totalDeleted,
    });

    this.logger.log('Connection disconnected and derived data purged', {
      connectionId,
      providerId,
      tokenRevoked,
      totalDeleted,
      retainedCounts,
    });

    return { connectionId, providerId, tokenRevoked, deletedCounts, retainedCounts, totalDeleted, auditId };
  }

  /**
   * Delete the whole account, in three steps:
   *
   * 1. Revoke every connection's OAuth grant, best-effort and with no lock held,
   *    so access stops on the provider side whatever happens next. Asked first
   *    whether the request would be refused ({@link UserService.assertMayEndAccount}),
   *    so a last administrator who named no successor loses no grant.
   * 2. End the account, in one short transaction under the lock every sign-up
   *    takes ({@link UserService.endAccountNow}): the successor promoted when
   *    one is needed, the account hidden from every read with its purge due now,
   *    its sessions and API keys deleted, its provider tokens cleared, and the
   *    `started` audit row written. All of it or none of it.
   * 3. Purge the rows through `AccountPurgeService`: batched, every batch its
   *    own commit, no lock but its own advisory one. The stored bytes go first,
   *    while the rows that name them are still there; then the table purge, the
   *    ask records, the detached columns (`ci.users.created_by`) and the user
   *    row; then the `completed` audit row with the counts. An interruption
   *    loses one batch, not the delete: the hourly purge finds the account due
   *    and carries on, and whichever run finishes writes `completed`.
   *
   * Waits up to {@link IMMEDIATE_PURGE_WAIT_MS} for step 3 and answers
   * `deleted` or `deleting`. A failure in step 2 leaves the account as it was,
   * is recorded as a `failed` audit row once its transaction has rolled back,
   * and is rethrown; asking again is safe. {@link LastAdminDeletionRefused} is
   * rethrown without one, as nothing was attempted.
   *
   * Why not one transaction: that held the sign-up lock for the whole purge (a
   * graph-heavy account ran past 49 minutes in review, every sign-up waiting),
   * and an interruption anywhere threw all of it away, which is the reason the
   * 30-day purge is batched (`purge/purgePlan.ts`). Once step 2 commits nobody
   * can sign in to the account, and its share links, peer links and grants are
   * closed (`UserService.endAccount`), so a partial purge is never a partial live
   * account: it is an ended account with rows still to delete. The operator undo
   * that `DELETE /account` has inside its grace period (clearing `deleted_at` and
   * `purge_after`) does not apply here: it would revive an account whose purge
   * may already have removed part of it.
   *
   * With `accountDeletion.purge.enabled` off (the operator's stop for an
   * irreversible job), step 3 does not run: the account is ended, the answer is
   * `deleting`, and the rows wait for the purge to be switched back on.
   */
  async deleteAccount(
    context: UserServiceContext,
    options: DeletionOptions = {},
  ): Promise<AccountDeletionResult> {
    const userId = context.userId;

    await this.userService.assertMayEndAccount(context, userId, options);

    const connections = await this.connectionRepository.find({
      where: { userId },
      relations: ['provider'],
    });

    const revocations: AccountDeletionResult['revocations'] = [];
    for (const connection of connections) {
      const tokenRevoked = await withDeadline(
        this.revokeConnectionGrant(connection),
        REVOCATION_DEADLINE_MS,
        'The revocation',
      ).catch((error: unknown) => {
        this.logger.warn('Connection grant revocation timed out; continuing with the delete', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        return false;
      });
      revocations.push({
        connectionId: connection.id,
        providerId: connection.providerId ?? null,
        tokenRevoked,
      });
    }

    const tokenRevoked = revocations.some((r) => r.tokenRevoked);

    let ended: { requestedAt: Date; purgeAfter: Date; result: string };

    try {
      const outcome = await this.userService.endAccountNow(context, userId, options, (manager) =>
        this.revokeAccessAndRecordStart(manager, userId, tokenRevoked),
      );

      if (outcome == null) {
        throw new NotFoundException('Account not found');
      }

      ended = outcome;
    } catch (error) {
      if (!(error instanceof LastAdminDeletionRefused) && !(error instanceof NotFoundException)) {
        // The transaction has rolled back by now and released what it held, so
        // this waits for a pooled connection like any other request (bounded).
        await this.writeFailedAccountAudit(userId, tokenRevoked, error);
      }

      throw error;
    }

    const purge = this.purgeEndedAccount(userId, ended.requestedAt, ended.purgeAfter);
    const outcome = await waitAtMost(purge, IMMEDIATE_PURGE_WAIT_MS);
    const done = outcome?.status === 'purged';

    this.logger.log(done ? 'Account deleted and all data purged' : 'Account ended; its purge goes on', {
      userId,
      connectionsRevoked: revocations.length,
      status: outcome?.status ?? 'running',
      totalDeleted: done ? sumCounts(outcome.deletedRows) : 0,
      deletedObjects: outcome?.deletedObjects ?? 0,
    });

    return {
      userId,
      status: done ? 'deleted' : 'deleting',
      revocations,
      deletedCounts: done ? outcome.deletedRows : {},
      detachedCounts: done ? outcome.detachedRows : {},
      totalDeleted: done ? sumCounts(outcome.deletedRows) : 0,
      deletedObjects: done ? outcome.deletedObjects : 0,
      userDeleted: done && (outcome.deletedRows['ci.users'] ?? 0) > 0,
      auditId: ended.result,
    };
  }

  /**
   * The writes that end the account's access, in the transaction that ends the
   * account. Hiding the user row already fails every sign-in, token and key that
   * resolves through it; these go further, so nothing holding a session, a key or
   * a provider token keeps writing for the account while its purge runs. None of
   * these tables has a foreign key pointing into it, so the deletes are cheap.
   * What other people could read through the account (share links, peer links,
   * grants) is closed by `UserService.endAccount` in the same transaction, for
   * this delete and `DELETE /account` alike.
   *
   * @returns the id of the `started` audit row.
   */
  private async revokeAccessAndRecordStart(
    manager: EntityManager,
    userId: string,
    tokenRevoked: boolean,
  ): Promise<string> {
    await manager.query(`DELETE FROM ci.sessions WHERE user_id = $1`, [userId]);
    await manager.query(`DELETE FROM ci.api_keys WHERE user_id = $1`, [userId]);
    await manager.query(
      `UPDATE ci.connections
          SET active = false, access_token = NULL, refresh_token = NULL
        WHERE user_id = $1`,
      [userId],
    );

    return this.writeAudit(
      {
        subjectUserId: userId,
        requestedByUserId: userId,
        scope: 'account',
        connectionId: null,
        providerId: null,
        tokenRevoked,
        deletedCounts: {},
        totalDeleted: 0,
        status: 'started',
      },
      manager,
    );
  }

  /**
   * The purge of an ended account, tried twice: a row written for the account
   * after its table was purged (a job that was already running when the account
   * ended) refuses the user row's delete, and a second pass removes it. Past that,
   * the hourly purge retries. Then the search-index sweep, which reads the whole
   * appliance's index; a purge the hourly run finishes leaves the sweep to
   * `OrphanCleanupCron`. Never rejects.
   *
   * Not run at all while `accountDeletion.purge.enabled` is off: that switch is
   * the operator's stop for the purge, and it holds here as it does for the
   * hourly run.
   */
  private async purgeEndedAccount(
    userId: string,
    requestedAt: Date,
    purgeAfter: Date,
  ): Promise<AccountPurgeOutcome | null> {
    if (!config.accountDeletion.purge.enabled) {
      this.logger.warn('Account ended; its purge waits because the account purge is switched off', {
        userId,
      });

      return null;
    }

    try {
      let outcome = await this.accountPurgeService.purgeAccount(userId, requestedAt, purgeAfter);

      if (outcome.status === 'failed') {
        const first = outcome;
        outcome = await this.accountPurgeService.purgeAccount(userId, requestedAt, purgeAfter);
        outcome = mergeOutcomes(first, outcome);
      }

      if (outcome.status === 'purged') {
        await this.cleanupSearchIndex();
      } else {
        this.logger.warn('Purge of an ended account did not finish; the hourly purge will retry it', {
          userId,
          status: outcome.status,
          error: outcome.error,
        });
      }

      return outcome;
    } catch (error) {
      this.logger.error('Purge of an ended account threw; the hourly purge will retry it', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return null;
    }
  }

  /**
   * The audit row of an account delete that did not end the account. Written
   * after the transaction that tried has rolled back, on any pooled connection,
   * and given up on past {@link FAILED_AUDIT_DEADLINE_MS}. Best-effort, so it
   * never hides the failure it records.
   */
  private async writeFailedAccountAudit(
    userId: string,
    tokenRevoked: boolean,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    this.logger.error('Account deletion failed and was rolled back', { userId, error: message });

    try {
      await withDeadline(
        this.auditRepository.save(
          this.auditRepository.create({
            id: uuidv7(),
            subjectUserId: userId,
            requestedByUserId: userId,
            scope: 'account',
            connectionId: null,
            providerId: null,
            tokenRevoked,
            deletedCounts: {},
            totalDeleted: 0,
            status: 'failed',
            error: message,
          }),
        ),
        FAILED_AUDIT_DEADLINE_MS,
        'The audit write',
      );
    } catch (auditError) {
      this.logger.error('Could not record the failed account deletion', {
        userId,
        error: auditError instanceof Error ? auditError.message : 'Unknown error',
      });
    }
  }

  /**
   * Revoke a connection's OAuth grant with its provider. Best-effort: returns
   * false (never throws) for OpenID/token-less/unsupported providers or on any
   * provider error, so the local purge always proceeds.
   */
  private async revokeConnectionGrant(connection: ConnectionEntity): Promise<boolean> {
    if (connection.providerId == null) {
      return false;
    }

    let client: BaseClient;
    try {
      client = this.clientFactory.getClientByProviderId(connection.providerId);
    } catch (error) {
      this.logger.log('No client for provider; skipping revocation', {
        connectionId: connection.id,
        providerId: connection.providerId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return false;
    }

    if (!(client instanceof BaseOAuth2Client)) {
      // OpenID providers (e.g. Steam) hold no revocable OAuth token.
      return false;
    }

    if (await this.isProxiedThroughPortal(connection)) {
      // Portal can only delete its stored refresh token for a provider like
      // Dropbox, whose revocation needs a live ACCESS token — and the access
      // token on this connection is the provider's own, proxied or not. So
      // end the grant from here first; Portal's delete still follows, since a
      // credential the box has disconnected must not survive there either.
      const revokedHere = client.revokesWithAccessToken
        ? await this.revokeWithAccessToken(client, connection)
        : false;
      const revokedAtPortal = await this.revokeViaPortal(connection);

      return revokedHere || revokedAtPortal;
    }

    try {
      // revoke() reads only { id, accessToken, refreshToken }, plus { userId,
      // providerId } where the provider requires client auth to revoke (Reddit
      // looks up the user's own app keys); pass those directly rather than
      // routing through ConnectionEntity.toEgressType (which would require the
      // provider/user relations to be fully hydrated).
      const { revoked } = await client.revoke({
        id: connection.id,
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        userId: connection.userId,
        providerId: connection.providerId,
      } as Connection);

      return revoked;
    } catch (error) {
      // revoke() is already best-effort internally, but guard here too so a
      // deletion is never blocked by a provider outage.
      this.logger.error('Connection grant revocation threw; continuing with purge', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return false;
    }
  }

  /**
   * Whether this connection was authorized through CI Portal's OAuth proxy
   * rather than the user's own provider app. The two are told apart the same
   * way `BaseOAuth2Client` decides how to refresh: a `ci.provider_keys` row for
   * this user + provider means the user brought their own app and the tokens
   * on the connection are the provider's; no row means Portal brokered the
   * grant, the connection's `refresh_token` is a Portal-issued proxy token,
   * and — for providers that issue refresh tokens — Portal holds the real one.
   */
  private async isProxiedThroughPortal(connection: ConnectionEntity): Promise<boolean> {
    if (connection.providerId == null || !this.cloudOAuthProxyService.isPortalConfigured()) {
      return false;
    }

    if (this.cloudOAuthProxyService.getProviderNameForId(connection.providerId) == null) {
      return false;
    }

    const ownKeys = await this.providerKeyService.findByProviderId(
      { userId: connection.userId },
      connection.providerId,
    );

    return ownKeys == null;
  }

  /**
   * Ask CI Portal to revoke and delete the credential it holds for this
   * connection. Portal revokes the real provider refresh token upstream and
   * hard-deletes its row; the appliance's own copy is purged by the caller.
   * Best-effort like the direct path: a Portal outage never blocks deletion.
   *
   * Posting the connection's tokens to the provider ourselves would be
   * pointless here — its `refresh_token` is a Portal proxy token the provider
   * has never seen, and the access token dies on its own within the hour.
   *
   * ── Which credential, on an appliance with more than one account ─────────
   *
   * Portal knows this appliance as ONE device, whichever account is signed in,
   * and keeps one credential per (device, provider, provider account). The
   * proxy refresh token names this connection's own grant. The provider
   * account id does not: it names whichever grant this device holds for that
   * account, and `external_id` is not proof the account is the caller's. So:
   *
   * - When another account here has any connection to the same provider, the
   *   id is never sent. Only the token speaks, and with no token there is
   *   nothing of this connection's to revoke. Otherwise one account's
   *   disconnect deleted another account's grant at Portal (and, for Google,
   *   revoked it upstream). Matching on `external_id` would not be enough:
   *   for a grant Portal stored no refresh token for, the id came from the
   *   browser, and the other account's row may hold the id in another form
   *   or not at all (proxied connections made before the id was recorded).
   * - Otherwise the token and the id go together, as before. A newer Portal
   *   matches the token alone when one is sent, so a token that went stale (a
   *   rotation this appliance failed to save) finds nothing; then the id alone
   *   is sent once, which is what clears that row. With no other account on
   *   this provider, any row Portal holds for the id is this account's own or
   *   an orphan.
   *
   * @returns true only when Portal deleted at least one credential and every
   *   upstream revocation it attempted succeeded — so a provider that never
   *   issues refresh tokens (Facebook) reports false, as before, because there
   *   was nothing held anywhere but here.
   */
  /**
   * Revoke with the access token only. The connection's `refresh_token` is a
   * Portal proxy token here — a Portal secret the provider has never seen —
   * and is deliberately withheld from the client.
   */
  private async revokeWithAccessToken(
    client: BaseOAuth2Client,
    connection: ConnectionEntity,
  ): Promise<boolean> {
    try {
      const { revoked } = await client.revoke({
        id: connection.id,
        accessToken: connection.accessToken,
        refreshToken: null,
        userId: connection.userId,
        providerId: connection.providerId,
      } as Connection);

      return revoked;
    } catch (error) {
      this.logger.error('Access-token revocation threw; continuing', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return false;
    }
  }

  private async revokeViaPortal(connection: ConnectionEntity): Promise<boolean> {
    try {
      const provider = this.cloudOAuthProxyService.getProviderNameForId(connection.providerId!)!;
      const accountId = (await this.providerUsedByAnotherUser(connection)) ? null : connection.externalId;

      let result = await this.cloudOAuthProxyService.revokeToken({
        proxyRefreshToken: connection.refreshToken,
        provider,
        userProviderId: accountId,
      });

      if (result.tokens_deleted === 0 && connection.refreshToken && accountId) {
        result = await this.cloudOAuthProxyService.revokeToken({ provider, userProviderId: accountId });
      }

      if (result.tokens_deleted > 0 && !result.revocation_ok) {
        this.logger.warn('CI Portal deleted the stored credential but the provider refused revocation', {
          connectionId: connection.id,
          provider,
        });
      }

      return result.tokens_deleted > 0 && result.revocation_ok;
    } catch (error) {
      this.logger.error('CI Portal credential revocation failed; continuing with local purge', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return false;
    }
  }

  /**
   * Whether another account on this appliance has a connection (active or
   * not) to the same provider. Inactive rows count: a paused connection still
   * holds its grant at Portal.
   *
   * Deliberately not narrowed to the same `external_id`: that id is not proof
   * of whose grant Portal holds (see {@link revokeViaPortal}). The cost is the
   * stale-token fallback on an appliance where two accounts use one provider:
   * Portal's row stays, and the grant stays live until it is revoked at the
   * provider.
   *
   * A probe that fails reads as "used". That only costs the id fallback,
   * while the opposite mistake could delete another account's grant.
   */
  private async providerUsedByAnotherUser(connection: ConnectionEntity): Promise<boolean> {
    if (connection.externalId == null || connection.externalId === '' || connection.providerId == null) {
      return false;
    }

    try {
      return await this.connectionRepository.exists({
        where: {
          providerId: connection.providerId,
          userId: Not(connection.userId),
        },
      });
    } catch (error) {
      this.logger.warn('Could not tell whether another account uses this provider; revoking by token only', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return true;
    }
  }

  /** Remove one connection's arrivals from the multi-provenance ledger. */
  private async deleteConnectionArrivals(userId: string, connectionId: string): Promise<number> {
    const result = await this.dataSource.query(
      `DELETE FROM ci.record_sources WHERE user_id = $1 AND connection_id = $2`,
      [userId, connectionId],
    );

    return affectedRows(result);
  }

  /**
   * Delete a ledgered table's connection-scoped rows ONLY where no arrival
   * from any other source remains in ci.record_sources (this connection's own
   * arrivals were removed first). A row with zero ledger arrivals — written
   * before the ledger existed, or by a path that does not ledger — has no
   * counter-evidence and is purged, matching the pre-ledger behavior.
   */
  private async deleteConnectionRowsWithoutOtherEvidence(
    scoped: ConnectionScopedTable,
    connectionId: string,
  ): Promise<number> {
    // Identifiers come from the trusted internal deletion plan; the value is
    // always a bound parameter (same contract as deleteWhere).
    const result = await this.dataSource.query(
      `DELETE FROM "${scoped.schema}"."${scoped.table}" t
        WHERE t."${scoped.connectionColumn}" = $1
          AND NOT EXISTS (
            SELECT 1 FROM ci.record_sources rs
             WHERE rs.user_id = t."${scoped.userColumn}"
               AND rs.record_table = '${scoped.recordTable}'
               AND rs.record_id = t."${scoped.pkColumn}"
          )`,
      [connectionId],
    );

    return affectedRows(result);
  }

  /** Clear the connection link on rows that survived the guarded delete. */
  private async unlinkSurvivors(scoped: ConnectionScopedTable, connectionId: string): Promise<number> {
    const result = await this.dataSource.query(
      `UPDATE "${scoped.schema}"."${scoped.table}" SET "${scoped.connectionColumn}" = NULL
        WHERE "${scoped.connectionColumn}" = $1`,
      [connectionId],
    );

    return affectedRows(result);
  }

  /**
   * DELETE ... WHERE <column> = <value>, returning the affected row count.
   */
  private async deleteWhere(schema: string, table: string, column: string, value: string): Promise<number> {
    // schema/table/column come exclusively from the trusted internal deletion
    // plan (never request input); the value is always a bound parameter.
    const result = await this.dataSource.query(`DELETE FROM "${schema}"."${table}" WHERE "${column}" = $1`, [
      value,
    ]);

    return affectedRows(result);
  }

  /**
   * Delete graph rows (ci.entities / ci.relationships) whose JSONB `properties`
   * carry this connection's id, scoped to the owner so we never touch another
   * user's graph.
   */
  private async deleteGraphByConnection(
    table: 'entities' | 'relationships',
    userId: string,
    connectionId: string,
  ): Promise<number> {
    const ownerColumn = 'owner_user_id';
    const result = await this.dataSource.query(
      `DELETE FROM "ci"."${table}"
        WHERE "${ownerColumn}" = $1
          AND properties->>'connection_id' = $2`,
      [userId, connectionId],
    );

    return affectedRows(result);
  }

  /**
   * Reap search-index rows (ci_search.embeddings / vectors) whose source row no
   * longer exists. We already delete each user's own index rows by user_id in the
   * plan; this catches rows keyed only by (entity_type, entity_id) whose backing
   * ci.* row we removed. Best-effort — logged, never fatal to the deletion.
   */
  async cleanupSearchIndex(): Promise<void> {
    try {
      await this.orphanCleanupService.cleanOrphans();
    } catch (error) {
      this.logger.error('Search-index orphan cleanup after deletion failed (non-fatal)', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /** Append the audit row, through `within` when given so it commits only with what it records. */
  private async writeAudit(
    data: {
      subjectUserId: string;
      requestedByUserId: string;
      scope: 'connection' | 'account';
      connectionId: string | null;
      providerId: string | null;
      tokenRevoked: boolean | null;
      deletedCounts: Record<string, number>;
      totalDeleted: number;
      status?: 'started' | 'completed';
    },
    within?: EntityManager,
  ): Promise<string> {
    const record = this.auditRepository.create({
      id: uuidv7(),
      subjectUserId: data.subjectUserId,
      requestedByUserId: data.requestedByUserId,
      scope: data.scope,
      connectionId: data.connectionId,
      providerId: data.providerId,
      tokenRevoked: data.tokenRevoked,
      deletedCounts: data.deletedCounts,
      totalDeleted: data.totalDeleted,
      status: data.status ?? 'completed',
      error: null,
    });

    const saved = within ? await within.save(record) : await this.auditRepository.save(record);

    return saved.id;
  }
}

/** Sum the values of a per-table count map. */
function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/**
 * Normalise the affected-row count from a node-postgres DELETE, which TypeORM
 * surfaces as `[rows, affectedCount]`.
 */
function affectedRows(result: unknown): number {
  if (Array.isArray(result) && typeof result[1] === 'number') {
    return result[1];
  }

  return 0;
}

/** `work`, or a rejection once `ms` have passed without it settling. */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What `work` resolves to, or `null` once `ms` have passed; `work` itself carries on. */
function waitAtMost<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A second purge attempt's outcome, with what the first attempt already removed counted in. */
function mergeOutcomes(first: AccountPurgeOutcome, second: AccountPurgeOutcome): AccountPurgeOutcome {
  const add = (a: Record<string, number>, b: Record<string, number>) => {
    const sum = { ...a };
    for (const [table, count] of Object.entries(b)) {
      sum[table] = (sum[table] ?? 0) + count;
    }

    return sum;
  };

  return {
    ...second,
    deletedRows: add(first.deletedRows, second.deletedRows),
    detachedRows: add(first.detachedRows, second.detachedRows),
    deletedObjects: first.deletedObjects + second.deletedObjects,
  };
}
