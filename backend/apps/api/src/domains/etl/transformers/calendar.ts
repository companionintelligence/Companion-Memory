/**
 * Calendar-specific transformer functions
 */

/**
 * Parse iCalendar recurrence rule (RRULE)
 */
export function parseRecurrenceRule(input: unknown): Record<string, unknown> | null {
  // TODO: Implement RRULE parsing
  // - Parse FREQ, INTERVAL, COUNT, UNTIL
  // - Parse BYDAY, BYMONTH, etc.
  // - Return structured recurrence object
  
  if (!input || typeof input !== 'string') {
    return null;
  }

  // Placeholder - just parse basic key=value pairs
  const parts = (input as string).split(';');
  const result: Record<string, string> = {};

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key && value) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Extract attendees from calendar event
 * Normalizes attendee data structure
 */
export function extractAttendees(input: unknown): Array<{
  email: string;
  name?: string;
  status?: string;
  role?: string;
}> {
  const attendees = input as Array<{
    emailAddress?: { address?: string; name?: string };
    email?: string;
    displayName?: string;
    responseStatus?: string;
    status?: { response?: string };
    role?: string;
  }>;

  if (!Array.isArray(attendees)) {
    return [];
  }

  return attendees.map((a) => ({
    email: a.emailAddress?.address || a.email || '',
    name: a.emailAddress?.name || a.displayName,
    status: a.responseStatus || a.status?.response,
    role: a.role,
  }));
}

/**
 * Parse calendar date/time
 * Handles both date and dateTime formats
 */
export function parseCalendarDateTime(input: unknown): Date | null {
  if (!input) {
    return null;
  }

  const data = input as { date?: string; dateTime?: string };
  const dateStr = data.dateTime || data.date;

  if (!dateStr) {
    return null;
  }

  try {
    return new Date(dateStr);
  } catch {
    return null;
  }
}

/**
 * Extract event duration in minutes
 */
export function extractEventDuration(input: unknown): number {
  const data = input as {
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  };

  const start = parseCalendarDateTime(data.start || {});
  const end = parseCalendarDateTime(data.end || {});

  if (!start || !end) {
    return 0;
  }

  return Math.round((end.getTime() - start.getTime()) / 60000); // minutes
}
