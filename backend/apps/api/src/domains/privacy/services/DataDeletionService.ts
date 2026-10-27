import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
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
import { deleteSoleOwnedObjects, PURGE_OBJECT_STORE, type PurgeObjectStore } from '@ci/domains/user';

import {
  CONNECTION_SCOPED_TABLES,
  USER_OWNED_TABLES,
  type ConnectionScopedTable,
  type UserOwnedTable,
} from '../dataDeletionPlan';
import { DataDeletionAuditEntity } from '../entities/DataDeletionAuditEntity';

/** Objects read and deleted per page: one S3 DeleteObjects call's worth. */
const OBJECT_PAGE_SIZE = 1000;

/**
 * How long an account delete waits on the object store. The S3 client sets no
 * timeout of its own, and the delete runs while `handOverAdministration` holds
 * the lock every account creation takes, so a hung store must not hold that
 * lock for good. The same bound a file purge uses
 * (`STORED_OBJECT_DELETE_DEADLINE_MS` in `memory/services/filePurge.ts`).
 */
export const OBJECT_DELETE_DEADLINE_MS = 60_000;

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
  /** Per-connection revocation outcome, keyed by connection id. */
  revocations: Array<{ connectionId: string; providerId: string | null; tokenRevoked: boolean }>;
  /** Per-table row counts purged across every user-owned table. */
  deletedCounts: Record<string, number>;
  totalDeleted: number;
  /** Stored file objects removed from the object store. */
  deletedObjects: number;
  /** True once the ci.users row itself has been removed. */
  userDeleted: boolean;
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
 *     grant, then purge every user-owned table (people/places/concepts graph,
 *     communications, events, files, embeddings, summaries, notes, agent memory,
 *     sessions, api keys, provider credentials, …) in FK-safe order, delete the
 *     user row, and truncate the user's search-index footprint.
 *
 * Both are owner-scoped, audit-logged (ci.data_deletion_audit), and idempotent:
 * re-running after a completed deletion finds nothing to delete and simply writes
 * a fresh zero-count audit row (or, for a disconnect, 404s if the connection is
 * already gone).
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
    /** The bytes behind `ci.files` rows. Optional so a module without the files domain still builds. */
    @Optional() @Inject(PURGE_OBJECT_STORE) private readonly objectStore?: PurgeObjectStore,
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
   * Delete the whole account: revoke every connection grant, purge every
   * user-owned table in FK-safe order, delete the user row, and clear the
   * search-index footprint. Idempotent.
   */
  async deleteAccount(context: UserServiceContext): Promise<AccountDeletionResult> {
    const userId = context.userId;

    // 1) Revoke every connection's OAuth grant first (best-effort), so access
    // stops on the provider side even if the local purge is interrupted.
    const connections = await this.connectionRepository.find({
      where: { userId },
      relations: ['provider'],
    });

    const revocations: AccountDeletionResult['revocations'] = [];
    for (const connection of connections) {
      const tokenRevoked = await this.revokeConnectionGrant(connection);
      revocations.push({
        connectionId: connection.id,
        providerId: connection.providerId ?? null,
        tokenRevoked,
      });
    }

    // 2) The bytes of the account's files, before the rows that point at them,
    // as the 30-day purge does: if the purge below stops part way, the rows are
    // still there to find the keys again, while the other order would strand
    // the bytes in the bucket for good.
    const deletedObjects = await this.deleteFileObjects(userId);

    // 3) Purge every user-owned table, children before parents.
    const deletedCounts: Record<string, number> = {};

    // Special-case: ci_search.entity_tag has no user_id; delete its rows that
    // reference this user's tags BEFORE we delete ci_search.tags.
    const entityTagDeleted = await this.deleteEntityTagsForUser(userId);
    if (entityTagDeleted > 0) {
      deletedCounts['ci_search.entity_tag'] = entityTagDeleted;
    }

    for (const table of USER_OWNED_TABLES) {
      // The user row points at the account's own "You" person, which this
      // deletes; see deleteEntitiesUnlinkingSelf.
      const count =
        table.schema === 'ci' && table.table === 'entities'
          ? await this.deleteEntitiesUnlinkingSelf(userId)
          : await this.deleteUserOwned(table, userId);
      if (count > 0) {
        deletedCounts[`${table.schema}.${table.table}`] = count;
      }
    }

    // 4) Delete the user row itself. With every RESTRICT child already gone and
    // the CASCADE children handled above, this now succeeds (previously it would
    // fail on the first RESTRICT FK — the bug this feature fixes).
    const userDeletedCount = await this.deleteWhere('ci', 'users', 'id', userId);
    const userDeleted = userDeletedCount > 0;
    if (userDeletedCount > 0) {
      deletedCounts['ci.users'] = userDeletedCount;
    }

    // 5) Reap any search-index rows whose source rows we deleted.
    await this.cleanupSearchIndex();

    const totalDeleted = sumCounts(deletedCounts);

    const auditId = await this.writeAudit({
      subjectUserId: userId,
      requestedByUserId: userId,
      scope: 'account',
      connectionId: null,
      providerId: null,
      tokenRevoked: revocations.some((r) => r.tokenRevoked),
      deletedCounts,
      totalDeleted,
    });

    this.logger.log('Account deleted and all derived data purged', {
      userId,
      connectionsRevoked: revocations.length,
      totalDeleted,
      deletedObjects,
      userDeleted,
    });

    return { userId, revocations, deletedCounts, totalDeleted, deletedObjects, userDeleted, auditId };
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

  /** DELETE ... WHERE <column> = <value>, returning the affected row count. */
  private async deleteWhere(schema: string, table: string, column: string, value: string): Promise<number> {
    // schema/table/column come exclusively from the trusted internal deletion
    // plan (never request input); the value is always a bound parameter.
    const result = await this.dataSource.query(`DELETE FROM "${schema}"."${table}" WHERE "${column}" = $1`, [
      value,
    ]);

    return affectedRows(result);
  }

  private async deleteUserOwned(table: UserOwnedTable, userId: string): Promise<number> {
    try {
      if (table.through) {
        return await this.deleteThroughParent(table, table.through, userId);
      }

      return await this.deleteWhere(table.schema, table.table, table.userColumn, userId);
    } catch (error) {
      // A table in the plan may not exist in every deployment (e.g. the hbpe
      // schema is only present when the prediction engine is installed). Treat a
      // missing relation as "nothing to delete" rather than failing the whole
      // account deletion; re-throw anything else.
      if (isUndefinedTableError(error)) {
        return 0;
      }

      throw error;
    }
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

  /** Delete the rows of a table with no user column, through the parent rows the user owns. */
  private async deleteThroughParent(
    table: UserOwnedTable,
    through: NonNullable<UserOwnedTable['through']>,
    userId: string,
  ): Promise<number> {
    // Every identifier comes from the trusted internal deletion plan (never
    // request input); the user id is a bound parameter.
    const result = await this.dataSource.query(
      `DELETE FROM "${table.schema}"."${table.table}" t
        USING "${through.parentSchema}"."${through.parentTable}" p
        WHERE t."${through.column}" = p."${through.parentKey}"
          AND p."${table.userColumn}" = $1`,
      [userId],
    );

    return affectedRows(result);
  }

  /**
   * Remove from the object store the bytes of every file only this account
   * points at. File rows are deduplicated on content, so an object another
   * account's row also names stays: deleting it would lose that account's file.
   */
  private async deleteFileObjects(userId: string): Promise<number> {
    try {
      if (!this.objectStore) {
        const [{ count }] = (await this.dataSource.query(
          `SELECT count(*)::int AS count FROM "ci"."files" WHERE user_id = $1 AND key IS NOT NULL`,
          [userId],
        )) as Array<{ count: number }>;

        if (count > 0) {
          this.logger.warn('No object store wired into account deletion; stored file objects will remain', {
            userId,
            objects: count,
          });
        }

        return 0;
      }

      // Nothing in the database is touched yet, so giving up here leaves the
      // account whole apart from any objects already gone; deleting again is safe.
      return await withDeadline(
        deleteSoleOwnedObjects(this.dataSource, this.objectStore, userId, OBJECT_PAGE_SIZE),
        OBJECT_DELETE_DEADLINE_MS,
      );
    } catch (error) {
      // Same tolerance as the table purge: a deployment without ci.files has no objects.
      if (isUndefinedTableError(error)) {
        return 0;
      }

      throw error;
    }
  }

  /**
   * ci.entities, once the user row no longer points into it. `ci.users.entity_id`
   * names the account's own "You" person with no cascade, so the pointer has to
   * be cleared first or the delete is refused. Both statements share one
   * transaction: the UPDATE holds the user row's lock until the delete commits,
   * so a graph ingest still running for this account (`ensureSelfEntity` sets the
   * pointer whenever it finds it NULL) waits instead of re-linking it in between
   * and failing the delete after most of the account is already gone.
   */
  private async deleteEntitiesUnlinkingSelf(userId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE "ci"."users" SET "entity_id" = NULL WHERE "id" = $1`, [userId]);

      const result = await manager.query(`DELETE FROM "ci"."entities" WHERE "owner_user_id" = $1`, [userId]);

      return affectedRows(result);
    });
  }

  /** Delete ci_search.entity_tag rows referencing this user's tags. */
  private async deleteEntityTagsForUser(userId: string): Promise<number> {
    const result = await this.dataSource.query(
      `DELETE FROM "ci_search"."entity_tag" et
        USING "ci_search"."tags" t
        WHERE et.tag_id = t.id
          AND t.user_id = $1`,
      [userId],
    );

    return affectedRows(result);
  }

  /**
   * Reap search-index rows (ci_search.embeddings / vectors) whose source row no
   * longer exists. We already delete each user's own index rows by user_id in the
   * plan; this catches rows keyed only by (entity_type, entity_id) whose backing
   * ci.* row we removed. Best-effort — logged, never fatal to the deletion.
   */
  private async cleanupSearchIndex(): Promise<void> {
    try {
      await this.orphanCleanupService.cleanOrphans();
    } catch (error) {
      this.logger.error('Search-index orphan cleanup after deletion failed (non-fatal)', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async writeAudit(data: {
    subjectUserId: string;
    requestedByUserId: string;
    scope: 'connection' | 'account';
    connectionId: string | null;
    providerId: string | null;
    tokenRevoked: boolean | null;
    deletedCounts: Record<string, number>;
    totalDeleted: number;
  }): Promise<string> {
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
      status: 'completed',
      error: null,
    });

    const saved = await this.auditRepository.save(record);

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
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The object store did not answer within ${ms / 1000} s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** True for Postgres error 42P01 (undefined_table) / 3F000 (invalid_schema). */
function isUndefinedTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;

  return code === '42P01' || code === '3F000';
}
