import { SYSTEM_USER } from '@ci/common/context';
import { type Event } from '@ci/domains/memory';

import { EventSearchIndexListener, eventDisplayTitle } from '../EventSearchIndexListener';

// getSearchDocument is private and depends on nothing but its argument, so we
// instantiate the listener with no-op deps and reach it directly. This locks in
// that imported events become semantically searchable by their real content
// (title/description + the structured metadata fields importers record), not
// just by their filename-derived title.
function makeListener(): EventSearchIndexListener {
  // The constructor calls logger.setContext; everything else is unused by
  // getSearchDocument, so stub the logger and leave the rest as no-ops.
  const logger = { setContext: () => undefined } as never;

  return new EventSearchIndexListener(null as never, null as never, null as never, null as never, logger);
}

function doc(event: Partial<Event>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (makeListener() as any).getSearchDocument(event as Event);
}

describe('EventSearchIndexListener.getSearchDocument', () => {
  it('indexes title, description, category and eventType', () => {
    const result = doc({
      title: 'Lunch with Dana',
      description: 'discussed the Q3 roadmap',
      category: 'communication',
      eventType: 'message',
    });
    expect(result).toContain('Lunch with Dana');
    expect(result).toContain('discussed the Q3 roadmap');
    expect(result).toContain('communication');
    expect(result).toContain('message');
  });

  it('pulls high-signal importer metadata fields (Subject, Text, Track, Product)', () => {
    const result = doc({
      title: 'gmail event',
      metadata: {
        Subject: 'Your billing account was suspended',
        Text: 'Loved an image',
        Track: 'Party Rock Anthem',
        Artist: 'LMFAO',
        Product: 'Kingston NV3 1TB NVMe SSD',
        Source: 'GmailMbox', // not in the allowlist — must be ignored
      },
    });
    expect(result).toContain('Your billing account was suspended');
    expect(result).toContain('Loved an image');
    expect(result).toContain('Party Rock Anthem');
    expect(result).toContain('Kingston NV3 1TB NVMe SSD');
    expect(result).not.toContain('GmailMbox');
  });

  it('returns null when there is nothing to index', () => {
    expect(doc({})).toBeNull();
  });

  it('ignores non-string metadata values without throwing', () => {
    const result = doc({ title: 'ok', metadata: { Subject: 42, Text: { nested: true } } });
    expect(result).toBe('ok');
  });

  it('rewrites bare photo filenames into a human-readable display title', () => {
    const result = doc({
      title: 'DSC00838.jpg',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      locationName: '1642 Rambla Pacifico St, Topanga, CA 90290, USA',
      eventType: 'capture.photo',
      sourceSystem: 'apple_photos',
      metadata: { 'Media Type': 'image/jpeg' },
    });

    expect(result).not.toBeNull();
    // The raw filename should NOT survive on its own — the display title replaces it.
    expect(result).toContain('Photo');
    expect(result).toContain('Topanga, CA');
    expect(result).toContain('Jun 17, 2026');
  });

  it("includes locationName for photo events even when shortPlace can't parse it", () => {
    const result = doc({
      title: 'IMG_0042.heic',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      locationName: 'A Very Long Address That Definitely Will Not Fit In The Compact Title String',
      eventType: 'capture.photo',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('A Very Long Address That Definitely');
  });

  it('rewrites bare video filenames into a Video display title', () => {
    const result = doc({
      title: 'IMG_0301.MP4',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      locationName: 'Malibu, CA, USA',
      sourceSystem: 'google_photos',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('Video');
    expect(result).toContain('Malibu, CA');
    expect(result).toContain('Jun 17, 2026');
  });

  it('keeps an authored title (with whitespace) untouched', () => {
    const result = doc({
      title: 'Sunset over the Pacific',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      locationName: 'Topanga, CA',
      metadata: { 'Media Type': 'image/jpeg' },
    });

    expect(result).toContain('Sunset over the Pacific');
    // No "Photo · " prefix should be synthesized when the user (or LLM caption)
    // already wrote a real title.
    expect(result).not.toMatch(/Photo · /);
  });

  it('includes calendar tokens for date-fuzzy queries (month name + season)', () => {
    const result = doc({
      title: 'DSC00838.jpg',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      metadata: { 'Media Type': 'image/jpeg' },
    });

    expect(result).toContain('June 2026');
    expect(result).toContain('summer 2026');
  });

  it('expands sourceSystem into searchable words', () => {
    const result = doc({
      title: 'DSC00838.jpg',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      sourceSystem: 'apple_photos',
      metadata: { 'Media Type': 'image/jpeg' },
    });

    expect(result).toContain('apple photos library');
  });

  it('falls back to a humanized sourceSystem when no expansion is registered', () => {
    const result = doc({
      title: 'note from somewhere',
      sourceSystem: 'some_new_importer',
    });

    expect(result).toContain('some new importer');
  });

  it('indexes EXIF camera metadata (Make/Model/LensModel)', () => {
    const result = doc({
      title: 'DSC00838.jpg',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      metadata: {
        'Media Type': 'image/jpeg',
        Make: 'FUJIFILM',
        Model: 'X100V',
        LensModel: '23mm f/2',
      },
    });

    expect(result).toContain('FUJIFILM');
    expect(result).toContain('X100V');
    expect(result).toContain('23mm f/2');
  });

  it('handles a media event with no place gracefully', () => {
    const result = doc({
      title: 'DSC00838.jpg',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      metadata: { 'Media Type': 'image/jpeg' },
    });

    expect(result).not.toBeNull();
    expect(result).toContain('Photo');
    expect(result).toContain('Jun 17, 2026');
  });
});

describe('eventDisplayTitle', () => {
  it('rewrites filename-only photo titles into "Photo · place · date"', () => {
    expect(
      eventDisplayTitle({
        title: 'DSC00838.jpg',
        startTime: new Date('2026-06-17T15:30:00.000Z'),
        locationName: '1642 Rambla Pacifico St, Topanga, CA 90290, USA',
      }),
    ).toBe('Photo · Topanga, CA · Jun 17, 2026');
  });

  it('rewrites filename-only video titles into "Video · place · date"', () => {
    expect(
      eventDisplayTitle({
        title: 'IMG_0301.MP4',
        startTime: new Date('2026-06-17T15:30:00.000Z'),
        locationName: 'Malibu, CA, USA',
      }),
    ).toBe('Video · Malibu, CA · Jun 17, 2026');
  });

  it('passes authored titles through untouched', () => {
    expect(
      eventDisplayTitle({
        title: 'Lunch with Dana',
        startTime: new Date('2026-06-17T15:30:00.000Z'),
        locationName: 'Topanga, CA',
      }),
    ).toBe('Lunch with Dana');
  });

  it("uses Media Type when title alone isn't a recognizable filename", () => {
    expect(
      eventDisplayTitle({
        title: '50231557_2415233981880',
        startTime: new Date('2026-06-17T15:30:00.000Z'),
        locationName: 'Topanga, CA, USA',
        metadata: { 'Media Type': 'image/jpeg' },
      }),
    ).toBe('Photo · Topanga, CA · Jun 17, 2026');
  });

  it("drops the place segment when shortPlace can't parse it", () => {
    const result = eventDisplayTitle({
      title: 'IMG.JPG',
      startTime: new Date('2026-06-17T15:30:00.000Z'),
      locationName: 'A Very Long Address That Exceeds The Compact Title Length Cap',
    });

    expect(result).toBe('Photo · Jun 17, 2026');
  });
});

/**
 * The listener CLASS itself — `indexEvent` / `updateEvent` / `unindexEvent` —
 * had no test at all before this: everything above exercises only the pure
 * `getSearchDocument` / `eventDisplayTitle` helpers via a no-op instance.
 */
function makeFullListener(event: Record<string, unknown> | null = null, embeddedIds: string[] = []) {
  const eventService = { findById: jest.fn().mockResolvedValue(event) };
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
    existingEntityIds: jest.fn().mockResolvedValue(new Set<string>(embeddedIds)),
  };
  const vectorService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new EventSearchIndexListener(
    eventService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  return { listener, eventService, embeddingGenerationService, embeddingService, vectorService, logger };
}

describe('EventSearchIndexListener.unindexEvent', () => {
  it('removes the embedding and the vector for (event, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeFullListener();

    await listener.unindexEvent({ eventId: 'event-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'event', entityId: 'event-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'event', entityId: 'event-1' },
    );
  });
});

describe('EventSearchIndexListener.indexEvent / updateEvent', () => {
  it('is a no-op when the event cannot be found', async () => {
    const { listener, embeddingService, logger } = makeFullListener(null);

    await listener.indexEvent({ eventId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the event has no associated user', async () => {
    const { listener, embeddingService } = makeFullListener({
      id: 'event-1',
      userId: null,
      title: 'Dinner',
    });

    await listener.indexEvent({ eventId: 'event-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
  });

  it('skips planned_block so auto-plan does not feed the search/embed pipeline', async () => {
    const { listener, embeddingService, vectorService } = makeFullListener({
      id: 'event-1',
      userId: 'user-1',
      title: 'Write the brief',
      eventType: 'planned_block',
    });

    await listener.indexEvent({ eventId: 'event-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });

  it('embeds and vectorizes a substantive event, scoped to its owner', async () => {
    const { listener, embeddingService, vectorService } = makeFullListener({
      id: 'event-1',
      userId: 'user-1',
      title: 'Dinner with Liam',
      description: 'Catching up over ramen',
      category: 'social',
    });

    await listener.updateEvent({ eventId: 'event-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'event', entityId: 'event-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'event', entityId: 'event-1' }),
    );
  });

  // The maintenance sweep re-drives `event.created` for rows that had no
  // embedding when it ran, while the pipeline's index.embed_event stage embeds
  // the same rows. On a 126k-event import 99.8% of the completed jobs found the
  // vector already there and paid an Ollama call to overwrite it.
  it('keeps an existing embedding on a created event, but still refreshes the tsvector', async () => {
    const { listener, embeddingGenerationService, embeddingService, vectorService } = makeFullListener(
      { id: 'event-1', userId: 'user-1', title: 'Dinner with Liam', description: 'Catching up over ramen' },
      ['event-1'],
    );

    await listener.indexEvent({ eventId: 'event-1' } as never);

    expect(embeddingService.existingEntityIds).toHaveBeenCalledWith({ userId: 'user-1' }, 'event', [
      'event-1',
    ]);
    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'event', entityId: 'event-1' }),
    );
  });

  it('embeds a created event that has no embedding yet', async () => {
    const { listener, embeddingGenerationService, embeddingService } = makeFullListener({
      id: 'event-1',
      userId: 'user-1',
      title: 'Dinner with Liam',
      description: 'Catching up over ramen',
    });

    await listener.indexEvent({ eventId: 'event-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'event', entityId: 'event-1', embedding: [0.1, 0.2] },
    );
  });

  it('re-embeds an UPDATED event even when an embedding exists (its text changed)', async () => {
    const { listener, embeddingGenerationService, embeddingService } = makeFullListener(
      { id: 'event-1', userId: 'user-1', title: 'Dinner with Liam', description: 'Moved to Thursday' },
      ['event-1'],
    );

    await listener.updateEvent({ eventId: 'event-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(embeddingService.upsert).toHaveBeenCalledTimes(1);
  });

  it('skips both embedding and vectorization for an event with no searchable content', async () => {
    const { listener, embeddingService, vectorService } = makeFullListener({
      id: 'event-2',
      userId: 'user-1',
      title: null,
      description: null,
      category: null,
      eventType: null,
      metadata: null,
    });

    await listener.indexEvent({ eventId: 'event-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });

  // Unlike its siblings (Communication, Person, Position), this listener has NO
  // IndexSkipService dependency at all — it computes a low-value skip reason
  // (via embedSkipReason) but never records a ci_search.index_skips marker for
  // it. If a backfill sweep relies on that marker to avoid re-examining
  // already-decided rows (the pattern every other embedding-gated listener
  // follows), a low-value event is re-examined on every single sweep, forever —
  // asserted here so that gap is a visible, deliberate fact about this listener
  // rather than a silent assumption. If IndexSkipService is later wired in here,
  // this test should be the one that changes.
  it('skips embedding a trivial/low-value event WITHOUT recording any skip marker (no IndexSkipService exists here)', async () => {
    const { listener, embeddingService, vectorService } = makeFullListener({
      id: 'event-3',
      userId: 'user-1',
      title: 'ok',
      description: null,
      category: null,
      eventType: null,
      metadata: null,
    });

    await listener.indexEvent({ eventId: 'event-3' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    // Constructor takes exactly 5 args (no IndexSkipService slot) — this is the
    // structural half of the same fact, kept next to the behavioral half above.
    expect(EventSearchIndexListener).toHaveLength(5);
    void vectorService; // vectorization is independent of the embed skip; not the point of this test
  });
});
