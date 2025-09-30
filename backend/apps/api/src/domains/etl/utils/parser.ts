import { v7 as uuid7 } from 'uuid';

// Type definitions for calendar API responses
interface GoogleCalendarDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleCalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
}

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start: GoogleCalendarDateTime;
  end: GoogleCalendarDateTime;
  htmlLink?: string;
  attendees?: GoogleCalendarAttendee[];
  status?: string;
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

interface MicrosoftCalendarEmailAddress {
  address: string;
  name?: string;
}

interface MicrosoftCalendarAttendee {
  emailAddress: MicrosoftCalendarEmailAddress;
  type?: string;
  status?: {
    response?: string;
  };
}

interface MicrosoftCalendarEvent {
  id: string;
  subject?: string;
  body?: {
    content?: string;
  };
  bodyPreview?: string;
  start: MicrosoftCalendarDateTime;
  end: MicrosoftCalendarDateTime;
  webLink?: string;
  attendees?: MicrosoftCalendarAttendee[];
  organizer?: {
    emailAddress: MicrosoftCalendarEmailAddress;
  };
  isOrganizer?: boolean;
  isCancelled?: boolean;
  [key: string]: unknown;
}

interface MicrosoftCalendarResponse {
  value?: MicrosoftCalendarEvent[];
  '@odata.nextLink'?: string;
  [key: string]: unknown;
}

// Gmail types
interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string };
    }>;
  };
  internalDate?: string;
  [key: string]: unknown;
}

interface GmailResponse {
  messages?: GmailMessage[];
  history?: Array<{
    id: string;
    messages?: GmailMessage[];
    messagesAdded?: Array<{ message: GmailMessage }>;
  }>;
  nextPageToken?: string;
  [key: string]: unknown;
}

// Microsoft email types
interface MicrosoftEmail {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    content?: string;
    contentType?: string;
  };
  from?: {
    emailAddress: MicrosoftCalendarEmailAddress;
  };
  toRecipients?: Array<{
    emailAddress: MicrosoftCalendarEmailAddress;
  }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  webLink?: string;
  [key: string]: unknown;
}

interface MicrosoftEmailResponse {
  value?: MicrosoftEmail[];
  '@odata.nextLink'?: string;
  [key: string]: unknown;
}

// Output types
export interface ParsedCalendarEvent {
  id: string;
  name: string;
  type: 'calendar_event';
  description?: string;
  start_time?: Date;
  end_time?: Date;
  external_id: string;
  source_url?: string;
  source_data: unknown;
  user_id: string;
  connection_id: string;
  attendees: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }>;
}

export interface ParsedEmail {
  id: string;
  name: string;
  type: 'email';
  description?: string;
  external_id: string;
  source_url?: string;
  source_data: unknown;
  user_id: string;
  connection_id: string;
  from?: string;
  to?: string[];
  received_at?: Date;
  sent_at?: Date;
}

export type ParsedEvent = ParsedCalendarEvent | ParsedEmail;

/**
 * Main parser function that detects the type of data and routes to appropriate parser
 */
export function parseApiLogData(
  data: unknown,
  scope: string | undefined,
  connectionId: string,
  userId: string,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  if (!data || typeof data !== 'object') {
    return events;
  }

  // Route based on scope hint
  if (scope?.toLowerCase().includes('calendar')) {
    return parseCalendarData(data, connectionId, userId);
  } else if (scope?.toLowerCase().includes('gmail') || scope?.toLowerCase().includes('mail')) {
    return parseEmailData(data, connectionId, userId);
  }

  // Try to auto-detect format
  const dataObj = data as Record<string, unknown>;
  
  // Check for calendar formats
  if ('items' in dataObj || 'value' in dataObj || 'events' in dataObj) {
    const calendarEvents = parseCalendarData(data, connectionId, userId);
    if (calendarEvents.length > 0) {
      return calendarEvents;
    }
  }

  // Check for email formats
  if ('messages' in dataObj || 'history' in dataObj) {
    return parseEmailData(data, connectionId, userId);
  }

  return events;
}

/**
 * Parses calendar data from various API responses
 */
export function parseCalendarData(
  data: unknown,
  connectionId: string,
  userId: string,
): ParsedCalendarEvent[] {
  const events: ParsedCalendarEvent[] = [];

  if (!data || typeof data !== 'object') {
    return events;
  }

  const dataObj = data as GoogleCalendarResponse | MicrosoftCalendarResponse;

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
      // Check if it's a calendar event (has start/end) or email
      if ('start' in item && 'end' in item) {
        const event = parseMicrosoftCalendarEvent(item as MicrosoftCalendarEvent, connectionId, userId);
        if (event) {
          events.push(event);
        }
      }
    }
  }

  return events;
}

/**
 * Parses email data from various API responses
 */
export function parseEmailData(
  data: unknown,
  connectionId: string,
  userId: string,
): ParsedEmail[] {
  const emails: ParsedEmail[] = [];

  if (!data || typeof data !== 'object') {
    return emails;
  }

  const dataObj = data as GmailResponse | MicrosoftEmailResponse;

  // Handle Gmail format
  if ('messages' in dataObj && dataObj.messages && Array.isArray(dataObj.messages)) {
    for (const message of dataObj.messages) {
      const email = parseGmailMessage(message, connectionId, userId);
      if (email) {
        emails.push(email);
      }
    }
  }

  // Handle Gmail history format
  if ('history' in dataObj && dataObj.history && Array.isArray(dataObj.history)) {
    for (const historyItem of dataObj.history) {
      if (historyItem.messagesAdded && Array.isArray(historyItem.messagesAdded)) {
        for (const added of historyItem.messagesAdded) {
          if (added.message) {
            const email = parseGmailMessage(added.message, connectionId, userId);
            if (email) {
              emails.push(email);
            }
          }
        }
      }
    }
  }

  // Handle Microsoft email format
  if ('value' in dataObj && dataObj.value && Array.isArray(dataObj.value)) {
    for (const item of dataObj.value) {
      // Check if it's an email (has subject but no start/end times)
      if ('subject' in item && !('start' in item)) {
        const email = parseMicrosoftEmail(item as MicrosoftEmail, connectionId, userId);
        if (email) {
          emails.push(email);
        }
      }
    }
  }

  return emails;
}

/**
 * Parses a Google Calendar event
 */
function parseGoogleCalendarEvent(
  item: GoogleCalendarEvent,
  connectionId: string,
  userId: string,
): ParsedCalendarEvent | null {
  try {
    if (!item.id) {
      return null;
    }

    // Skip cancelled events
    if (item.status === 'cancelled') {
      return null;
    }

    const startTime = parseGoogleDateTime(item.start);
    const endTime = parseGoogleDateTime(item.end);

    // Parse attendees
    const attendees: ParsedCalendarEvent['attendees'] = [];
    if (item.attendees && Array.isArray(item.attendees)) {
      for (const attendee of item.attendees) {
        if (attendee.email) {
          attendees.push({
            email: attendee.email,
            displayName: attendee.displayName,
            responseStatus: attendee.responseStatus,
            self: attendee.self,
            organizer: attendee.organizer,
          });
        }
      }
    }

    return {
      id: uuid7(),
      name: item.summary || 'Untitled Event',
      type: 'calendar_event',
      description: item.description || undefined,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      external_id: item.id,
      source_url: item.htmlLink || undefined,
      source_data: item,
      user_id: userId,
      connection_id: connectionId,
      attendees,
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
): ParsedCalendarEvent | null {
  try {
    if (!item.id) {
      return null;
    }

    // Skip cancelled events
    if (item.isCancelled === true) {
      return null;
    }

    const startTime = parseMicrosoftDateTime(item.start);
    const endTime = parseMicrosoftDateTime(item.end);

    // Parse attendees
    const attendees: ParsedCalendarEvent['attendees'] = [];
    if (item.attendees && Array.isArray(item.attendees)) {
      for (const attendee of item.attendees) {
        if (attendee.emailAddress?.address) {
          attendees.push({
            email: attendee.emailAddress.address,
            displayName: attendee.emailAddress.name,
            responseStatus: attendee.status?.response,
            self: attendee.type === 'required' && item.isOrganizer === true,
            organizer: attendee.type === 'organizer',
          });
        }
      }
    }

    // Also check organizer field
    if (item.organizer?.emailAddress?.address) {
      const organizerExists = attendees.some(att => att.email === item.organizer?.emailAddress?.address);
      if (!organizerExists) {
        attendees.push({
          email: item.organizer.emailAddress.address,
          displayName: item.organizer.emailAddress.name,
          responseStatus: 'accepted',
          self: item.isOrganizer === true,
          organizer: true,
        });
      }
    }

    return {
      id: uuid7(),
      name: item.subject || 'Untitled Event',
      type: 'calendar_event',
      description: item.bodyPreview || item.body?.content || undefined,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      external_id: item.id,
      source_url: item.webLink || undefined,
      source_data: item,
      user_id: userId,
      connection_id: connectionId,
      attendees,
    };
  } catch (error) {
    console.error('Failed to parse Microsoft Calendar event:', error);
    return null;
  }
}

/**
 * Parses a Gmail message
 */
function parseGmailMessage(
  message: GmailMessage,
  connectionId: string,
  userId: string,
): ParsedEmail | null {
  try {
    if (!message.id) {
      return null;
    }

    // Extract headers
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

    const subject = getHeader('subject') || 'No Subject';
    const from = getHeader('from');
    const to = getHeader('to')?.split(',').map(e => e.trim());
    const date = getHeader('date');

    // Parse date
    let receivedAt: Date | undefined;
    if (date) {
      receivedAt = new Date(date);
    } else if (message.internalDate) {
      receivedAt = new Date(parseInt(message.internalDate));
    }

    return {
      id: uuid7(),
      name: subject,
      type: 'email',
      description: message.snippet || undefined,
      external_id: message.id,
      source_data: message,
      user_id: userId,
      connection_id: connectionId,
      from,
      to,
      received_at: receivedAt,
      sent_at: receivedAt, // Gmail doesn't distinguish between sent/received in the same way
    };
  } catch (error) {
    console.error('Failed to parse Gmail message:', error);
    return null;
  }
}

/**
 * Parses a Microsoft email
 */
function parseMicrosoftEmail(
  email: MicrosoftEmail,
  connectionId: string,
  userId: string,
): ParsedEmail | null {
  try {
    if (!email.id) {
      return null;
    }

    const from = email.from?.emailAddress?.address;
    const to = email.toRecipients?.map(r => r.emailAddress?.address).filter(Boolean) as string[] | undefined;
    
    let receivedAt: Date | undefined;
    let sentAt: Date | undefined;
    
    if (email.receivedDateTime) {
      receivedAt = new Date(email.receivedDateTime);
    }
    if (email.sentDateTime) {
      sentAt = new Date(email.sentDateTime);
    }

    return {
      id: uuid7(),
      name: email.subject || 'No Subject',
      type: 'email',
      description: email.bodyPreview || undefined,
      external_id: email.id,
      source_url: email.webLink || undefined,
      source_data: email,
      user_id: userId,
      connection_id: connectionId,
      from,
      to,
      received_at: receivedAt,
      sent_at: sentAt,
    };
  } catch (error) {
    console.error('Failed to parse Microsoft email:', error);
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
    if (dateTime.dateTime) {
      return new Date(dateTime.dateTime);
    }
  } catch (error) {
    console.error('Failed to parse Microsoft Calendar date/time:', error);
  }

  return null;
}
