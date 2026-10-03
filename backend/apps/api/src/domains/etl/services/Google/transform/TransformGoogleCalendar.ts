import { Injectable } from '@nestjs/common';
import { Point } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { GeocodeService, isUriLocation } from '@ci/domains/geocode';
import {
  CalendarEventService,
  type CreateEventDto,
  type Event,
  FEDERATED_SYSTEMS,
  type SourceIdentity,
  calendarEventIdentity,
  canonicalSystem,
  icsRecurrenceInstant,
  platformIdentity,
  seriesUidOf,
} from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
  }>;
  organizer?: {
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  location?: string;
  status?: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  recurrence?: string[];
  /** RFC 5545 UID — the event's cross-pipeline identity key; shared by every instance of a series. */
  iCalUID?: string;
  /** Instance-only: the slot this override replaces (the RECURRENCE-ID equivalent). */
  originalStartTime?: {
    dateTime?: string;
    date?: string;
  };
}

interface EventDetails {
  id: string;
  summary: string;
  description: string | null;
  startTime: string | undefined;
  endTime: string | undefined;
  location: string | null;
  organizerEmail: string;
  organizerName: string;
  participants: Participant[];
  isRecurring: boolean;
  status: string;
  created: string | null;
  updated: string | null;
}

interface Participant {
  email: string;
  name: string;
  responseStatus: string;
  isOrganizer: boolean;
  isSelf: boolean;
}

/** Process calendar events in small batches to avoid unbounded Promise.all memory spikes. */
const CALENDAR_TRANSFORM_BATCH_SIZE = 10;

/**
 * Google's shape for a cancellation that no longer carries its event. Two kinds
 * arrive this way, and neither has a `start`:
 *
 *  - a cancelled exception of a recurring series ("only guaranteed to have
 *    values for the id, recurringEventId and originalStartTime fields"), which
 *    is how "delete this occurrence only" syncs;
 *  - a deleted event ("only guaranteed to have the id field populated").
 *
 * A cancellation that still has its start — the organizer's own calendar keeps
 * the details — is an ordinary payload and goes through transformToEventDto.
 */
function isCancellationStub(event: CalendarEvent): boolean {
  return (event.status ?? '').toLowerCase() === 'cancelled' && !event.start?.dateTime && !event.start?.date;
}

/**
 * An instance's RECURRENCE-ID as its identity suffix: the date (`YYYYMMDD`) for
 * an all-day series, the UTC instant otherwise — the spelling the .ics importer
 * converges on (docs/design/cross-pipeline-identity.md §3.5).
 */
function recurrenceIdOf(originalStartTime: CalendarEvent['originalStartTime']): string | undefined {
  if (originalStartTime?.date) {
    return originalStartTime.date.replace(/-/g, '');
  }

  return originalStartTime?.dateTime ? icsRecurrenceInstant(new Date(originalStartTime.dateTime)) : undefined;
}

/**
 * The UID a stub's stored row can be found under when no Google id is on it —
 * a row another pipeline (the Takeout .ics import) stored first. Google sends
 * the UID when it has one; for an event Google minted itself, it is
 * `<event id>@google.com`. An instance shares its series master's UID.
 */
function stubUid(stub: CalendarEvent): string | undefined {
  const googleId = stub.recurringEventId ?? stub.id;

  return stub.iCalUID ?? (googleId ? `${googleId}@google.com` : undefined);
}

@Injectable()
export class GoogleCalendarTransformService {
  constructor(
    private readonly eventService: CalendarEventService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly geocodeService: GeocodeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GoogleCalendarTransformService.name);
  }

  async transformGoogleCalendar({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Google Calendar event transformation', {
        userId,
        syncJobId,
      });

      const events = this.extractCalendarEvents(data);

      if (events.length === 0) {
        this.logger.log('No calendar events found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${events.length} calendar events`, {
        userId,
        syncJobId,
        eventCount: events.length,
      });

      const stubs = events.filter(isCancellationStub);
      const payloads = events.filter((event) => !isCancellationStub(event));

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

      // After the full payloads, not among them: a first sync lists a series'
      // master beside its cancelled exceptions, in no promised order, and a
      // stub can only be matched to a master that is already stored.
      if (stubs.length > 0) {
        await this.processCancellationStubs({ stubs, userId, connectionId: connection.id });
      }

      this.logger.log('Google Calendar event transformation completed', {
        userId,
        syncJobId,
        processedCount: events.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming Google Calendar events', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractCalendarEvents(data: unknown): CalendarEvent[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for calendar events', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Google Calendar API
    if ('items' in dataObj && Array.isArray(dataObj.items)) {
      return dataObj.items as CalendarEvent[];
    }

    if ('events' in dataObj && Array.isArray(dataObj.events)) {
      return dataObj.events as CalendarEvent[];
    }

    if ('id' in dataObj && ('summary' in dataObj || 'start' in dataObj)) {
      return [dataObj as CalendarEvent];
    }

    this.logger.warn('No events found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processCalendarEvent({
    event,
    userId,
    connectionId,
  }: {
    event: CalendarEvent;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const eventDetails = this.extractEventDetails(event);

      this.logger.debug('Processing Google Calendar event', {
        eventId: eventDetails.id,
        summary: eventDetails.summary,
        participantCount: eventDetails.participants.length,
      });

      // Transform and save event
      const eventDto = await this.transformToEventDto(eventDetails, event, userId, connectionId);

      await this.eventService.create({ userId }, eventDto);

      // Process participants
      await this.processParticipants(
        eventDetails.participants,
        userId,
        connectionId,
        eventDetails.startTime,
        eventDetails.endTime,
      );

      this.logger.debug('Google Calendar event saved successfully', {
        eventId: eventDetails.id,
        summary: eventDetails.summary,
      });
    } catch (error) {
      this.logger.error('Error processing individual calendar event', {
        userId,
        connectionId,
        eventId: event.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other events
    }
  }

  /**
   * Cancellations that arrive without their event (see isCancellationStub).
   *
   * A stub cannot be stored as it stands — no start, no title, and usually no
   * iCalUID, which is what rows are keyed on — so each is matched to what is
   * already stored and the cancellation is applied there:
   *
   *  - A cancelled OCCURRENCE becomes the series' cancelled override row,
   *    `<uid>#<RECURRENCE-ID>`, or cancels the one already there (an
   *    occurrence moved before it was cancelled). That row is how "delete
   *    this occurrence only" is stored: read-time expansion drops every
   *    occurrence whose override key is taken (recurrence/queries.ts
   *    `dropExistingOverrides`). Without it the expander kept synthesizing the
   *    occurrence from the master's RRULE — on the grid, in the planner's
   *    occupied set, in peer free/busy.
   *  - A deleted EVENT has its stored row cancelled. A deletion at the source
   *    is a status, not the user's tombstone: `is_deleted` is the user's
   *    decision alone, and Google can restore what it deleted.
   *
   * Both go through CalendarEventService's status refresh, so a status the
   * user set stands and a row the user deleted stays deleted. A stub that
   * matches nothing stored is dropped: there is nothing to cancel, and a series
   * this box never stored has no occurrences to suppress.
   */
  private async processCancellationStubs({
    stubs,
    userId,
    connectionId,
  }: {
    stubs: CalendarEvent[];
    userId: string;
    connectionId: string;
  }): Promise<void> {
    const context = { userId } as UserServiceContext;

    // Rows this connection wrote carry Google's own id: a master under the
    // series id, an override row under the instance id.
    const byGoogleId = await this.eventService.findByProviderEventIds(
      context,
      connectionId,
      stubs.flatMap((stub) => [stub.id, stub.recurringEventId]).filter((id): id is string => Boolean(id)),
    );

    // The rest by UID: a row another pipeline stored first carries no Google id.
    const byUid = await this.eventService.findSourceRows(
      context,
      FEDERATED_SYSTEMS.calendar,
      stubs
        .filter((stub) => !byGoogleId.has(stub.recurringEventId ?? stub.id ?? ''))
        .map(stubUid)
        .filter((uid): uid is string => Boolean(uid)),
    );

    const unmatched: string[] = [];

    for (const stub of stubs) {
      try {
        if (!(await this.applyCancellationStub(stub, context, connectionId, byGoogleId, byUid))) {
          unmatched.push(stub.id ?? 'unknown');
        }
      } catch (error) {
        this.logger.error('Error processing cancelled calendar event', {
          userId,
          connectionId,
          eventId: stub.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (unmatched.length > 0) {
      this.logger.warn('Cancelled calendar events matched nothing stored; nothing to cancel', {
        userId,
        connectionId,
        count: unmatched.length,
        eventIds: unmatched.slice(0, 20),
      });
    }
  }

  /** @returns whether the stub matched anything stored. */
  private async applyCancellationStub(
    stub: CalendarEvent,
    context: UserServiceContext,
    connectionId: string,
    byGoogleId: Map<string, Event>,
    byUid: Map<string, Event>,
  ): Promise<boolean> {
    const uid = stubUid(stub);

    if (!stub.recurringEventId) {
      const stored = (stub.id ? byGoogleId.get(stub.id) : undefined) ?? (uid ? byUid.get(uid) : undefined);

      if (!stored) {
        return false;
      }

      await this.eventService.applyStatusFromSource(context, stored.id, 'cancelled');

      return true;
    }

    // An occurrence that was moved or edited before it was cancelled already
    // has its override row, written by this connection under the instance id.
    const override = stub.id ? byGoogleId.get(stub.id) : undefined;

    if (override) {
      await this.eventService.applyStatusFromSource(context, override.id, 'cancelled');

      return true;
    }

    // No RECURRENCE-ID, no override key — and `calendarEventIdentity` would
    // then hand back the MASTER's identity, so the create below would cancel
    // the whole series instead of one occurrence of it.
    const recurrenceId = recurrenceIdOf(stub.originalStartTime);
    const master = byGoogleId.get(stub.recurringEventId) ?? (uid ? byUid.get(uid) : undefined);
    const seriesUid =
      master?.sourceSystem === FEDERATED_SYSTEMS.calendar ? seriesUidOf(master.sourceId) : null;
    const identity = seriesUid && recurrenceId ? calendarEventIdentity(seriesUid, recurrenceId) : null;

    if (!master || !identity) {
      return false;
    }

    // Through `create`, so an override another pipeline already stored under
    // the same key (a Takeout .ics exception) is found and refreshed, not
    // duplicated.
    await this.eventService.create(
      context,
      this.cancelledOccurrenceDto(stub, master, identity, { userId: context.userId, connectionId }),
    );

    return true;
  }

  /**
   * The override row for one cancelled occurrence. The stub names only the
   * slot; the rest comes from the stored series — its title, so the row reads
   * as what was cancelled wherever cancelled rows are shown, and its length, so
   * that if Google restores the occurrence the row it turns back into spans the
   * right time.
   */
  private cancelledOccurrenceDto(
    stub: CalendarEvent,
    master: Event,
    identity: SourceIdentity,
    { userId, connectionId }: { userId: string; connectionId: string },
  ): CreateEventDto {
    const originalStart = stub.originalStartTime ?? {};
    // A bare `date` parses to UTC midnight, the instant every all-day row is
    // stored at (parseDateTime above does the same with `start.date`).
    const startTime = new Date((originalStart.dateTime ?? originalStart.date) as string);
    const spanMs = master.endTime ? master.endTime.getTime() - master.startTime.getTime() : 0;

    return {
      id: uuidv7(),
      title: master.title ?? 'Untitled Event',
      event_type: 'calendar_event',
      category: 'google_calendar',
      start_time: startTime,
      ...(spanMs > 0 ? { end_time: new Date(startTime.getTime() + spanMs) } : {}),
      source_type: 'ETL',
      source_platform: canonicalSystem('google_calendar'),
      source_system: identity.system,
      source_id: identity.id,
      connection_id: connectionId,
      // As on every override row this transform writes (`!!recurringEventId`).
      is_recurring: true,
      is_all_day: Boolean(originalStart.date),
      status: 'cancelled',
      // The stub says the occurrence is cancelled and nothing else. The time
      // and title above are filled in from the series, so an override row
      // another pipeline already stored (an occurrence moved or renamed before
      // it was cancelled) keeps its own when `create` finds it.
      source_asserts: ['status'],
      metadata: {
        connectionId,
        rawEventId: stub.id,
        rawEventStatus: stub.status,
        recurringEventId: stub.recurringEventId,
        originalStartTime: stub.originalStartTime,
      },
      user: { id: userId },
    };
  }

  private extractEventDetails(event: CalendarEvent): EventDetails {
    const startTime = event.start?.dateTime || event.start?.date || undefined;
    const endTime = event.end?.dateTime || event.end?.date || undefined;

    // Extract participants (attendees)
    const participants: Participant[] = (event.attendees || []).map((attendee) => ({
      email: attendee.email || 'unknown',
      name: attendee.displayName || attendee.email || 'unknown',
      responseStatus: attendee.responseStatus || 'unknown',
      isOrganizer: attendee.organizer || false,
      isSelf: attendee.self || false,
    }));

    // Extract organizer info
    const organizerEmail = event.organizer?.email || 'unknown';
    const organizerName = event.organizer?.displayName || event.organizer?.email || 'unknown';

    return {
      id: event.id || 'unknown',
      summary: event.summary || 'Untitled Event',
      description: event.description || null,
      startTime,
      endTime,
      location: event.location || null,
      organizerEmail,
      organizerName,
      participants,
      isRecurring: !!event.recurringEventId || !!event.recurrence,
      status: event.status || 'unknown',
      created: event.created || null,
      updated: event.updated || null,
    };
  }

  private async transformToEventDto(
    eventDetails: EventDetails,
    rawEvent: CalendarEvent,
    userId: string,
    connectionId: string,
  ): Promise<CreateEventDto> {
    const start_time = this.parseDateTime(eventDetails.startTime);
    const end_time = eventDetails.endTime ? this.parseDateTime(eventDetails.endTime) : null;

    if (!start_time) {
      throw new Error(`Calendar event ${eventDetails.id} has no start time`);
    }

    // Build metadata with essential information only (avoid storing large rawEvent)
    const metadata = {
      connectionId,
      organizerEmail: eventDetails.organizerEmail,
      organizerName: eventDetails.organizerName,
      participantCount: eventDetails.participants.length,
      participants: eventDetails.participants,
      googleCalendarUrl:
        rawEvent.htmlLink ?? `https://calendar.google.com/calendar/event?eid=${eventDetails.id}`,
      created: eventDetails.created,
      updated: eventDetails.updated,
      rawEventId: rawEvent.id,
      rawEventSummary: rawEvent.summary,
      rawEventStatus: rawEvent.status,
      // singleEvents=false (see SyncCalendar.ts) returns series masters rather
      // than per-occurrence instances, and nothing in this codebase expands an
      // RRULE yet. Persist it losslessly on the stored row — the one column
      // that survives create() unmodified (see CalendarEventService.toEntityFields,
      // which only renames a handful of DTO fields onto EventEntity's camelCase
      // columns; `recurrence_pattern` is not one of them and would be silently
      // dropped on insert) — so a future expansion pass has something to expand.
      ...(rawEvent.recurrence && rawEvent.recurrence.length > 0
        ? { recurrenceRule: rawEvent.recurrence }
        : {}),
      // The zone the RRULE is anchored in, and the ONLY authoritative source
      // for it — `start_time` is a UTC instant, which cannot say whether
      // "every Monday at 09:00" means 09:00 in Los Angeles or in Berlin.
      // Without it the expander falls back to the owner's own zone, which is
      // right until the two zones disagree about when DST starts. Google
      // already sends it and `extractEventDetails` was throwing it away.
      ...(rawEvent.start?.timeZone ? { recurrenceTimeZone: rawEvent.start.timeZone } : {}),
    };

    const isAllDay = this.isAllDayEvent(eventDetails.startTime);

    const { point: location_coordinates, confidence: location_confidence } =
      await this.geocodeLocationWithConfidence(eventDetails.location);

    return {
      id: uuidv7(), // Will be generated by the service
      title: eventDetails.summary,
      description: eventDetails.description || undefined,
      event_type: 'calendar_event',
      category: 'google_calendar',
      start_time,
      end_time: end_time || undefined,
      // A meeting-join link is not a place name — see isUriLocation.
      location_name:
        eventDetails.location && !isUriLocation(eventDetails.location) ? eventDetails.location : undefined,
      location_coordinates: location_coordinates || undefined,
      // Inferred / coarse coords carry < 1.0 so HBPE/RAG don't treat them as
      // ground truth; leave the default 1.0 when there are no coordinates.
      ...(location_confidence !== null ? { confidence_score: location_confidence } : {}),
      source_type: 'ETL',
      // Ledger platform: the Google Calendar connection delivered it.
      source_platform: canonicalSystem('google_calendar'),
      // Identity: iCalUID under the federated `calendar` system (with the
      // override's original-start instant as the RECURRENCE-ID suffix), so the
      // same event converges with a Takeout/exported .ics import —
      // docs/design/cross-pipeline-identity.md. UID-less events fall back to
      // the Google event id under the platform system (stable across
      // re-syncs, not expected to converge cross-pipeline).
      ...(() => {
        const identity = calendarEventIdentity(rawEvent.iCalUID, recurrenceIdOf(rawEvent.originalStartTime));

        return identity
          ? { source_system: identity.system, source_id: identity.id }
          : (() => {
              const fallback = platformIdentity('google_calendar', eventDetails.id);

              return { source_system: fallback.system, source_id: fallback.id };
            })();
      })(),
      connection_id: connectionId,
      is_recurring: eventDetails.isRecurring,
      is_all_day: isAllDay,
      status: this.normalizeStatus(eventDetails.status),
      metadata,
      user: { id: userId },
    };
  }

  private async processParticipants(
    participants: Participant[],
    userId: string,
    connectionId: string,
    startDate?: string,
    endDate?: string,
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
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    const attendeeEntityIds = await this.promoteService.processParticipants(
      attendeeInfos,
      userId,
      connectionId,
      'calendar',
      'MET_WITH',
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    return [...organizerEntityIds, ...attendeeEntityIds];
  }

  /**
   * Forward-geocode a calendar location via the shared {@link GeocodeService}
   * (cache + provider + virtual-location denylist) and return both the Point and
   * a precision-derived confidence (street ≈ 0.95, venue ≈ 0.8, city-centroid ≈
   * 0.4) so inferred / coarse coordinates are NOT stored at the default 1.0
   * ground-truth weight.
   */
  private async geocodeLocationWithConfidence(
    location: string | null,
  ): Promise<{ point: Point | null; confidence: number | null }> {
    const outcome = await this.geocodeService.geocode(location);

    if (outcome.status === 'OK' && outcome.point) {
      return { point: outcome.point, confidence: outcome.confidence };
    }

    return { point: null, confidence: null };
  }

  private parseDateTime(dateTimeStr: string | undefined): Date | undefined {
    if (!dateTimeStr) {
      return undefined;
    }

    try {
      return new Date(dateTimeStr);
    } catch {
      this.logger.warn('Failed to parse datetime', { dateTimeStr });

      return undefined;
    }
  }

  private isAllDayEvent(startTime: string | undefined): boolean {
    // If no time component (no 'T' in ISO string), it's an all-day event
    return !!startTime && !startTime.includes('T');
  }

  private normalizeStatus(status: string): string {
    const statusMap: Record<string, string> = {
      cancelled: 'cancelled',
      confirmed: 'confirmed',
      tentative: 'tentative',
    };

    return statusMap[status.toLowerCase()] || 'confirmed';
  }
}
