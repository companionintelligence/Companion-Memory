import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { LoggerService } from '@ci/common/logging';
import { PubSubService, type PubSubSubscription } from '@ci/common/pubsub';

interface ApiKeyAuthMarker {
  scopes: string[];
  keyId: string;
  actorId: string;
}

/**
 * Plan 01 §4.4 — wires the in-process pubsub bus to MCP resource update
 * notifications.
 *
 * Subscribes to the user-scoped topics emitted by DomainEventBridge and,
 * for each event, calls `server.server.sendResourceUpdated({ uri })`. An
 * agent that has issued `resources/subscribe memory://entity/...` then
 * receives a `notifications/resources/updated` push.
 *
 * Subscriptions are owned by the McpServer that registered them — when the
 * underlying transport closes (handled by McpController), the server is
 * disposed and the subscription is `unsubscribe()`d via the cleanup
 * function returned here.
 */
@Injectable()
export class McpResourceSubscriber {
  constructor(
    private readonly pubsub: PubSubService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(McpResourceSubscriber.name);
  }

  /**
   * Register resource bindings for the given server instance and start
   * forwarding pubsub events to the MCP transport. Returns a cleanup
   * function the caller invokes on transport close.
   */
  register(server: McpServer, req: Request): () => void {
    const userId = this.callerUserId(req);

    // Without an authenticated user we can't scope topics; skip wiring.
    if (!userId) {
      return () => undefined;
    }

    const subs: PubSubSubscription[] = [];

    // Entity-shaped events for this user. Every change to any kind
    // (Person/Place/Concept/...) becomes a `memory://entity/<userId>`
    // resource update. Agents that hold the list at that URI receive a push
    // and can re-read to get fresh content.
    subs.push(
      this.pubsub.subscribe(`entity.${userId}.*`, async () => {
        await this.send(server, `memory://entity/${userId}`);
      }),
    );

    // Per-thread message stream. Today the bridge publishes to
    // thread.<userId>.message because the legacy payload omits threadId; we
    // fan out to a single URI per user. A follow-up enriches the event with
    // threadId so we can scope to `memory://thread/<id>` directly.
    subs.push(
      this.pubsub.subscribe(`thread.${userId}.message`, async () => {
        await this.send(server, `memory://thread/${userId}/message`);
      }),
    );

    // Summary updates — important for the daily/weekly cards on the SPA and
    // for agents that watch "summary ready".
    subs.push(
      this.pubsub.subscribe(`summary.${userId}`, async () => {
        await this.send(server, `memory://summary/${userId}`);
      }),
    );

    this.logger.log('MCP resource subscriptions wired', {
      userId,
      count: subs.length,
    });

    return () => {
      for (const s of subs) {
        s.unsubscribe();
      }
    };
  }

  private async send(server: McpServer, uri: string): Promise<void> {
    try {
      await server.server.sendResourceUpdated({ uri });
    } catch (err) {
      this.logger.warn('Failed to send MCP resource update', {
        uri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private callerUserId(req: Request): string | undefined {
    const user = (req as { user?: { id?: string } }).user;
    if (user?.id) {
      return user.id;
    }

    const apiKeyAuth = (req as { apiKeyAuth?: ApiKeyAuthMarker }).apiKeyAuth;

    return apiKeyAuth?.actorId;
  }
}
