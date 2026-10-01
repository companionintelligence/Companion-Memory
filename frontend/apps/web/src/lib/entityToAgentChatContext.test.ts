import { describe, expect, it } from 'vitest';

import { createDateTimeFormatter, DEVICE_DATE_TIME_FORMATTER } from '@/lib/dateTimeFormat';
import type { MemoryEntity } from '@/pages/MemoryPage/useEntityService';

import { entityToAgentChatContext } from './entityToAgentChatContext';

function asEntity(entity: Record<string, unknown>): MemoryEntity {
  return entity as unknown as MemoryEntity;
}

describe('entityToAgentChatContext', () => {
  it('strips HTML from a note and uses the title', () => {
    expect(
      entityToAgentChatContext(
        asEntity({
          __typename: 'NoteType',
          id: 'n1',
          title: 'Picnic',
          content: '<p>Bring <b>snacks</b>.</p>',
        }),
        DEVICE_DATE_TIME_FORMATTER,
      ),
    ).toEqual({
      title: 'Picnic',
      body: 'Bring snacks.',
      sourceKind: 'NoteType',
      sourceId: 'n1',
    });
  });

  it('uses an event display title and description', () => {
    const context = entityToAgentChatContext(
      asEntity({
        __typename: 'EventType',
        id: 'e1',
        title: 'Dinner with Sam',
        description: 'Tacos on the pier',
        startTime: '2026-06-17T19:00:00Z',
        locationName: 'Malibu',
      }),
      DEVICE_DATE_TIME_FORMATTER,
    );

    expect(context.title).toBe('Dinner with Sam');
    expect(context.body).toContain('When:');
    expect(context.body).toContain('Where: Malibu');
    expect(context.body).toContain('Tacos on the pier');
    expect(context.sourceKind).toBe('EventType');
    expect(context.sourceId).toBe('e1');
  });

  it('fills When/Where/Kind/Tags from list-view aliases when description is masked', () => {
    const context = entityToAgentChatContext(
      asEntity({
        __typename: 'EventType',
        id: 'e2',
        galleryTitle: 'Walk in the park',
        galleryLocationName: 'Golden Gate Park',
        bucketStartTime: '2026-06-09T18:30:00Z',
        eventType: 'visited',
        sourceSystem: 'google_maps',
        tags: [{ label: 'walk' }, { label: 'sf' }],
      }),
      DEVICE_DATE_TIME_FORMATTER,
    );

    expect(context.title).toBe('Walk in the park');
    expect(context.body).toContain('When:');
    expect(context.body).toContain('Where: Golden Gate Park');
    expect(context.body).toContain('Kind: visited');
    expect(context.body).toContain('Source: google maps');
    expect(context.body).toContain('Tags: walk, sf');
    expect(context.body).not.toContain('Tacos');
  });

  it('omits When when the timestamp is only the import wall clock', () => {
    const context = entityToAgentChatContext(
      asEntity({
        __typename: 'EventType',
        id: 'e3',
        galleryTitle: 'Saved place',
        bucketStartTime: '2026-06-09T18:30:00Z',
        bucketTimeSource: 'ingest',
        galleryLocationName: 'Home',
      }),
      DEVICE_DATE_TIME_FORMATTER,
    );

    expect(context.body).not.toMatch(/^When:/m);
    expect(context.body).toContain('Where: Home');
  });

  it('prefers communication subject and keeps the preview as the body', () => {
    expect(
      entityToAgentChatContext(
        asEntity({
          __typename: 'CommunicationType',
          id: 'c1',
          subject: 'Flights',
          preview: 'Land at 4pm',
        }),
        DEVICE_DATE_TIME_FORMATTER,
      ),
    ).toEqual({
      title: 'Flights',
      body: 'Land at 4pm',
      sourceKind: 'CommunicationType',
      sourceId: 'c1',
    });
  });

  it('uses a file chunk section title and content', () => {
    const context = entityToAgentChatContext(
      asEntity({
        __typename: 'FileChunkType',
        id: 'fc1',
        sectionTitle: 'Warranty',
        chunkContent: 'Valid through 2027.',
        file: { filename: 'manual.pdf' },
      }),
      DEVICE_DATE_TIME_FORMATTER,
    );

    expect(context.title).toBe('Warranty');
    expect(context.body).toBe('Valid through 2027.');
  });

  it('uses the question as the title of an answer', () => {
    expect(
      entityToAgentChatContext(
        asEntity({
          __typename: 'AnswerType',
          id: 'a1',
          answer: 'Blue',
          question: { text: 'Favorite color?' },
        }),
        DEVICE_DATE_TIME_FORMATTER,
      ),
    ).toEqual({
      title: 'Favorite color?',
      body: 'Blue',
      sourceKind: 'AnswerType',
      sourceId: 'a1',
    });
  });

  it('falls back to a generic name and description', () => {
    expect(
      entityToAgentChatContext(
        asEntity({
          __typename: 'GenericEntity',
          id: 'g1',
          name: 'Home',
          entityType: 'place',
          description: 'The house on Oak',
        }),
        DEVICE_DATE_TIME_FORMATTER,
      ),
    ).toEqual({
      title: 'Home',
      body: 'The house on Oak',
      sourceKind: 'GenericEntity',
      sourceId: 'g1',
    });
  });

  it('puts a browser URL in the draft when that is the data we have', () => {
    const context = entityToAgentChatContext(
      asEntity({
        __typename: 'BrowserActivityType',
        id: 'b1',
        title: 'Tide chart',
        url: 'https://example.com/tides',
        time: '2026-06-09T18:30:00Z',
      }),
      DEVICE_DATE_TIME_FORMATTER,
    );

    expect(context.title).toBe('Tide chart');
    expect(context.body).toContain('URL: https://example.com/tides');
    expect(context.body).toContain('When:');
  });

  it("writes When in the owner's time format and zone", () => {
    const whenLine = (timeFormat: 'h12' | 'h23') =>
      entityToAgentChatContext(
        asEntity({ __typename: 'EventType', id: 'e2', title: 'Swim', startTime: '2026-06-17T22:43:00Z' }),
        createDateTimeFormatter({ timeFormat, timeZone: 'America/Los_Angeles' }),
      ).body?.match(/^When: (.*)$/m)?.[1];

    // 22:43 UTC is 15:43 in Los Angeles.
    expect(whenLine('h23')).toMatch(/\b15:43$/);
    expect(whenLine('h12')).toMatch(/\b3:43\sPM$/i);
  });
});
