import { Injectable } from '@nestjs/common';
import { Point } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type CalendarViewWindow, type Connection, ConnectionService } from '@ci/domains/connections';
import { isUriLocation } from '@ci/domains/geocode';
import {
  CalendarEventService,
  type CreateEventDto,
  type Event,
  calendarEventIdentity,
  canonicalSystem,
  icsRecurrenceInstant,
  platformIdentity,
} from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

import { type GraphDateTimeTimeZone, graphDateTimeToInstant } from './graphDateTime';

interface OutlookCalendarEvent {
  id?: string;
  /** RFC 5545 UID (Graph spells it iCalUId) — the event's cross-pipeline identity key. */
  iCalUId?: string;
  /** Instance-only: the slot an override replaces (the RECURRENCE-ID equivalent). */
  originalStart?: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    content?: string;
    contentType?: string;
  };
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  location?: {
    displayName?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      countryOrRegion?: string;
      postalCode?: string;
    };
    coordinates?: {
      latitude?: number;
      longitude?: number;
    };
  };
  attendees?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
    type?: string;
    status?: {
      response?: string;
    };
  }>;
  organizer?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  recurrence?: unknown;
  seriesMasterId?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webLink?: string;
  /**
   * Set only on a calendarView/delta tombstone, which carries nothing but `id`
   * and this, always with `reason: 'deleted'`: an event inside the round's date
   * range that was deleted, or one OUTSIDE it that was added, edited or deleted
   * (see processRemovals).
   */
  '@removed'?: { reason?: string };
}

/** A tombstone, as processRemovals reads it. */
interface Removal {
  /** The Graph id it names — all a tombstone carries. */
  id: string;
  /** The date range of the round that reported it; absent from a job synced before ranges were recorded. */
  window?: CalendarViewWindow;
}

interface Participant {
  email: string;
  name: string;
  responseStatus: string;
  isOrganizer: boolean;
}

/**
 * Events processed concurrently. A job carries every calendar's events (see
 * extractCalendarEvents), and each event is a create() plus two
 * PromoteService.processParticipants calls; the same unbounded Promise.all in
 * GoogleCalendarTransformService crash-looped the API on OOM until it was
 * batched the same way.
 */
const CALENDAR_TRANSFORM_BATCH_SIZE = 10;

/**
 * Whether a stored event lies inside the date range of the delta round that
 * reported its tombstone — the only place a tombstone means "deleted".
 *
 * Overlap, as calendarView itself selects: an event that has not ended by the
 * range's start and has begun by its end. A range that does not parse matches
 * nothing. With no recorded range at all (a job synced before ranges were
 * recorded), only an event that has not ended yet counts: whatever the range
 * was, it began before now, so an event still to come is inside it — unless it
 * lies beyond the range's far end, three years after the round began.
 */
export function isInsideDeltaWindow(
  event: Pick<Event, 'startTime' | 'endTime'>,
  window: CalendarViewWindow | undefined,
  now: Date,
): boolean {
  const start = event.startTime.getTime();
  const end = (event.endTime ?? event.startTime).getTime();

  if (!window) {
    return end >= now.getTime();
  }

  return end >= Date.parse(window.startDateTime) && start <= Date.parse(window.endDateTime);
}

@Injectable()
export class OutlookCalendarTransformService {
  /** Time zones already reported by {@link instantOf}: once per zone per process, not once per event. */
  private readonly warnedTimeZones = new Set<string>();

  constructor(
    private readonly eventService: CalendarEventService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OutlookCalendarTransformService.name);
  }

  async transformOutlookCalendar({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Outlook Calendar transformation', {
        userId,
        syncJobId,
      });

      const { payloads, removals } = this.extractCalendarItems(data);

      if (payloads.length === 0 && removals.length === 0) {
        this.logger.log('No Outlook Calendar events found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${payloads.length} Outlook Calendar events`, {
        userId,
        syncJobId,
        eventCount: payloads.length,
        removedCount: removals.length,
      });

      for (let i = 0; i < payloads.length; i += CALENDAR_TRANSFORM_BATCH_SIZE) {
        const batch = payloads.slice(i, i + CALENDAR_TRANSFORM_BATCH_SIZE);

        await Promise.all(
          batch.map(
            async (event) =>
              await this.processCalendarEvent({
                event,
                connectionId: connection.id,
                userId,
              }),
          ),
        );
      }

      // After every payload, not among them: an event moved to another
      // calendar arrives as a tombstone for its old Graph id in one calendar
      // and the event under a new id in the other. Delivering the event first
      // moves the row's recorded id to the new one, and the tombstone then
      // names nothing stored, instead of cancelling an event that still exists.
      if (removals.length > 0) {
        await this.processRemovals({ removals, userId, connectionId: connection.id });
      }

      this.logger.log('Outlook Calendar transformation completed', {
        userId,
        syncJobId,
        processedCount: payloads.length,
        removedCount: removals.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming Outlook Calendar events', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * The job's events, every calendar's, split into payloads (events) and
   * tombstones (`@removed` entries, each with the date range of its calendar's
   * round).
   */
  private extractCalendarItems(data: unknown): { payloads: OutlookCalendarEvent[]; removals: Removal[] } {
    const payloads: OutlookCalendarEvent[] = [];
    const removals: Removal[] = [];

    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for Outlook Calendar events', {
        dataType: typeof data,
      });

      return { payloads, removals };
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Microsoft Graph API. SyncOutlookCalendar
    // returns every calendar in /me/calendars, each carrying its own `events`,
    // so the job's events are all of them concatenated. This used to `return`
    // from inside the loop, which imported the first calendar's events and
    // silently dropped every other calendar the user has.
    if ('calendars' in dataObj && Array.isArray(dataObj.calendars)) {
      for (const calendar of dataObj.calendars as unknown[]) {
        const events = (calendar as { events?: unknown } | null)?.events;

        if (!Array.isArray(events)) {
          // Both sync paths set `events` on every calendar they return, so this
          // is a malformed payload. Skip the one calendar, not the whole job.
          this.logger.warn('Outlook calendar has no events array; skipping it', {
            calendarId: (calendar as { id?: unknown } | null)?.id,
            eventsType: events === null ? 'null' : typeof events,
          });

          continue;
        }

        // Only the incremental sync's calendars carry one; only its rounds
        // report tombstones.
        const window = (calendar as { deltaWindow?: CalendarViewWindow }).deltaWindow;

        for (const event of events as OutlookCalendarEvent[]) {
          if (event !== null && typeof event === 'object' && '@removed' in event) {
            // A tombstone is not an event. Transformed, it minted an "Untitled
            // Event" stamped at ingest time under the Graph-id fallback
            // identity, never the identity the deleted event was stored under.
            if (event.id) {
              removals.push({ id: event.id, window });
            }
          } else {
            payloads.push(event);
          }
        }
      }

      return { payloads, removals };
    }

    this.logger.warn('No Outlook Calendar events found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return { payloads, removals };
  }

  private async processCalendarEvent({
    event,
    userId,
    connectionId,
  }: {
    event: OutlookCalendarEvent;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const eventId = event.id || 'unknown';
      const subject = event.subject || 'Untitled Event';

      this.logger.log('Processing Outlook Calendar event', {
        eventId,
        subject,
        attendeeCount: event.attendees?.length ?? 0,
      });

      // Extract participants
      const participants = this.extractParticipants(event);

      // Transform and save event. A cancelled one too, with status
      // 'cancelled': it is how an attendee's copy of a cancelled meeting (or of
      // one cancelled occurrence, now an exception with the same
      // `originalStart`) arrives, and `create` carries the status onto the row
      // already stored under the same identity — unless the user set a status
      // of their own (see CalendarEventService.refreshFromSource).
      const eventDto = await this.transformToEventDto(event, userId, connectionId);

      const [stored] = await this.eventService.create({ userId }, eventDto);

      // `create` hands back an existing row untouched, so one stored before the
      // Graph id was recorded, or under the id Graph used before the event moved
      // calendars, does not have this one. Record it: a tombstone names its event
      // by nothing else.
      if (
        stored &&
        event.id &&
        stored.connectionId === connectionId &&
        stored.metadata?.rawEventId !== event.id
      ) {
        await this.eventService.recordProviderEventId({ userId }, stored.id, connectionId, event.id);
      }

      // Process participants — not for a meeting that is not happening: the
      // MET_WITH edge carries the meeting's own times.
      if (participants.length > 0 && !event.isCancelled) {
        await this.processParticipants(
          participants,
          userId,
          connectionId,
          this.instantOf(event.start, event.id),
          this.instantOf(event.end, event.id),
        );
      }

      this.logger.log('Outlook Calendar event saved successfully', {
        eventId,
        subject,
      });
    } catch (error) {
      this.logger.error('Error processing individual Outlook Calendar event', {
        userId,
        connectionId,
        eventId: event.id,
        subject: event.subject,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other events
    }
  }

  /**
   * Tombstones: `@removed` entries, which name an event by its Graph id and say
   * nothing else. The organizer's own copy of a cancelled meeting (or of one
   * cancelled occurrence) leaves the calendar this way, as does anything deleted
   * outright.
   *
   * Inside the date range of the round that reported it, a tombstone is an event
   * deleted at the source — or one moved out of the range, which no longer
   * stands at the slot stored for it either. Outside the range Graph also
   * reports every event merely added or EDITED, so a tombstone there says
   * nothing this box can act on, and the stored row is left alone ("Filter the
   * events under @removed for the date range that your scenario requires" —
   * event: delta, Graph v1.0). See isInsideDeltaWindow.
   *
   * The row is found by the Graph id recorded on it (`metadata.rawEventId`), or —
   * for a UID-less row stored before that id was recorded — by the identity the
   * transform derives from the Graph id. A row keyed by its iCalUId and stored
   * before the id was recorded is found once Graph has delivered the event again
   * (processCalendarEvent records the id then); until that, its tombstone
   * matches nothing.
   *
   * A deletion at the source is a status, never the user's tombstone:
   * `applyStatusFromSource` lands 'cancelled' unless the user set a status of
   * their own, follows a row the user deleted without publishing anything, and
   * never writes `is_deleted`. If Graph later delivers the event again (restored
   * from Deleted Items, under a new id), `create` brings the status back.
   */
  private async processRemovals({
    removals,
    userId,
    connectionId,
  }: {
    removals: Removal[];
    userId: string;
    connectionId: string;
  }): Promise<void> {
    const context = { userId } as UserServiceContext;
    const derivedIdOf = (graphId: string) => platformIdentity('outlook_calendar', graphId).id;
    const ids = removals.map((removal) => removal.id);

    const byGraphId = await this.eventService.findByProviderEventIds(context, connectionId, ids);
    const byDerivedId = await this.eventService.findSourceRows(
      context,
      canonicalSystem('outlook_calendar'),
      ids.filter((id) => !byGraphId.has(id)).map(derivedIdOf),
    );

    const now = new Date();
    const unmatched: string[] = [];
    let outsideRange = 0;
    let cancelled = 0;

    for (const removal of removals) {
      try {
        // By identity, as `create` finds the row a payload re-delivers: for a
        // UID-less event the identity IS the Graph id.
        const stored = byGraphId.get(removal.id) ?? byDerivedId.get(derivedIdOf(removal.id));

        if (!stored) {
          unmatched.push(removal.id);
        } else if (!isInsideDeltaWindow(stored, removal.window, now)) {
          outsideRange += 1;
        } else {
          await this.eventService.applyStatusFromSource(context, stored.id, 'cancelled');
          cancelled += 1;
        }
      } catch (error) {
        this.logger.error('Error processing removed Outlook Calendar event', {
          userId,
          connectionId,
          eventId: removal.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Unmatched is routine — an event outside the range this box never stored,
    // or a row stored before Graph ids were recorded — so this is not a warning.
    this.logger.log('Outlook Calendar removals processed', {
      userId,
      connectionId,
      removedCount: removals.length,
      cancelledCount: cancelled,
      outsideRangeCount: outsideRange,
      unmatchedCount: unmatched.length,
      unmatchedEventIds: unmatched.slice(0, 20),
    });
  }

  private extractParticipants(event: OutlookCalendarEvent): Participant[] {
    const participants: Participant[] = [];

    // Add organizer
    if (event.organizer?.emailAddress) {
      participants.push({
        email: event.organizer.emailAddress.address || 'unknown',
        name: event.organizer.emailAddress.name || event.organizer.emailAddress.address || 'unknown',
        responseStatus: 'organizer',
        isOrganizer: true,
      });
    }

    // Add attendees
    if (event.attendees) {
      for (const attendee of event.attendees) {
        if (attendee.emailAddress) {
          participants.push({
            email: attendee.emailAddress.address || 'unknown',
            name: attendee.emailAddress.name || attendee.emailAddress.address || 'unknown',
            responseStatus: attendee.status?.response || 'none',
            isOrganizer: false,
          });
        }
      }
    }

    return participants;
  }

  /**
   * The instant a Graph `start` / `end` names, read in the zone Graph reports it
   * in — never in the zone of this process. See graphDateTimeToInstant. Throws on
   * a `dateTime` that is not an ISO date-time, which processCalendarEvent logs
   * and skips, as it did when the DB rejected the Invalid Date this used to make.
   */
  private instantOf(value: GraphDateTimeTimeZone | undefined, eventId?: string): Date | undefined {
    return graphDateTimeToInstant(value, {
      onUnrecognizedZone: (timeZone) => {
        if (this.warnedTimeZones.has(timeZone)) {
          return;
        }

        this.warnedTimeZones.add(timeZone);
        this.logger.warn(
          'Outlook event time zone is not one this runtime knows; reading its times as UTC. Not logged again for this zone.',
          { timeZone, eventId },
        );
      },
    });
  }

  private async transformToEventDto(
    event: OutlookCalendarEvent,
    userId: string,
    connectionId: string,
  ): Promise<CreateEventDto> {
    const startsAt = this.instantOf(event.start, event.id);
    const hasStartTime = startsAt !== undefined;
    const start_time = startsAt ?? new Date();
    const end_time = this.instantOf(event.end, event.id) ?? null;

    // Extract location. A meeting-join link is not a place name — see
    // isUriLocation — so a pasted Teams/Zoom URL in displayName is dropped
    // rather than stored as the event's location_name.
    const rawLocationName = event.location?.displayName || null;
    const location_name = rawLocationName && !isUriLocation(rawLocationName) ? rawLocationName : null;
    let location_coordinates: Point | null = null;

    if (event.location?.coordinates?.latitude && event.location?.coordinates?.longitude) {
      location_coordinates = {
        type: 'Point',
        coordinates: [event.location.coordinates.longitude, event.location.coordinates.latitude],
      };
    }

    // Build metadata
    const metadata = {
      connectionId,
      // The Graph id — the only thing a tombstone (`@removed`) names its event
      // by; CalendarEventService.findByProviderEventIds resolves it.
      rawEventId: event.id,
      organizerEmail: event.organizer?.emailAddress?.address,
      organizerName: event.organizer?.emailAddress?.name,
      participantCount: event.attendees?.length ?? 0,
      outlookEventUrl: event.webLink,
      created: event.createdDateTime,
      updated: event.lastModifiedDateTime,
      isOrganizer: event.isOrganizer,
    };

    return {
      id: uuidv7(),
      title: event.subject || 'Untitled Event',
      description: event.bodyPreview || event.body?.content || undefined,
      event_type: 'calendar_event',
      category: 'outlook_calendar',
      start_time,
      end_time: end_time || undefined,
      location_name: location_name || undefined,
      location_coordinates: location_coordinates || undefined,
      source_type: 'ETL',
      // Ledger platform: the Outlook Calendar connection delivered it.
      source_platform: canonicalSystem('outlook_calendar'),
      // Identity: iCalUId under the federated `calendar` system (override
      // instants as the RECURRENCE-ID suffix), converging with an exported
      // .ics or a Google fetch of the same invite —
      // docs/design/cross-pipeline-identity.md. UID-less events fall back to
      // the Graph id under the platform system.
      ...(() => {
        const identity = calendarEventIdentity(
          event.iCalUId,
          event.originalStart ? icsRecurrenceInstant(new Date(event.originalStart)) : undefined,
        );

        return identity
          ? { source_system: identity.system, source_id: identity.id }
          : {
              source_system: canonicalSystem('outlook_calendar'),
              source_id: event.id ? platformIdentity('outlook_calendar', event.id).id : undefined,
            };
      })(),
      connection_id: connectionId,
      // True for BOTH a series master and an instance Microsoft already
      // expanded server-side (`seriesMasterId` set). That is why read-time
      // expansion must never gate on `is_recurring` alone — it gates on a
      // parseable RRULE in `metadata.recurrenceRule` instead, which this
      // transform does not write, so no Outlook row is ever expanded twice.
      is_recurring: !!event.recurrence || !!event.seriesMasterId,
      is_all_day: event.isAllDay || false,
      status: this.normalizeStatus(event.isCancelled),
      // An attendee's copy of a cancelled meeting comes back from Exchange with
      // its subject rewritten ("Canceled: Lunch with Ada", in the mailbox's
      // language). That is the cancellation talking, not the organizer renaming
      // the meeting, so such a delivery speaks for the status and the time only:
      // a row already stored keeps its title (CalendarEventService
      // `refreshFromSource`), and the meeting's own subject is still the base
      // if it is ever reinstated.
      ...(event.isCancelled ? { source_asserts: ['status', 'time'] as const } : {}),
      // Outlook gave no start.dateTime: this instant is a wall-clock fallback,
      // not a real occurrence time -- same stamp import/push/inputs.ts's
      // toEventInput uses for the identical "no real date" case.
      ...(hasStartTime ? {} : { time_source: 'ingest', time_precision: 'unknown' }),
      metadata,
      user: { id: userId },
    };
  }

  private async processParticipants(
    participants: Participant[],
    userId: string,
    connectionId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<string[]> {
    const participantInfos = participants.map((p) => ({
      email: p.email,
      name: p.name,
      type: p.isOrganizer ? 'organizer' : 'attendee',
      responseStatus: p.responseStatus,
    }));

    // Use MET_WITH for regular attendees, ORGANIZED_EVENT_WITH for organizers
    const organizerInfos = participantInfos.filter((p) => p.type === 'organizer');
    const attendeeInfos = participantInfos.filter((p) => p.type === 'attendee');

    const organizerEntityIds = await this.promoteService.processParticipants(
      organizerInfos,
      userId,
      connectionId,
      'calendar',
      'ORGANIZED_EVENT_WITH',
      startDate,
      endDate,
    );

    const attendeeEntityIds = await this.promoteService.processParticipants(
      attendeeInfos,
      userId,
      connectionId,
      'calendar',
      'MET_WITH',
      startDate,
      endDate,
    );

    return [...organizerEntityIds, ...attendeeEntityIds];
  }

  private normalizeStatus(isCancelled?: boolean): string {
    return isCancelled ? 'cancelled' : 'confirmed';
  }
}
