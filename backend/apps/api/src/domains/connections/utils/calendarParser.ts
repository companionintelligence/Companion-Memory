import { v7 as uuid7 } from 'uuid';

import type { CalendarEventData } from '../services/ApiLogPostProcessorService';

// Type definitions for calendar API responses
interface GoogleCalendarDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start: GoogleCalendarDateTime;
  end: GoogleCalendarDateTime;
  htmlLink?: string;
  [key: string]: unknown;
}

interface GoogleCalendarResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  [key: string]: unknown;
}

interface MicrosoftCalendarDateTime {
  dateTime: string;
  timeZone?: string;
}

interface MicrosoftCalendarEvent {
  id: string;
  subject?: string;
  body?: {
    content?: string;
  };
  start: MicrosoftCalendarDateTime;
  end: MicrosoftCalendarDateTime;
  webLink?: string;
  [key: string]: unknown;
}

interface MicrosoftCalendarResponse {
  value?: MicrosoftCalendarEvent[];
  '@odata.nextLink'?: string;
  [key: string]: unknown;
}

interface GenericCalendarEvent {
  id: string;
  title?: string;
  name?: string;
  summary?: string;
  description?: string;
  details?: string;
  start?: unknown;
  startTime?: unknown;
  start_date?: unknown;
  end?: unknown;
  endTime?: unknown;
  end_date?: unknown;
  url?: string;
  link?: string;
  [key: string]: unknown;
}

interface GenericCalendarResponse {
  events?: GenericCalendarEvent[];
  [key: string]: unknown;
}

type CalendarApiResponse = GoogleCalendarResponse | MicrosoftCalendarResponse | GenericCalendarResponse;

/**
 * Parses calendar data from various API responses and converts them to standardized event objects
 */
export function parseCalendarDataToEvents(
  data: unknown,
  connectionId: string,
  userId: string,
): CalendarEventData[] {
  const events: CalendarEventData[] = [];

  if (!data || typeof data !== 'object') {
    return events;
  }

  const dataObj = data as CalendarApiResponse;

  // Handle Google Calendar format
  if ('items' in dataObj && dataObj.items && Array.isArray(dataObj.items)) {
    for (const item of dataObj.items) {
      const event = parseGoogleCalendarEvent(item, connectionId, userId);
      if (event) {
        events.push(event);
      }
    }
  }

  // Handle Microsoft Calendar format
  if ('value' in dataObj && dataObj.value && Array.isArray(dataObj.value)) {
    for (const item of dataObj.value) {
      const event = parseMicrosoftCalendarEvent(item, connectionId, userId);
      if (event) {
        events.push(event);
      }
    }
  }

  // Handle generic calendar format
  if ('events' in dataObj && dataObj.events && Array.isArray(dataObj.events)) {
    for (const item of dataObj.events) {
      const event = parseGenericCalendarEvent(item, connectionId, userId);
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
}

/**
 * Parses a Google Calendar event
 */
function parseGoogleCalendarEvent(
  item: GoogleCalendarEvent,
  connectionId: string,
  userId: string,
): CalendarEventData | null {
  try {
    if (!item.id || !item.summary) {
      return null;
    }

    const startTime = parseGoogleDateTime(item.start);
    const endTime = parseGoogleDateTime(item.end);

    return {
      id: uuid7(),
      name: item.summary || 'Untitled Event',
      type: 'Calendar Event',
      description: item.description || undefined,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      external_id: item.id,
      source_url: item.htmlLink || undefined,
      source_data: item,
      user_id: userId,
      connection_id: connectionId,
    };
  } catch (error) {
    console.error('Failed to parse Google Calendar event:', error);

    return null;
  }
}

/**
 * Parses a Microsoft Calendar event
 */
function parseMicrosoftCalendarEvent(
  item: MicrosoftCalendarEvent,
  connectionId: string,
  userId: string,
): CalendarEventData | null {
  try {
    if (!item.id || !item.subject) {
      return null;
    }

    const startTime = parseMicrosoftDateTime(item.start);
    const endTime = parseMicrosoftDateTime(item.end);

    return {
      id: uuid7(),
      name: item.subject || 'Untitled Event',
      type: 'Calendar Event',
      description: item.body?.content || undefined,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      external_id: item.id,
      source_url: item.webLink || undefined,
      source_data: item,
      user_id: userId,
      connection_id: connectionId,
    };
  } catch (error) {
    console.error('Failed to parse Microsoft Calendar event:', error);

    return null;
  }
}

/**
 * Parses a generic calendar event
 */
function parseGenericCalendarEvent(
  item: GenericCalendarEvent,
  connectionId: string,
  userId: string,
): CalendarEventData | null {
  try {
    if (!item.id || (!item.title && !item.name && !item.summary)) {
      return null;
    }

    const startTime = parseGenericDateTime(item.start || item.startTime || item.start_date);
    const endTime = parseGenericDateTime(item.end || item.endTime || item.end_date);

    return {
      id: uuid7(),
      name: item.title || item.name || item.summary || 'Untitled Event',
      type: 'Calendar Event',
      description: item.description || item.details || undefined,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      external_id: item.id,
      source_url: item.url || item.link || undefined,
      source_data: item,
      user_id: userId,
      connection_id: connectionId,
    };
  } catch (error) {
    console.error('Failed to parse generic calendar event:', error);

    return null;
  }
}

/**
 * Parses Google Calendar date/time format
 */
function parseGoogleDateTime(dateTime: GoogleCalendarDateTime): Date | null {
  if (!dateTime) {
    return null;
  }

  try {
    // Google Calendar can have either dateTime (for specific times) or date (for all-day events)
    if (dateTime.dateTime) {
      return new Date(dateTime.dateTime);
    } else if (dateTime.date) {
      return new Date(dateTime.date);
    }
  } catch (error) {
    console.error('Failed to parse Google Calendar date/time:', error);
  }

  return null;
}

/**
 * Parses Microsoft Calendar date/time format
 */
function parseMicrosoftDateTime(dateTime: MicrosoftCalendarDateTime): Date | null {
  if (!dateTime) {
    return null;
  }

  try {
    // Microsoft Calendar uses dateTime property
    if (dateTime.dateTime) {
      return new Date(dateTime.dateTime);
    }
  } catch (error) {
    console.error('Failed to parse Microsoft Calendar date/time:', error);
  }

  return null;
}

/**
 * Parses generic date/time format
 */
function parseGenericDateTime(dateTime: unknown): Date | null {
  if (!dateTime) {
    return null;
  }

  try {
    // Try to parse as ISO string first
    if (typeof dateTime === 'string') {
      return new Date(dateTime);
    }

    // Try to parse as object with dateTime property
    if (typeof dateTime === 'object' && dateTime !== null && 'dateTime' in dateTime) {
      const dateTimeObj = dateTime as { dateTime: string };

      return new Date(dateTimeObj.dateTime);
    }

    // Try to parse as object with date property
    if (typeof dateTime === 'object' && dateTime !== null && 'date' in dateTime) {
      const dateObj = dateTime as { date: string };

      return new Date(dateObj.date);
    }
  } catch (error) {
    console.error('Failed to parse generic date/time:', error);
  }

  return null;
}
