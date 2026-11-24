import { describe, expect, it } from 'vitest';

import { activityTimelineFiltersFromSearchParams } from './activityTimelineFilters';

describe('activityTimelineFiltersFromSearchParams', () => {
  it('returns undefined when no filters are active', () => {
    expect(activityTimelineFiltersFromSearchParams(new URLSearchParams())).toBeUndefined();
  });

  it('maps entity-type exclude lists to includeTypes, matching the explorer search', () => {
    const params = new URLSearchParams({
      excludedEntityTypes:
        'Browser,Communication,Content,Event,File,Note,Place,Product,Receipt,Thing,Answer,Concept',
    });

    expect(activityTimelineFiltersFromSearchParams(params)).toEqual({
      includeTypes: ['person'],
    });
  });

  it('maps entity-type include lists to indexable types', () => {
    const params = new URLSearchParams({ includedEntityTypes: 'Note,Event' });

    expect(activityTimelineFiltersFromSearchParams(params)).toEqual({
      includeTypes: expect.arrayContaining(['note', 'event']),
    });
    expect(activityTimelineFiltersFromSearchParams(params)?.includeTypes).toHaveLength(2);
  });

  it('applies the When override so the heatmap counts the same kinds as the list', () => {
    const when = 'from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z';

    expect(activityTimelineFiltersFromSearchParams(new URLSearchParams(when))).toEqual({
      excludeTypes: [
        'content',
        'file',
        'note',
        'person',
        'place',
        'product',
        'item',
        'answer',
        'concept',
        'thread',
        'file-chunk',
        'task',
        'action',
        'message',
        'position',
      ],
    });
    expect(
      activityTimelineFiltersFromSearchParams(
        new URLSearchParams(`${when}&includedEntityTypes=Event,Content`),
      ),
    ).toEqual({ includeTypes: ['event'] });
  });

  it('pins the heatmap to events under an Activity filter, like the list', () => {
    expect(
      activityTimelineFiltersFromSearchParams(
        new URLSearchParams('view=list&eventTypes=sale'),
        '/memory/events',
      ),
    ).toEqual({ includeTypes: ['event'], eventTypes: ['sale'] });
  });

  it('passes who/where/how and text filters through to the heatmap query', () => {
    const params = new URLSearchParams({
      people: 'Ada',
      places: 'Laguna Beach',
      connectors: 'gmail',
      eventTypes: 'email',
      tags: 'work',
      search: 'budget',
    });

    expect(activityTimelineFiltersFromSearchParams(params)).toEqual({
      // The Activity filter pins the browse to events (resolveExplorerTypes).
      includeTypes: ['event'],
      people: ['Ada'],
      places: ['Laguna Beach'],
      connectors: ['gmail'],
      eventTypes: ['email'],
      tags: ['work'],
      query: 'budget',
    });
  });
});
