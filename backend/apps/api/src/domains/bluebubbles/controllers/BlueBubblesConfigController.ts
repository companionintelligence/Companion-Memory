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
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('config')
  @HttpCode(200)
  async getConfig() {
    const config = await this.configService.getOrCreate();

    return {
      host: config.host,
      port: config.port,
      useHttps: config.useHttps,
      hasPassword: config.password.length > 0,
      hasPrivateApi: config.hasPrivateApi,
      enabled: config.enabled,
      connectionStatus: config.connectionStatus,
      lastError: config.lastError,
      lastSyncCursor: config.lastSyncCursor,
      lastWebhookReceivedAt: config.lastWebhookReceivedAt,
    };
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Put('config')
  @HttpCode(200)
  async updateConfig(@Body(new ValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    const config = await this.configService.update(body);

    return {
      host: config.host,
      port: config.port,
      useHttps: config.useHttps,
      hasPassword: config.password.length > 0,
      hasPrivateApi: config.hasPrivateApi,
      enabled: config.enabled,
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
