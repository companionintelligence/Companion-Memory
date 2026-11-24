import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EventService } from '@ci/domains/events';
import {
  CalendarEventService,
  EVENT_LOCATION_REOPENER,
  EVENT_STATUS_REOPENER,
  EVENT_TIME_REOPENER,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  resolveEventLocationReopener,
  resolveEventStatusReopener,
  resolveEventTimeReopener,
} from '@ci/domains/memory';

import { EventLocationReopenService } from '../services/EventLocationReopenService';
import { EventStatusReopenService } from '../services/EventStatusReopenService';
import { EventTimeReopenService } from '../services/EventTimeReopenService';
import { PipelineStateService } from '../services/PipelineStateService';
import { StageRegistry } from '../services/StageRegistry';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CALENDAR SERVICE REACHES THE PIPELINE'S RE-OPENERS THROUGH NEST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CalendarEventService` takes `@Optional() ModuleRef` and resolves
 * `EVENT_TIME_REOPENER`, `EVENT_STATUS_REOPENER` and `EVENT_LOCATION_REOPENER`
 * lazily with `moduleRef.get(token, { strict: false })`. It has to: `PipelineModule`
 * imports `MemoryModule`, so the reverse import would be a cycle. Every other
 * spec of the service hands it a hand-built ModuleRef, which agrees with the
 * service unconditionally and cannot tell whether Nest ever constructs it that
 * way. It matters more than it did: since a person's `update`, `reschedule` and
 * a status change ask too, an unbound token is not a gap in a background sync
 * but every edit of an event's time failing.
 *
 * What only Nest's own injector can show, with the REAL classes:
 *
 *  1. the service is constructible by Nest and receives a ModuleRef (decorator
 *     metadata survives the swc build, `@Optional()` does not demote it);
 *  2. a `useExisting` token declared in a SIBLING module, which does not import
 *     the service's module and is not imported by it, resolves to the real
 *     re-opener from that ModuleRef. This is the shape `PipelineModule` and
 *     `MemoryModule` have;
 *  3. without the binding the failure names the token. `stageWiring.spec`
 *     checks the real `PipelineModule` declares exactly these bindings.
 */

/** The calendar service's module: its real class, stand-ins for what it injects. */
@Module({
  providers: [
    CalendarEventService,
    { provide: getRepositoryToken(EventEntity), useValue: {} },
    { provide: getRepositoryToken(EventBaseEntity), useValue: {} },
    { provide: EventService, useValue: { send: jest.fn() } },
    { provide: DataSource, useValue: {} },
    { provide: GraphDeltaWriter, useValue: {} },
  ],
})
class CalendarModule {}

/** The pipeline's module, as far as these bindings go: the real services and the real token shapes. */
@Module({
  providers: [
    EventTimeReopenService,
    { provide: EVENT_TIME_REOPENER, useExisting: EventTimeReopenService },
    EventStatusReopenService,
    { provide: EVENT_STATUS_REOPENER, useExisting: EventStatusReopenService },
    EventLocationReopenService,
    { provide: EVENT_LOCATION_REOPENER, useExisting: EventLocationReopenService },
    { provide: PipelineStateService, useValue: { reopen: jest.fn() } },
    { provide: StageRegistry, useValue: { get: jest.fn() } },
  ],
})
class ReopenersModule {}

/** What Nest handed the service. Private by design, so reached the way the writer reaches it. */
const moduleRefOf = (service: unknown) =>
  (service as { moduleRef?: Parameters<typeof resolveEventTimeReopener>[0] }).moduleRef;

describe('EVENT_TIME_REOPENER, EVENT_STATUS_REOPENER and EVENT_LOCATION_REOPENER wiring under Nest', () => {
  it('hands the calendar service a ModuleRef that resolves each of the sibling module’s re-openers', async () => {
    const app = await Test.createTestingModule({ imports: [CalendarModule, ReopenersModule] }).compile();

    const calendar = app.get(CalendarEventService);

    expect(moduleRefOf(calendar)).toBeDefined();
    // The instances Nest built in the other module, not copies.
    expect(resolveEventTimeReopener(moduleRefOf(calendar))).toBe(app.get(EventTimeReopenService));
    expect(resolveEventStatusReopener(moduleRefOf(calendar))).toBe(app.get(EventStatusReopenService));
    expect(resolveEventLocationReopener(moduleRefOf(calendar))).toBe(app.get(EventLocationReopenService));

    await app.close();
  });

  it('names the token when no module binds it, instead of failing on an undefined', async () => {
    const app = await Test.createTestingModule({ imports: [CalendarModule] }).compile();
    const calendar = app.get(CalendarEventService);

    expect(() => resolveEventTimeReopener(moduleRefOf(calendar))).toThrow(/EVENT_TIME_REOPENER/);
    expect(() => resolveEventStatusReopener(moduleRefOf(calendar))).toThrow(/EVENT_STATUS_REOPENER/);
    expect(() => resolveEventLocationReopener(moduleRefOf(calendar))).toThrow(/EVENT_LOCATION_REOPENER/);

    await app.close();
  });
});
