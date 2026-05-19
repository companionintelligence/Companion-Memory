import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { PubSubService } from '../PubSubService';

/**
 * Plan 05 — bridge the existing in-process domain event bus
 * (NestJS EventEmitter, used by LocalEventService) onto PubSubService topics
 * so MCP resource subscriptions, GraphQL subscriptions, and SSE consumers
 * receive every entity/relationship/message/summary change.
 *
 * Strategy: `onAny` over the EventEmitter, then translate the queue-suffixed
 * event names emitted by LocalEventService back to their plain name and route
 * to an actor-scoped pubsub topic.
 *
 * Topic conventions (per plan 05 §3.1):
 *  - person.created           → entity.<userId>.Person
 *  - place.created            → entity.<userId>.Place
 *  - concept.created          → entity.<userId>.Concept
 *  - <kind>.<verb>            → entity.<userId>.<Kind> (capitalized)
 *  - message.created          → thread.<unknown>.message  (threadId not in payload — see below)
 *
 * The thread case is special: the payload carries `messageId` but not
 * `threadId`. Without the threadId we can't scope the topic. We publish to
 * `thread.<userId>.message` as a fallback so per-actor scoping still holds;
 * a follow-up enriches the event payload with the threadId so per-thread
 * subscriptions work.
 */
@Injectable()
export class DomainEventBridge implements OnModuleInit {
  constructor(
    private readonly emitter: EventEmitter2,
    private readonly pubsub: PubSubService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DomainEventBridge.name);
  }

  onModuleInit(): void {
    this.emitter.onAny((rawName: string | string[], payload: unknown) => {
      // EventEmitter2 emits `name:queue` after LocalEventService routes; also
      // accepts array forms when `wildcard: true`.
      const name = Array.isArray(rawName) ? rawName.join('.') : rawName;
      const baseName = name.split(':')[0];

      this.handle(baseName, payload).catch((err) => {
        this.logger.warn('DomainEventBridge handler threw', {
          event: baseName,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.logger.log('DomainEventBridge listening');
  }

  private async handle(eventName: string, payload: unknown): Promise<void> {
    const userId = ContextService.getUserId();
    // No user in context = system or pre-auth event; we still publish to a
    // wildcard-friendly system topic so admin tooling can observe.
    const ownerSegment = userId ?? 'system';

    const topic = this.mapToTopic(eventName, ownerSegment);
    if (!topic) {
      return;
    }

    await this.pubsub.publish(topic, { event: eventName, payload, at: new Date().toISOString() });
  }

  /**
   * Translate an internal event name to a pubsub topic. Returns null when an
   * event isn't agent-relevant (cron internals, ack-only events, etc.).
   */
  private mapToTopic(eventName: string, owner: string): string | null {
    // entity-shaped events: <kind>.<verb>
    const memoryKinds: Record<string, string> = {
      person: 'Person',
      place: 'Place',
      concept: 'Concept',
      item: 'Item',
      event: 'Event',
      communication: 'Communication',
      content: 'Content',
      note: 'Note',
    };

    const [kind, verb] = eventName.split('.', 2);
    if (
      kind &&
      verb &&
      memoryKinds[kind] &&
      (verb === 'created' || verb === 'updated' || verb === 'deleted')
    ) {
      return `entity.${owner}.${memoryKinds[kind]}`;
    }

    if (
      eventName === 'message.created' ||
      eventName === 'message.updated' ||
      eventName === 'message.deleted'
    ) {
      return `thread.${owner}.message`;
    }

    if (eventName === 'thread.created' || eventName === 'thread.updated' || eventName === 'thread.deleted') {
      return `thread.${owner}`;
    }

    if (kind === 'relationship') {
      return `relationship.${owner}`;
    }

    if (kind === 'summary' || eventName.endsWith('.summary.ready')) {
      return `summary.${owner}`;
    }

    return null;
  }
}
