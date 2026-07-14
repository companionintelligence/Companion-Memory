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
