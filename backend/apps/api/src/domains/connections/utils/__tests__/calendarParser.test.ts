import { parseCalendarDataToEvents } from '../calendarParser';

describe('Calendar Parser', () => {
  const mockConnectionId = 'test-connection-id';
  const mockUserId = 'test-user-id';

  describe('Google Calendar Events', () => {
    it('should parse Google Calendar events with correct type', () => {
      const mockGoogleCalendarData = {
        items: [
          {
            id: 'google-event-1',
            summary: 'Test Google Event',
            description: 'A test event from Google Calendar',
            start: { dateTime: '2024-01-15T10:00:00Z' },
            end: { dateTime: '2024-01-15T11:00:00Z' },
            htmlLink: 'https://calendar.google.com/event/1',
          },
        ],
      };

      const events = parseCalendarDataToEvents(mockGoogleCalendarData, mockConnectionId, mockUserId);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: 'Test Google Event',
        type: 'Calendar Event',
        description: 'A test event from Google Calendar',
        external_id: 'google-event-1',
        source_url: 'https://calendar.google.com/event/1',
        user_id: mockUserId,
        connection_id: mockConnectionId,
      });
    });
  });

  describe('Microsoft Calendar Events', () => {
    it('should parse Microsoft Calendar events with correct type', () => {
      const mockMicrosoftCalendarData = {
        value: [
          {
            id: 'microsoft-event-1',
            subject: 'Test Microsoft Event',
            body: { content: 'A test event from Microsoft Calendar' },
            start: { dateTime: '2024-01-15T14:00:00Z' },
            end: { dateTime: '2024-01-15T15:00:00Z' },
            webLink: 'https://outlook.live.com/event/1',
          },
        ],
      };

      const events = parseCalendarDataToEvents(mockMicrosoftCalendarData, mockConnectionId, mockUserId);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: 'Test Microsoft Event',
        type: 'Calendar Event',
        description: 'A test event from Microsoft Calendar',
        external_id: 'microsoft-event-1',
        source_url: 'https://outlook.live.com/event/1',
        user_id: mockUserId,
        connection_id: mockConnectionId,
      });
    });
  });

  describe('Generic Calendar Events', () => {
    it('should parse generic calendar events with correct type', () => {
      const mockGenericCalendarData = {
        events: [
          {
            id: 'generic-event-1',
            title: 'Test Generic Event',
            description: 'A test event from generic calendar',
            start: '2024-01-15T16:00:00Z',
            end: '2024-01-15T17:00:00Z',
            url: 'https://example.com/event/1',
          },
        ],
      };

      const events = parseCalendarDataToEvents(mockGenericCalendarData, mockConnectionId, mockUserId);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: 'Test Generic Event',
        type: 'Calendar Event',
        description: 'A test event from generic calendar',
        external_id: 'generic-event-1',
        source_url: 'https://example.com/event/1',
        user_id: mockUserId,
        connection_id: mockConnectionId,
      });
    });
  });

  describe('Event Type Consistency', () => {
    it('should always use "Calendar Event" as the type for all calendar events', () => {
      const testCases = [
        {
          name: 'Google Calendar',
          data: {
            items: [
              {
                id: '1',
                summary: 'Test',
                start: { dateTime: '2024-01-15T10:00:00Z' },
                end: { dateTime: '2024-01-15T11:00:00Z' },
              },
            ],
          },
        },
        {
          name: 'Microsoft Calendar',
          data: {
            value: [
              {
                id: '1',
                subject: 'Test',
                start: { dateTime: '2024-01-15T10:00:00Z' },
                end: { dateTime: '2024-01-15T11:00:00Z' },
              },
            ],
          },
        },
        {
          name: 'Generic Calendar',
          data: {
            events: [{ id: '1', title: 'Test', start: '2024-01-15T10:00:00Z', end: '2024-01-15T11:00:00Z' }],
          },
        },
      ];

      testCases.forEach(({ data }) => {
        const events = parseCalendarDataToEvents(data, mockConnectionId, mockUserId);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('Calendar Event');
      });
    });
  });
});
