import { describe, expect, it } from 'vitest';

import {
  UNDATED_ENTITY_TYPES,
  addEntityFilter,
  countActiveFilters,
  eventsInPlay,
  explorerSearchTypeFilters,
  hasActivityFilter,
  hasWhenFilter,
  narrowedEntityTypes,
  peopleInPlay,
  readListParam,
  removeEntityFilter,
  resolveExplorerTypes,
  writeListParam,
} from './filterParams';

describe('explorerSearchTypeFilters', () => {
  it('sends nothing when the What picker has not narrowed the set', () => {
    expect(explorerSearchTypeFilters(new URLSearchParams('view=list'))).toEqual({});
  });

  it('turns a What-picker exclude list into includeTypes so opt-in types are named', () => {
    // People only — the live URL shape. Forwarding this as excludeTypes made
    // SearchResolver.browseWants drop person (opt-in requires includeTypes).
    const params = new URLSearchParams(
      'excludedEntityTypes=Browser,Communication,Content,Event,File,Note,Place,Product,Receipt,Thing,Answer,Concept',
    );

    expect(narrowedEntityTypes(params)).toEqual(['Person']);
    expect(explorerSearchTypeFilters(params)).toEqual({ includeTypes: ['Person'] });
  });

  it('prefers an explicit include list (the default events URL)', () => {
    expect(explorerSearchTypeFilters(new URLSearchParams('includedEntityTypes=Event,Communication'))).toEqual(
      {
        includeTypes: ['Communication', 'Event'],
      },
    );
  });
});

describe('hasWhenFilter', () => {
  it('is off with no date params', () => {
    expect(hasWhenFilter(new URLSearchParams('view=list'))).toBe(false);
    // A dangling `when=custom` with no range is not a filter — the chip does not render for it either.
    expect(hasWhenFilter(new URLSearchParams('when=custom'))).toBe(false);
  });

  it('is on for an explicit range or a rolling preset', () => {
    expect(hasWhenFilter(new URLSearchParams('from=2026-01-01T00:00:00.000Z'))).toBe(true);
    expect(hasWhenFilter(new URLSearchParams('to=2026-01-31T23:59:59.999Z'))).toBe(true);
    expect(hasWhenFilter(new URLSearchParams('when=last-week'))).toBe(true);
  });
});

describe('resolveExplorerTypes with a When filter', () => {
  const WHEN = 'from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z';

  it('leaves the type filters alone without a When filter', () => {
    expect(resolveExplorerTypes(new URLSearchParams('includedEntityTypes=Content'))).toEqual({
      includeTypes: ['Content'],
      droppedByWhen: [],
      nothingLeft: false,
    });
  });

  it('excludes the undated kinds from an unnarrowed browse, leaving opt-in types opt-in', () => {
    expect(resolveExplorerTypes(new URLSearchParams(WHEN))).toEqual({
      excludeTypes: [...UNDATED_ENTITY_TYPES, 'Answer', 'Concept', 'Thread', 'FileChunk'],
      droppedByWhen: [],
      nothingLeft: false,
    });
    expect(UNDATED_ENTITY_TYPES).toEqual(['Content', 'File', 'Note', 'Person', 'Place', 'Product', 'Thing']);
  });

  it('keeps the dated kinds of a selection and reports the rest as set aside', () => {
    expect(
      resolveExplorerTypes(new URLSearchParams(`${WHEN}&includedEntityTypes=Event,Content,Thing`)),
    ).toEqual({
      includeTypes: ['Event'],
      droppedByWhen: ['Content', 'Thing'],
      nothingLeft: false,
    });
  });

  it('reports nothing left when every selected kind is undated, instead of asking for everything', () => {
    const resolved = resolveExplorerTypes(new URLSearchParams(`${WHEN}&includedEntityTypes=Content`));

    expect(resolved).toEqual({ droppedByWhen: ['Content'], nothingLeft: true });
    expect(explorerSearchTypeFilters(new URLSearchParams(`${WHEN}&includedEntityTypes=Content`))).toEqual({});
  });

  it('is a no-op for the default events URL', () => {
    expect(
      resolveExplorerTypes(new URLSearchParams(`${WHEN}&includedEntityTypes=Event,Communication`)),
    ).toEqual({
      includeTypes: ['Communication', 'Event'],
      droppedByWhen: [],
      nothingLeft: false,
    });
  });
});

describe('resolveExplorerTypes on the events browse', () => {
  it('asks for the three happening kinds when nothing is narrowed', () => {
    expect(resolveExplorerTypes(new URLSearchParams('view=list'), '/memory/events')).toEqual({
      includeTypes: ['Browser', 'Communication', 'Event'],
      droppedByWhen: [],
      nothingLeft: false,
    });
  });

  it('keeps a narrowing inside those kinds', () => {
    expect(
      resolveExplorerTypes(new URLSearchParams('includedEntityTypes=Communication'), '/memory/events')
        .includeTypes,
    ).toEqual(['Communication']);
  });

  it('clips a deep link that names other kinds instead of widening or emptying', () => {
    expect(
      resolveExplorerTypes(new URLSearchParams('includedEntityTypes=Event,Content,Person'), '/memory/events')
        .includeTypes,
    ).toEqual(['Event']);
    expect(
      resolveExplorerTypes(new URLSearchParams('includedEntityTypes=Person'), '/memory/events').includeTypes,
    ).toEqual(['Browser', 'Communication', 'Event']);
  });

  it('never applies the route scope to /memory', () => {
    expect(resolveExplorerTypes(new URLSearchParams('view=list'), '/memory')).toEqual({
      droppedByWhen: [],
      nothingLeft: false,
    });
  });
});

describe('resolveExplorerTypes with an Activity filter', () => {
  it('is off without the param and on for any named activity', () => {
    expect(hasActivityFilter(new URLSearchParams('view=list'))).toBe(false);
    expect(hasActivityFilter(new URLSearchParams('eventTypes='))).toBe(false);
    expect(hasActivityFilter(new URLSearchParams('eventTypes=sale'))).toBe(true);
  });

  it('pins an unnarrowed browse to events instead of letting the other kinds through unfiltered', () => {
    expect(resolveExplorerTypes(new URLSearchParams('eventTypes=sale'), '/memory')).toEqual({
      includeTypes: ['Event'],
      droppedByWhen: [],
      nothingLeft: false,
    });
    expect(explorerSearchTypeFilters(new URLSearchParams('eventTypes=sale'), '/memory')).toEqual({
      includeTypes: ['Event'],
    });
  });

  it('pins the events browse to events, dropping its browser and communication kinds', () => {
    expect(
      resolveExplorerTypes(new URLSearchParams('view=list&eventTypes=sale,payment'), '/memory/events'),
    ).toEqual({ includeTypes: ['Event'], droppedByWhen: [], nothingLeft: false });
  });

  it('pins a What selection made only of the events-browse kinds', () => {
    expect(
      resolveExplorerTypes(
        new URLSearchParams('includedEntityTypes=Event,Communication&eventTypes=sale'),
        '/memory',
      ),
    ).toEqual({ includeTypes: ['Event'], droppedByWhen: [], nothingLeft: false });
  });

  it('keeps a What selection that names another kind alongside events', () => {
    expect(
      resolveExplorerTypes(
        new URLSearchParams('includedEntityTypes=Event,Content&eventTypes=sale'),
        '/memory',
      ),
    ).toEqual({ includeTypes: ['Content', 'Event'], droppedByWhen: [], nothingLeft: false });
  });

  it('keeps the Content half of the seeded "Trophy Case" search', () => {
    // The URL applySavedSearchToParams writes for entityTypes ['event',
    // 'content'] + eventTypes ['achievement_unlocked'] + query 'achievement'.
    // Pinning it to events hid every matching post while the What bar still
    // showed Content as picked, and a share link of it still returned them.
    const params = new URLSearchParams(
      'excludedEntityTypes=Browser,Communication,File,Note,Person,Place,Product,Receipt,Thing,Answer,Concept' +
        '&eventTypes=achievement_unlocked&search=achievement',
    );

    expect(explorerSearchTypeFilters(params, '/memory')).toEqual({ includeTypes: ['Content', 'Event'] });
    expect(eventsInPlay(params, '/memory')).toBe(true);
  });

  it('lets the When override report what it sets aside from such a selection', () => {
    // The seeded "Recent Entertainment" search: File + Event, last week, an
    // activity. The pin used to swallow File first, so droppedByWhen was empty.
    expect(
      resolveExplorerTypes(
        new URLSearchParams('includedEntityTypes=Event,File&when=last-week&eventTypes=played_music'),
        '/memory',
      ),
    ).toEqual({ includeTypes: ['Event'], droppedByWhen: ['File'], nothingLeft: false });
  });

  it('leaves a What selection alone once it has left events out, so the chip can be reported as unmatched', () => {
    const params = new URLSearchParams('includedEntityTypes=Content,File&eventTypes=sale');

    expect(resolveExplorerTypes(params, '/memory')).toEqual({
      includeTypes: ['Content', 'File'],
      droppedByWhen: [],
      nothingLeft: false,
    });
    expect(eventsInPlay(params, '/memory')).toBe(false);
  });

  it('agrees with the When override, which keeps events', () => {
    expect(
      resolveExplorerTypes(new URLSearchParams('when=yesterday&eventTypes=sale'), '/memory/events'),
    ).toEqual({ includeTypes: ['Event'], droppedByWhen: [], nothingLeft: false });
  });
});

describe('eventsInPlay', () => {
  it('stays true under an Activity filter, which pins the browse to events', () => {
    expect(eventsInPlay(new URLSearchParams('eventTypes=sale'), '/memory/events')).toBe(true);
    expect(eventsInPlay(new URLSearchParams('eventTypes=sale'), '/memory')).toBe(true);
  });

  it('is true on the everything browse when nothing is narrowed', () => {
    expect(eventsInPlay(new URLSearchParams('view=list'), '/memory')).toBe(true);
  });

  it('is true on the events browse, whose kinds always include events', () => {
    expect(eventsInPlay(new URLSearchParams(''), '/memory/events')).toBe(true);
    // A What selection that names no events-browse kind falls back to all of them.
    expect(eventsInPlay(new URLSearchParams('includedEntityTypes=Content'), '/memory/events')).toBe(true);
  });

  it('is false once the What bar leaves events out', () => {
    expect(eventsInPlay(new URLSearchParams('includedEntityTypes=Content,File'), '/memory')).toBe(false);
    expect(eventsInPlay(new URLSearchParams('excludedEntityTypes=Event,Answer,Concept'), '/memory')).toBe(
      false,
    );
  });

  it('is true when events are among the selected kinds', () => {
    expect(eventsInPlay(new URLSearchParams('includedEntityTypes=Content,Event'), '/memory')).toBe(true);
  });

  it('survives the When override, which only drops undated kinds', () => {
    expect(eventsInPlay(new URLSearchParams('when=yesterday'), '/memory')).toBe(true);
    // ...but not a selection the override empties out entirely.
    expect(eventsInPlay(new URLSearchParams('when=yesterday&includedEntityTypes=Note'), '/memory')).toBe(
      false,
    );
  });
});

describe('peopleInPlay', () => {
  it('follows events, which link to people through participants', () => {
    expect(peopleInPlay(new URLSearchParams(''), '/memory')).toBe(true);
    expect(peopleInPlay(new URLSearchParams('includedEntityTypes=Event'), '/memory')).toBe(true);
  });

  it('also holds for communications alone, whose sender and recipients link to people', () => {
    expect(peopleInPlay(new URLSearchParams('includedEntityTypes=Communication'), '/memory')).toBe(true);
    expect(eventsInPlay(new URLSearchParams('includedEntityTypes=Communication'), '/memory')).toBe(false);
  });

  it('is false once neither kind is in play', () => {
    expect(peopleInPlay(new URLSearchParams('includedEntityTypes=Content,File'), '/memory')).toBe(false);
    expect(
      peopleInPlay(new URLSearchParams('excludedEntityTypes=Event,Communication,Answer,Concept'), '/memory'),
    ).toBe(false);
  });
});

describe('countActiveFilters', () => {
  it('counts the From / To toggle as one filter', () => {
    expect(countActiveFilters(new URLSearchParams('direction=inbound'))).toBe(1);
    expect(countActiveFilters(new URLSearchParams('direction=inbound&people=Ada'))).toBe(2);
  });

  it('counts each Who / Where / tag value once, commas included', () => {
    const params = new URLSearchParams();
    params.append('places', '4000 Ontario Center, Ontario, CA, 91764');
    params.append('places', 'Paris');
    params.append('tags', 'travel');
    params.set('connectors', 'gmail,facebook');

    expect(countActiveFilters(params)).toBe(5);
  });
});

describe('the Who / Where / tag list params', () => {
  // A place is often a full street address, so a comma inside a value is
  // ordinary: each value is its own occurrence of the param, never a CSV cell.
  const address = '4000 Ontario Center, Ontario, CA, 91764';

  it('accepts a street address with commas as one Where filter', () => {
    const params = new URLSearchParams('view=map');

    expect(addEntityFilter(params, 'place', address)).toBeNull();
    expect(params.getAll('places')).toEqual([address]);
    expect(readListParam(params, 'places')).toEqual([address]);
  });

  it('keeps one occurrence of the param per value', () => {
    const params = new URLSearchParams();

    addEntityFilter(params, 'place', address);
    addEntityFilter(params, 'place', 'Paris');
    addEntityFilter(params, 'person', 'Lovelace, Ada');
    addEntityFilter(params, 'tag', 'Work, urgent');

    expect(params.getAll('places')).toEqual([address, 'Paris']);
    expect(params.getAll('people')).toEqual(['Lovelace, Ada']);
    // Tag labels are canonically lowercase.
    expect(params.getAll('tags')).toEqual(['work, urgent']);
    expect(params.toString()).toContain('places=4000+Ontario+Center%2C+Ontario%2C+CA%2C+91764&places=Paris');
  });

  it('refuses a duplicate, case-insensitively, and removes one value without touching the rest', () => {
    const params = new URLSearchParams();

    addEntityFilter(params, 'place', address);
    expect(addEntityFilter(params, 'place', address.toUpperCase())).toBe(
      `${address.toUpperCase()} is already selected.`,
    );

    addEntityFilter(params, 'place', 'Paris');
    removeEntityFilter(params, 'place', address.toLowerCase());

    expect(params.getAll('places')).toEqual(['Paris']);

    removeEntityFilter(params, 'place', 'Paris');
    expect(params.has('places')).toBe(false);
  });

  it('writes a list as repeated params and drops the key for an empty one', () => {
    const params = new URLSearchParams('places=stale&view=map');

    writeListParam(params, 'places', [' Paris ', '', address]);
    expect(params.getAll('places')).toEqual(['Paris', address]);

    writeListParam(params, 'places', []);
    expect(params.has('places')).toBe(false);
    expect(params.get('view')).toBe('map');
  });
});
