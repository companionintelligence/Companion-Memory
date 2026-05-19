import { Global, Module } from '@nestjs/common';

import { DomainEventBridge } from './listeners/DomainEventBridge';
import { PubSubService } from './PubSubService';

/**
 * Global so any domain can publish/subscribe without explicitly importing
 * PubSubModule. The actual transport is in-memory today (plan 05 §3.1);
 * swap-in for Postgres LISTEN happens transparently here when we go
 * multi-process.
 *
 * DomainEventBridge wires up on init and republishes every NestJS
 * EventEmitter event onto an actor-scoped pubsub topic so downstream
 * subscribers (MCP resource subscriptions, GraphQL subscriptions, SSE)
 * see entity/relationship/thread changes without each domain needing
 * to publish manually.
 */
@Global()
@Module({
  providers: [PubSubService, DomainEventBridge],
  exports: [PubSubService],
})
export class PubSubModule {}
