/**
 * This module provides a centralized event bus for the application, enabling
 * a decoupled architecture where different domains can communicate asynchronously.
 * It uses a job queue for reliable, persistent event handling while also
 * surfacing operational insights for monitoring.
 *
 * ### Key Components:
 * - **EventService**: The core service for publishing events to specific queues.
 * - **JobMonitorService**: Provides read-only access to PgBoss tables so the UI
 *   can surface queue health without reaching into the database directly.
 * - **`@OnEvent` Decorator**: A custom decorator used to subscribe a method
 *   within a service to a specific event. When the event is published, the
 *   decorated method is automatically invoked.
 * - **Event Registry (`event-registry`)**: A central definition of all application
 *   events and their corresponding payload types, ensuring type safety.
 * - **Queues**: Defines the different job queues used for processing events,
 *   allowing for prioritization and separation of concerns.
 *
 * @module EventsModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JobsController } from './controllers/JobsController';
import { CronRunEntity } from './entities/CronRunEntity';
import { JobMetricEntity } from './entities/JobMetricEntity';
import { PgBossArchiveEntity } from './entities/PgBossArchiveEntity';
import { PgBossJobEntity } from './entities/PgBossJobEntity';
import { PgBossQueueEntity } from './entities/PgBossQueueEntity';
import { PgBossScheduleEntity } from './entities/PgBossScheduleEntity';
import { CronRunTracker } from './services/CronRunTracker';
import { EventService } from './services/EventService';
import { JobMetricsCollector } from './services/JobMetricsCollector';
import { JobMonitorService } from './services/JobMonitorService';
import { JobQueryService } from './services/JobQueryService';
import { LocalEventService } from './services/LocalEventService';
import { PGBossEventService } from './services/PGBossEventService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PgBossJobEntity,
      PgBossArchiveEntity,
      PgBossScheduleEntity,
      PgBossQueueEntity,
      JobMetricEntity,
      CronRunEntity,
    ]),
  ],
  providers: [
    {
      provide: EventService,
      useClass: PGBossEventService,
    },
    JobMonitorService,
    JobQueryService,
    JobMetricsCollector,
    CronRunTracker,
  ],
  controllers: [JobsController],
  exports: [EventService],
})
export class EventsModule {}

// PGBossEventService rides along because it owns the enqueue-side guard against
// keyless sends to a de-duplicating queue, and the specs that assert a queue is
// defended live in the domain that declares the queue (see
// `domains/__tests__/support/queuePolicyGuardProbe.ts`).
export { EventService, LocalEventService, PGBossEventService };
export { OnEvent } from './decorators/OnEvent';
export { Events, type EventPayloads } from './event-registry';
export type { EventRegistry } from './registry';
export type { Acknowledgement, EventSendOptions, QueueOptions } from './types';
// The priority tiers are part of the events domain's public surface: any domain
// that enqueues work has to be able to say whether it is interactive or a
// backfill. Exporting them here keeps callers off `events/constants` directly,
// which the no-cross-domain-internals dependency rule forbids.
export { DEFAULT_JOB_PRIORITY, INTERACTIVE_JOB_PRIORITY, BACKFILL_JOB_PRIORITY } from './constants';
// EventListenerRegistry is the live record of `@OnEvent` queue declarations.
// Other domains' tests assert policy/role off it; exporting here keeps them
// off `events/event-registration` internals (no-cross-domain-internals).
export { defineEvent, EventListenerRegistry } from './event-registration';
