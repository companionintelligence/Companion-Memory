import { Controller, Delete, HttpCode, Param, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';

import { DataDeletionService } from '../services/DataDeletionService';

/**
 * The destructive per-connection disconnect endpoint (CASA ASVS V8).
 *
 * DELETE /connections/:id — revoke the connection's OAuth grant with the
 * provider (Google requires this; a local delete alone leaves the grant live),
 * then HARD-delete the connection and everything derived from it (its
 * communications, sync jobs, derived graph entities/relationships) and reap the
 * now-orphaned search-index rows. Owner-scoped and audit-logged.
 *
 * This supersedes the old ConnectionsController soft-delete (active=false), which
 * left the OAuth token stored and all derived data orphaned. It lives in the
 * privacy domain (not connections) so the connections domain has no dependency on
 * privacy — the DataDeletionService needs connections' ClientFactory, so the
 * dependency must run privacy -> connections only.
 */
@Controller('connections')
export class ConnectionPrivacyController {
  constructor(
    private readonly dataDeletionService: DataDeletionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConnectionPrivacyController.name);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async delete(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    // Owner-scoped inside the service: 404s if the connection is not the
    // caller's. Revokes the grant + purges derived data + audits.
    await this.dataDeletionService.disconnectConnection(serviceContext, id);
  }
}
