import { Injectable } from '@nestjs/common';

import { BlueBubblesApiClient, type BlueBubblesChat, type BlueBubblesMessage } from '@ci/domains/import';

import { BlueBubblesConfigService } from './BlueBubblesConfigService';

export interface BlueBubblesTestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** Connection fields a caller may override for a one-off test, without saving them. */
export interface BlueBubblesConnectionOverride {
  host?: string;
  port?: number;
  useHttps?: boolean;
  password?: string;
}

/**
 * NestJS-DI wrapper over {@link BlueBubblesApiClient} for callers that live in
 * the framework — the settings controller's test-connection route and the
 * `messaging.*` AI tools. Builds a fresh client from the stored config on
 * every call rather than caching one: the config can change between calls
 * (Settings save, a disable toggle) and a BlueBubbles connection is cheap to
 * open.
 */
@Injectable()
export class BlueBubblesClientService {
  constructor(private readonly configService: BlueBubblesConfigService) {}

  /**
   * Hit a cheap authenticated endpoint (`GET /server/info`) and report whether
   * it answered — used by the settings page's "Test connection" button.
   * Deliberately does NOT require `enabled`: the whole point is to validate
   * credentials before flipping that on, and can validate host/port/password
   * the caller hasn't saved yet via `overrides`.
   */
  async testConnection(
    overrides: BlueBubblesConnectionOverride = {},
  ): Promise<BlueBubblesTestConnectionResult> {
    const config = await this.configService.getOrCreate();
    const host = overrides.host ?? config.host;
    const port = overrides.port ?? config.port;
    const useHttps = overrides.useHttps ?? config.useHttps;
    const password = overrides.password ?? config.password;

    if (!host || !port) {
      return { ok: false, error: 'Host and port are required.' };
    }

    const client = new BlueBubblesApiClient({ host, port, useHttps, password });
    const startedAt = Date.now();

    try {
      await client.ping();

      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * A client built from the SAVED config, refused unless the connector is
   * turned on — the gate the AI messaging tools go through, as distinct from
   * {@link testConnection} above.
   */
  private async requireEnabledClient(): Promise<BlueBubblesApiClient> {
    const config = await this.configService.getOrCreate();

    if (!config.enabled) {
      throw new Error('BlueBubbles is not enabled. Turn it on in Settings first.');
    }

    if (!config.host || !config.port) {
      throw new Error('BlueBubbles is not configured. Set a host and port in Settings first.');
    }

    return new BlueBubblesApiClient({
      host: config.host,
      port: config.port,
      useHttps: config.useHttps,
      password: config.password,
    });
  }

  async listChats(maxResults = 25): Promise<BlueBubblesChat[]> {
    return (await this.requireEnabledClient()).queryChatsPage({ limit: maxResults });
  }

  async listMessages(chatGuid: string, maxResults = 25): Promise<BlueBubblesMessage[]> {
    return (await this.requireEnabledClient()).messagesForChat(chatGuid, maxResults);
  }

  async sendText(chatGuid: string, message: string): Promise<BlueBubblesMessage> {
    return (await this.requireEnabledClient()).sendText(chatGuid, message);
  }
}
