import { UseGuards } from '@nestjs/common';
import { Context, Resolver, Subscription } from '@nestjs/graphql';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { PubSubService } from '@ci/common/pubsub';
import { Scopes, ScopesGuard, SCOPES } from '@ci/common/scopes';

import {
  EntityChangedPayload,
  MessageChangedPayload,
  SummaryChangedPayload,
} from '../types/SubscriptionPayloadType';

/**
 * The GraphQL context available on WebSocket connections after authentication.
 * The `userId` is extracted in the graphql-ws `onConnect` handler in the
 * Apollo driver config.
 */
interface SubscriptionContext {
  userId?: string;
}

/**
 * Raw shape published by DomainEventBridge onto PubSub topics.
 */
interface BridgePayload {
  event: string;
  payload: Record<string, unknown>;
  at: string;
}

/**
 * Plan 05 §3.2 — GraphQL subscriptions over graphql-ws.
 *
 * Three subscription fields are exposed:
 *
 *  - `messageStreamed` — any message change for the authenticated user's
 *    threads (topic `thread.<userId>.message`)
 *  - `entityChanged` — any memory entity change for the user
 *    (topic `entity.<userId>.*`)
 *  - `summaryReady` — any summary update for the user
 *    (topic `summary.<userId>`)
 *
 * Authentication: the `userId` is extracted from the JWT during the
 * graphql-ws `onConnect` handshake (see GraphQLModule config). Unauthenticated
 * connections are rejected at the transport layer, so by the time a resolver
 * runs the context always has a `userId`.
 *
 * For API-key callers the same `JwtOrApiKeyAuthGuard` + `ScopesGuard` guards
 * apply as on queries/mutations (scope `chat:read` / `memory:read`).
 */
@UseGuards(JwtOrApiKeyAuthGuard, ScopesGuard)
@Resolver()
export class SubscriptionResolver {
  constructor(private readonly pubsub: PubSubService) {}

  // ─── messageStreamed ───────────────────────────────────────────────────────

  @Scopes(SCOPES.CHAT_READ)
  @Subscription(() => MessageChangedPayload, {
    description:
      'Emitted whenever a message is created, updated, or deleted in any of the authenticated user threads.',
    resolve(rawValue: BridgePayload): MessageChangedPayload {
      const innerPayload = rawValue.payload as Record<string, unknown>;

      return {
        event: rawValue.event,
        at: rawValue.at,
        data: innerPayload,
        messageId: typeof innerPayload.messageId === 'string' ? innerPayload.messageId : undefined,
        threadId: typeof innerPayload.threadId === 'string' ? innerPayload.threadId : undefined,
      };
    },
  })
  messageStreamed(@Context() ctx: SubscriptionContext) {
    const userId = ctx.userId ?? 'anonymous';

    return asyncIterableToIterator(this.pubsub.iterate<BridgePayload>(`thread.${userId}.message`));
  }

  // ─── entityChanged ────────────────────────────────────────────────────────

  @Scopes(SCOPES.MEMORY_READ)
  @Subscription(() => EntityChangedPayload, {
    description:
      'Emitted whenever a memory entity (Person, Place, Concept) is created, updated, or deleted for the authenticated user.',
    resolve(rawValue: BridgePayload): EntityChangedPayload {
      const innerPayload = rawValue.payload as Record<string, unknown>;
      // Extract entity type from event name: "person.created" → "Person"
      const kind = rawValue.event.split('.')[0];
      const entityType = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : undefined;

      return {
        event: rawValue.event,
        at: rawValue.at,
        data: innerPayload,
        entityType,
      };
    },
  })
  entityChanged(@Context() ctx: SubscriptionContext) {
    const userId = ctx.userId ?? 'anonymous';

    return asyncIterableToIterator(this.pubsub.iterate<BridgePayload>(`entity.${userId}.*`));
  }

  // ─── summaryReady ─────────────────────────────────────────────────────────

  @Scopes(SCOPES.MEMORY_READ)
  @Subscription(() => SummaryChangedPayload, {
    description:
      'Emitted whenever a daily or weekly summary is written or updated for the authenticated user.',
    resolve(rawValue: BridgePayload): SummaryChangedPayload {
      return {
        event: rawValue.event,
        at: rawValue.at,
        data: rawValue.payload as Record<string, unknown>,
      };
    },
  })
  summaryReady(@Context() ctx: SubscriptionContext) {
    const userId = ctx.userId ?? 'anonymous';

    return asyncIterableToIterator(this.pubsub.iterate<BridgePayload>(`summary.${userId}`));
  }
}

/**
 * Convert an `AsyncIterable<T>` (from PubSubService.iterate) to the
 * `AsyncIterator<{ [subscriptionFieldName]: T }>` shape that Apollo/NestJS
 * GraphQL subscriptions expect. NestJS's `@Subscription` resolver uses the
 * return value directly as the source iterator; we keep it as an AsyncIterable
 * since Symbol.asyncIterator is accepted.
 *
 * The outer wrapper is needed because NestJS calls `Symbol.asyncIterator` on
 * the returned object at resolve time to get the actual iterator.
 */
function asyncIterableToIterator<T>(iterable: AsyncIterable<T>): AsyncIterator<T> {
  return iterable[Symbol.asyncIterator]();
}
