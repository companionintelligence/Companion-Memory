import { Field, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

/**
 * Base fields shared across all subscription event payloads.
 * The `data` field carries the raw event payload (varies by domain).
 */
@ObjectType({ isAbstract: true })
abstract class SubscriptionPayloadBase {
  @Field(() => String, {
    description: 'Internal event name, e.g. "message.created", "person.updated"',
  })
  event!: string;

  @Field(() => String, { description: 'ISO-8601 timestamp when the event was emitted' })
  at!: string;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Event-specific payload data' })
  data?: Record<string, unknown>;
}

/**
 * Yielded for `messageStreamed` — any message.created / message.updated /
 * message.deleted event within a user's threads.
 */
@ObjectType()
export class MessageChangedPayload extends SubscriptionPayloadBase {
  @Field(() => String, { nullable: true, description: 'ID of the changed message, if known' })
  messageId?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Thread scope. Today always the userId (threadId enrichment is a follow-up)',
  })
  threadId?: string;
}

/**
 * Yielded for `entityChanged` — any create/update/delete on a memory entity
 * (Person, Place, Concept, Item, Event, …).
 */
@ObjectType()
export class EntityChangedPayload extends SubscriptionPayloadBase {
  @Field(() => String, { nullable: true, description: 'Kind of the changed entity (e.g. "Person")' })
  entityType?: string;
}

/**
 * Yielded for `summaryReady` — a summary has been written or updated for the
 * user (daily/weekly card; used by the SPA and by agents watching for context).
 */
@ObjectType()
export class SummaryChangedPayload extends SubscriptionPayloadBase {}
