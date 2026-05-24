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
import { PgBossArchiveEntity } from './entities/PgBossArchiveEntity';
import { PgBossJobEntity } from './entities/PgBossJobEntity';
import { PgBossQueueEntity } from './entities/PgBossQueueEntity';
import { PgBossScheduleEntity } from './entities/PgBossScheduleEntity';
import { EventService } from './services/EventService';
import { JobMonitorService } from './services/JobMonitorService';
import { LocalEventService } from './services/LocalEventService';
import { PGBossEventService } from './services/PGBossEventService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PgBossJobEntity, PgBossArchiveEntity, PgBossScheduleEntity, PgBossQueueEntity]),
  ],
  providers: [
    {
      provide: EventService,
      useClass: PGBossEventService,
    },
    JobMonitorService,
  ],
  controllers: [JobsController],
  exports: [EventService],
})
export class EventsModule {}

export { EventService, LocalEventService };
export { OnEvent } from './decorators/OnEvent';
export { Events, type EventPayloads } from './event-registry';
export { defineEvent } from './event-registration';
