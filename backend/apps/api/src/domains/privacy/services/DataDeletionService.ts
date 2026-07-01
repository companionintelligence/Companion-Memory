import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  BaseOAuth2Client,
  ClientFactory,
  ConnectionEntity,
  type BaseClient,
  type Connection,
} from '@ci/domains/connections';
import { OrphanCleanupService } from '@ci/domains/search-ingress';

import {
  CONNECTION_SCOPED_TABLES,
  USER_OWNED_TABLES,
  type UserOwnedTable,
} from '../dataDeletionPlan';
import { DataDeletionAuditEntity } from '../entities/DataDeletionAuditEntity';

/** Result of a single per-connection disconnect + purge. */
export interface DisconnectResult {
  connectionId: string;
  providerId: string | null;
  /** Whether the provider accepted the OAuth token for revocation. */
  tokenRevoked: boolean;
  /** Per-table row counts purged (e.g. { "ci.communications": 42 }). */
  deletedCounts: Record<string, number>;
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
    private readonly logger: LoggerService,
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
  async disconnectConnection(
    context: UserServiceContext,
    connectionId: string,
  ): Promise<DisconnectResult> {
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

    for (const scoped of CONNECTION_SCOPED_TABLES) {
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
    const graphEntities = await this.deleteGraphByConnection(
      'entities',
      context.userId,
      connectionId,
    );
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
    });

    return { connectionId, providerId, tokenRevoked, deletedCounts, totalDeleted, auditId };
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
      revocations.push({ connectionId: connection.id, providerId: connection.providerId ?? null, tokenRevoked });
    }

    // 2) Purge every user-owned table, children before parents.
    const deletedCounts: Record<string, number> = {};

    // Special-case: ci_search.entity_tag has no user_id; delete its rows that
    // reference this user's tags BEFORE we delete ci_search.tags.
    const entityTagDeleted = await this.deleteEntityTagsForUser(userId);
    if (entityTagDeleted > 0) {
      deletedCounts['ci_search.entity_tag'] = entityTagDeleted;
    }

    for (const table of USER_OWNED_TABLES) {
      const count = await this.deleteUserOwned(table, userId);
      if (count > 0) {
        deletedCounts[`${table.schema}.${table.table}`] = count;
      }
    }

    // 3) Delete the user row itself. With every RESTRICT child already gone and
    // the CASCADE children handled above, this now succeeds (previously it would
    // fail on the first RESTRICT FK — the bug this feature fixes).
    const userDeletedCount = await this.deleteWhere('ci', 'users', 'id', userId);
    const userDeleted = userDeletedCount > 0;
    if (userDeletedCount > 0) {
      deletedCounts['ci.users'] = userDeletedCount;
    }

    // 4) Reap any search-index rows whose source rows we deleted.
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
      userDeleted,
    });

    return { userId, revocations, deletedCounts, totalDeleted, userDeleted, auditId };
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

    try {
      // revoke() reads only { id, accessToken, refreshToken }; pass those
      // directly rather than routing through ConnectionEntity.toEgressType (which
      // would require the provider/user relations to be fully hydrated).
      const { revoked } = await client.revoke({
        id: connection.id,
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
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

  /** DELETE ... WHERE <column> = <value>, returning the affected row count. */
  private async deleteWhere(
    schema: string,
    table: string,
    column: string,
    value: string,
  ): Promise<number> {
    // schema/table/column come exclusively from the trusted internal deletion
    // plan (never request input); the value is always a bound parameter.
    const result = await this.dataSource.query(
      `DELETE FROM "${schema}"."${table}" WHERE "${column}" = $1`,
      [value],
    );

    return affectedRows(result);
  }

  private async deleteUserOwned(table: UserOwnedTable, userId: string): Promise<number> {
    try {
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

/** True for Postgres error 42P01 (undefined_table) / 3F000 (invalid_schema). */
function isUndefinedTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;

  return code === '42P01' || code === '3F000';
}
