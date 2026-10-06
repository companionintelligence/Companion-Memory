/**
 * Privacy / user-data-deletion module (CASA ASVS V8: "the app can delete user
 * data upon request").
 *
 * Provides:
 *  - {@link DataDeletionService}: the owner-scoped, audit-logged, idempotent
 *    engine that revokes OAuth grants and purges all data derived from a
 *    connection (per-connection disconnect) or the entire account.
 *  - {@link PrivacyController}: POST /api/users/me/delete (full account
 *    deletion). Per-connection deletion is exposed via the existing
 *    DELETE /connections/:id (ConnectionsController delegates to this service).
 *
 * @module PrivacyModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApplianceAdminGuard } from '@ci/common/guards';
import { ConnectionsModule, ConnectionEntity } from '@ci/domains/connections';
import { SearchIngressModule } from '@ci/domains/search-ingress';
import { UserModule } from '@ci/domains/user';

import { ConnectionPrivacyController } from './controllers/ConnectionPrivacyController';
import { OutboundPolicyController } from './controllers/OutboundPolicyController';
import { PrivacyController } from './controllers/PrivacyController';
import { DataDeletionAuditEntity } from './entities/DataDeletionAuditEntity';
import { DataDeletionService } from './services/DataDeletionService';
import { OutboundPolicyService } from './services/OutboundPolicyService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ConnectionEntity, DataDeletionAuditEntity]),
    // ClientFactory (for OAuth revocation) comes from ConnectionsModule;
    // OrphanCleanupService (search-index reaping) from SearchIngressModule.
    // This dependency is one-directional (privacy -> connections): the
    // per-connection disconnect endpoint lives HERE, so the connections domain
    // never depends on privacy and there is no module cycle.
    ConnectionsModule,
    SearchIngressModule,
    // UserService, for the confirmation email `POST /users/me/delete` checks.
    UserModule,
  ],
  // ApplianceAdminGuard is registered so Nest resolves its DataSource here.
  providers: [DataDeletionService, OutboundPolicyService, ApplianceAdminGuard],
  controllers: [PrivacyController, ConnectionPrivacyController, OutboundPolicyController],
  exports: [DataDeletionService],
})
export class PrivacyModule {}

export { DataDeletionService } from './services/DataDeletionService';
export type { DisconnectResult, AccountDeletionResult } from './services/DataDeletionService';
export { DataDeletionAuditEntity } from './entities/DataDeletionAuditEntity';
export type { DataDeletionAudit } from './entities/DataDeletionAuditEntity';
