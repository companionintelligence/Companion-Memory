import { describe, expect, it } from 'vitest';

import {
  UNDATED_ENTITY_TYPES,
  countActiveFilters,
  eventsInPlay,
  explorerSearchTypeFilters,
  hasActivityFilter,
  hasWhenFilter,
  narrowedEntityTypes,
  peopleInPlay,
  resolveExplorerTypes,
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
      excludeTypes: [...UNDATED_ENTITY_TYPES, 'Answer', 'Concept'],
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

  it('pins a What selection that includes events', () => {
    expect(
      resolveExplorerTypes(
        new URLSearchParams('includedEntityTypes=Event,Content&eventTypes=sale'),
        '/memory',
      ),
    ).toEqual({ includeTypes: ['Event'], droppedByWhen: [], nothingLeft: false });
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
});
