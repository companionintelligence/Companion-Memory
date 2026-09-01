import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';

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
 * Settings-page backend for the single appliance-wide BlueBubbles connection.
 * Guarded the same way `LlmEndpointController` is: any authenticated caller
 * (browser session JWT or an API key) may read/change this appliance's own
 * connection config.
 */
@Controller('bluebubbles')
export class BlueBubblesConfigController {
  constructor(
    private readonly configService: BlueBubblesConfigService,
    private readonly clientService: BlueBubblesClientService,
    private readonly syncService: BlueBubblesSyncService,
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
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('config')
  @HttpCode(200)
  async getConfig() {
    return this.projectConfig(await this.configService.getOrCreate());
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Put('config')
  @HttpCode(200)
  async updateConfig(@Body(new ValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    return this.projectConfig(await this.configService.update(body));
  }

  /** The one masked projection both config routes answer with. */
  private projectConfig(config: Awaited<ReturnType<BlueBubblesConfigService['getOrCreate']>>) {
    return {
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
  @UseGuards(JwtOrApiKeyAuthGuard)
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
  @UseGuards(JwtOrApiKeyAuthGuard)
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
