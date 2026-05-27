import { ContentResolver } from '@ci/domains/graphql/resolvers/ContentResolver';
import { EventResolver } from '@ci/domains/graphql/resolvers/EventResolver';

describe('bulk create GraphQL resolvers', () => {
  it('createContents should map array input to content service and return all results', async () => {
    const contentService = {
      create: jest.fn().mockResolvedValue([
        {
          id: '11111111-1111-1111-1111-111111111111',
          type: 'Photo',
          title: 'Imported photo',
          text: null,
          url: 'https://example.com/photo.jpg',
          mimetype: 'image/jpeg',
          externalId: 'ext-photo-1',
          sourceUrl: 'https://takeout.google.com',
          sourceData: { provider: 'Google Takeout' },
        },
      ]),
    };
    const resolver = new ContentResolver(contentService as never, {} as never, {} as never);

    const result = await resolver.createContents({ userId: 'user-1' } as never, [
      {
        type: 'Photo',
        title: 'Imported photo',
        url: 'https://example.com/photo.jpg',
        mimetype: 'image/jpeg',
        externalId: 'ext-photo-1',
        sourceUrl: 'https://takeout.google.com',
        sourceData: { provider: 'Google Takeout' },
      },
    ]);

    expect(contentService.create).toHaveBeenCalledWith({ userId: 'user-1' }, [
      {
        type: 'Photo',
        title: 'Imported photo',
        text: undefined,
        url: 'https://example.com/photo.jpg',
        mimetype: 'image/jpeg',
        external_id: 'ext-photo-1',
        source_url: 'https://takeout.google.com',
        source_data: { provider: 'Google Takeout' },
      },
    ]);
    expect(result).toHaveLength(1);
  });

  it('createEvents should map array input to event service and return all results', async () => {
    const eventService = {
      create: jest.fn().mockResolvedValue([
        {
          id: '22222222-2222-2222-2222-222222222222',
          title: 'Imported calendar event',
          description: null,
          eventType: 'calendar',
          category: 'personal',
          startTime: new Date('2026-05-26T09:00:00.000Z'),
          endTime: new Date('2026-05-26T10:00:00.000Z'),
          durationMinutes: 60,
          locationName: null,
          locationCoordinates: null,
          locationEntityId: null,
          participantEntityIds: null,
          organizerEntityId: null,
          sourceType: 'import',
          sourceSystem: 'apple',
          sourceId: 'evt-1',
          confidenceScore: 1,
          isRecurring: false,
          isAllDay: false,
          metadata: { provider: 'Apple' },
          status: 'confirmed',
        },
      ]),
    };
    const resolver = new EventResolver(eventService as never, {} as never, {} as never, {} as never);

    const result = await resolver.createEvents({ userId: 'user-1' } as never, [
      {
        title: 'Imported calendar event',
        startTime: new Date('2026-05-26T09:00:00.000Z'),
        endTime: new Date('2026-05-26T10:00:00.000Z'),
        durationMinutes: 60,
        eventType: 'calendar',
        category: 'personal',
        sourceType: 'import',
        sourceSystem: 'apple',
        sourceId: 'evt-1',
        confidenceScore: 1,
        isRecurring: false,
        isAllDay: false,
        metadata: { provider: 'Apple' },
        status: 'confirmed',
      },
    ]);

    expect(eventService.create).toHaveBeenCalledWith({ userId: 'user-1' }, [
      {
        title: 'Imported calendar event',
        description: undefined,
        event_type: 'calendar',
        category: 'personal',
        start_time: new Date('2026-05-26T09:00:00.000Z'),
        end_time: new Date('2026-05-26T10:00:00.000Z'),
        duration_minutes: 60,
        location_name: undefined,
        location_coordinates: undefined,
        location_entity_id: undefined,
        participant_entity_ids: undefined,
        organizer_entity_id: undefined,
        source_type: 'import',
        source_id: 'evt-1',
        source_system: 'apple',
        confidence_score: 1,
        is_recurring: false,
        is_all_day: false,
        metadata: { provider: 'Apple' },
        status: 'confirmed',
      },
    ]);
    expect(result).toHaveLength(1);
  });
});
