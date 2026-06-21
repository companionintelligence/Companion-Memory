import { type Event } from '@ci/domains/memory';

import { EventSearchIndexListener } from '../EventSearchIndexListener';

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
});
