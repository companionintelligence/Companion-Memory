import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod/v3';

import { Context, type RequestContext } from '@ci/common/context';
import { FULL_CAPABILITY, READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import {
  ApplianceAdminGuard,
  type ApiKeyScopedRequest,
  apiKeyCapabilityOf,
  JwtOrApiKeyAuthGuard,
} from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';

import type { BlueBubblesConfigEntity } from '../entities/BlueBubblesConfigEntity';
import { BlueBubblesClientService } from '../services/BlueBubblesClientService';
import { BlueBubblesConfigService } from '../services/BlueBubblesConfigService';
import { BlueBubblesSyncService } from '../services/BlueBubblesSyncService';

const updateSchema = z.object({
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  useHttps: z.boolean(),
  // Omitted (undefined) keeps the existing stored password — the same
  // "blank means unchanged" contract ApiKeysSection/LlmEndpointController use
  // for a secret field, so a settings save never has to re-send it back.
  password: z.string().trim().min(1).optional(),
  hasPrivateApi: z.boolean(),
  enabled: z.boolean(),
});

/** The route `BlueBubblesWebhookController` serves, as the user must type it into BlueBubbles. */
function webhookPathFor(secret: string): string {
  return `/api/bluebubbles/webhook/${secret}`;
}

/**
 * What every signed-in account may know about the connector: whether it is on
 * and when it last saw a message, which is all the Connect page's BlueBubbles
 * card shows. Nothing that locates the owner's Mac (host, port, an error that
 * quotes them) and nothing that acts as a credential (the webhook path).
 */
export interface BlueBubblesStatusView {
  canEdit: false;
  enabled: boolean;
  connectionStatus: BlueBubblesConfigEntity['connectionStatus'];
  lastSyncCursor: Date | null;
  lastWebhookReceivedAt: Date | null;
}

/**
 * Settings-page backend for the single appliance-wide BlueBubbles connection.
 *
 * Changing it, testing it, syncing it and rotating its webhook secret are the
 * administrator's ({@link ApplianceAdminGuard}). Reading it is open to any
 * signed-in caller, but only an administrator gets the full settings back;
 * everyone else gets {@link BlueBubblesStatusView}.
 */
@Controller('bluebubbles')
export class BlueBubblesConfigController {
  constructor(
    private readonly configService: BlueBubblesConfigService,
    private readonly clientService: BlueBubblesClientService,
    private readonly syncService: BlueBubblesSyncService,
    private readonly applianceAdminGuard: ApplianceAdminGuard,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BlueBubblesConfigController.name);
  }

  /**
   * Masked view: `hasPassword` stands in for the raw `password` column, which
   * never leaves the server — mirrors ApiKeysSection's prefix-only-never-
   * full-secret convention (see BlueBubblesConfigEntity's password field doc).
   *
   * `webhookPath` is the deliberate exception, and it is a credential: the
   * secret IS the webhook's auth. It has to leave the server because the whole
   * live-ingestion half of this feature is unreachable without it — no endpoint
   * returned it and no frontend read it, so constructing the URL BlueBubbles
   * must be pointed at required a query against Postgres, which in practice
   * means nobody configured a webhook and the "backstop, not the primary
   * ingestion path" cron was the only path. A PATH rather than an absolute URL:
   * the appliance is reached at whatever address the browser used (LAN IP,
   * `.localhost`, a tailnet name), and guessing that server-side is how a user
   * gets handed a URL their Mac cannot resolve.
   *
   * Because it is a credential, it goes to administrators only. Anyone holding
   * it can post messages that are filed in the connector owner's memory, so
   * handing it to every account (and every read-only API key) turned read
   * access into write access on someone else's data. The same answer decides
   * host, port and `lastError`, which locate the owner's Mac. Everyone else
   * gets {@link BlueBubblesStatusView}.
   *
   * So does an administrator's read-only API key. The secret lets its holder
   * write into the owner's memory, which a read key is not allowed to do. The
   * settings page signs in with a session and the native apps hold full keys,
   * so both still get the full settings.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('config')
  @HttpCode(200)
  async getConfig(
    @Req()
    request: Pick<ApiKeyScopedRequest, 'apiKeyScopes' | 'apiKeyCapability'> & {
      user?: { role?: string };
    },
  ) {
    let isAdmin = false;

    try {
      isAdmin =
        apiKeyCapabilityOf(request as ApiKeyScopedRequest) !== READ_CAPABILITY &&
        (await this.applianceAdminGuard.admits(request.user));
    } catch {
      // The admin probe fails closed: unknown means "not an administrator".
    }

    if (!isAdmin) {
      // `find`, not `getOrCreate`: a read by somebody who cannot configure the
      // connector has no business minting its row (and its webhook secret).
      return this.projectStatus(await this.configService.find());
    }

    return this.projectConfig(await this.configService.getOrCreate());
  }

  // The BlueBubbles configuration is one row for the whole appliance, and `test-connection`
  // makes the appliance dial an arbitrary host:port and report back. Both are the
  // administrator's. Reading is open to everyone, at the reduced view above.
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @Put('config')
  @HttpCode(200)
  async updateConfig(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    // The saving administrator becomes the connector's owner when it has none;
    // see BlueBubblesConfigService.update for when an existing owner stays.
    return this.projectConfig(await this.configService.update(body, context.userId!));
  }

  /**
   * Issue a new webhook secret. The URL BlueBubbles Server was given stops
   * working at once, so the settings page asks before calling this and then
   * shows the new URL to paste in. Full capability, like the other switches
   * that change something for the whole appliance: a write key should not be
   * able to cut off the owner's live messages.
   */
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @RequireCapability(FULL_CAPABILITY)
  @Post('rotate-webhook-secret')
  @HttpCode(200)
  async rotateWebhookSecret() {
    return this.projectConfig(await this.configService.rotateWebhookSecret());
  }

  /** What a caller who is not an administrator gets back. See {@link BlueBubblesStatusView}. */
  private projectStatus(config: BlueBubblesConfigEntity | null): BlueBubblesStatusView {
    return {
      canEdit: false,
      enabled: config?.enabled ?? false,
      connectionStatus: config?.connectionStatus ?? 'unknown',
      lastSyncCursor: config?.lastSyncCursor ?? null,
      lastWebhookReceivedAt: config?.lastWebhookReceivedAt ?? null,
    };
  }

  /** The masked projection every administrator-facing route answers with. */
  private projectConfig(config: BlueBubblesConfigEntity) {
    return {
      canEdit: true as const,
      host: config.host,
      port: config.port,
      useHttps: config.useHttps,
      hasPassword: config.password.length > 0,
      hasPrivateApi: config.hasPrivateApi,
      enabled: config.enabled,
      webhookPath: webhookPathFor(config.webhookSecret),
      connectionStatus: config.connectionStatus,
      lastError: config.lastError,
      lastSyncCursor: config.lastSyncCursor,
      lastWebhookReceivedAt: config.lastWebhookReceivedAt,
    };
  }

  /**
   * Cheap authenticated round trip against the server the caller describes —
   * saved config when the field is omitted, an in-flight edit otherwise, so
   * the settings page can validate host/port/password before "Save".
   * Persists nothing.
   */
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @Post('test-connection')
  @HttpCode(200)
  async testConnection(
    @Body(
      new ValidationPipe(
        z.object({
          host: z.string().trim().min(1).optional(),
          port: z.coerce.number().int().min(1).max(65535).optional(),
          useHttps: z.boolean().optional(),
          password: z.string().trim().min(1).optional(),
        }),
      ),
    )
    body: {
      host?: string;
      port?: number;
      useHttps?: boolean;
      password?: string;
    },
  ) {
    return this.clientService.testConnection(body);
  }

  /** Kick off one sync pass immediately — the "Sync now" button. */
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @Post('sync-now')
  @HttpCode(202)
  async syncNow() {
    // Fire-and-forget: a full pass can outlast an HTTP request, and its
    // progress is already visible in the Import Runs UI (see
    // BlueBubblesSyncService's per-call audit run) rather than in this
    // response. `runSync` itself records failures onto the config row
    // (connection_status/last_error); the `.catch` here only guards against
    // an unhandled rejection surfacing anything thrown before that recording
    // could happen (e.g. a dead database connection).
    void this.syncService.runSync().catch((err: unknown) => {
      this.logger.error('BlueBubbles sync-now failed', err instanceof Error ? err : new Error(String(err)));
    });

    return { started: true };
  }
}
