import { ForbiddenException, Injectable } from '@nestjs/common';

import { BlueBubblesApiClient, type BlueBubblesChat, type BlueBubblesMessage } from '@ci/domains/import';

import { BlueBubblesConfigService, serverAddressChanges } from './BlueBubblesConfigService';

export interface BlueBubblesTestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Stands in for the owner on the `messaging.*` tool schemas while the connector
 * has none, or before this process has read the row. It is not a uuid, so it
 * can never equal an account id: a tool owned by it is visible to nobody.
 */
export const UNOWNED_CONNECTOR = 'bluebubbles:unowned';

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

    if (!host || !port) {
      return { ok: false, error: 'Host and port are required.' };
    }

    // The saved password goes only to the saved server. A test against another address would
    // otherwise send the owner's credential to whatever host the caller typed.
    if (
      overrides.password == null &&
      config.password.length > 0 &&
      serverAddressChanges(config, { host, port, useHttps })
    ) {
      return { ok: false, error: 'Enter the password to test a different server address.' };
    }

    const password = overrides.password ?? config.password;

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
   * Who the `messaging.*` tools belong to, for their schemas' `ownerUserId`.
   *
   * The tool registry hides an owned tool from every other account and refuses
   * to run it for them, on the intents route, MCP and chat alike. This answer is
   * the process's last view of the row (see
   * `BlueBubblesConfigService.lastKnownOwnerUserId`); the database check in
   * {@link requireOwnersClient} is what actually decides each call.
   */
  toolOwnerUserId(): string {
    return this.configService.lastKnownOwnerUserId() ?? UNOWNED_CONNECTOR;
  }

  /**
   * A client built from the SAVED config for the connector's owner, refused for
   * anyone else and unless the connector is turned on. The gate the AI
   * messaging tools go through, as distinct from {@link testConnection} above.
   *
   * The owner check reads the row on every call. The registry already hides
   * and refuses these tools for other accounts, but it decides from a cached
   * owner; this is the answer from the database, and it holds even for a
   * caller that reaches the service some other way.
   */
  private async requireOwnersClient(callerUserId: string | undefined): Promise<BlueBubblesApiClient> {
    const config = await this.configService.find();

    if (config?.ownerUserId == null) {
      throw new Error('BlueBubbles is not set up. An administrator connects it in Settings first.');
    }

    if (callerUserId == null || config.ownerUserId !== callerUserId) {
      throw new ForbiddenException('BlueBubbles on this Companion is connected to another account.');
    }

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

  async listChats(callerUserId: string | undefined, maxResults = 25): Promise<BlueBubblesChat[]> {
    return (await this.requireOwnersClient(callerUserId)).queryChatsPage({ limit: maxResults });
  }

  async listMessages(
    callerUserId: string | undefined,
    chatGuid: string,
    maxResults = 25,
  ): Promise<BlueBubblesMessage[]> {
    return (await this.requireOwnersClient(callerUserId)).messagesForChat(chatGuid, maxResults);
  }

  async sendText(
    callerUserId: string | undefined,
    chatGuid: string,
    message: string,
  ): Promise<BlueBubblesMessage> {
    return (await this.requireOwnersClient(callerUserId)).sendText(chatGuid, message);
  }
}
