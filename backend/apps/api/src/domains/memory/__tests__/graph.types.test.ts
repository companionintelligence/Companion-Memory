import {
  ENTITY_TYPES,
  EXPLORER_TO_GRAPH_ENTITY_TYPES,
  GRAPH_ENTITY_TYPES,
  graphEntityKindOf,
  graphTypesToExclude,
} from '../graph.types';

const ALL_EXPLORER_TYPES = Object.keys(EXPLORER_TO_GRAPH_ENTITY_TYPES);

describe('graphTypesToExclude', () => {
  it('returns [] when every explorer type is selected (filter inactive)', () => {
    expect(graphTypesToExclude(ALL_EXPLORER_TYPES)).toEqual([]);
  });

  it('excludes graph types mapped from deselected explorer types, keeping the selected ones', () => {
    const excluded = graphTypesToExclude(['person', 'place']);

    // Selected: person → Person/Contact, place → Location/Place must survive.
    expect(excluded).not.toContain('Person');
    expect(excluded).not.toContain('Contact');
    expect(excluded).not.toContain('Location');
    expect(excluded).not.toContain('Place');

    // Deselected: event/content/file/item/communication map to graph types that must be excluded.
    expect(excluded).toContain('Event');
    expect(excluded).toContain('Content');
    expect(excluded).toContain('File');
    expect(excluded).toContain('Communication');
    expect(excluded).toEqual(expect.arrayContaining(['Object', 'Item', 'Thing']));
  });

  // Regression: the mapping is many-to-many (note+content -> Content, browser-activity ->
  // Event+Content), so an exclusion set built only from the deselected types excluded the graph
  // type the user had *selected*. Every single-type selection must survive its own mapping.
  it.each(Object.keys(EXPLORER_TO_GRAPH_ENTITY_TYPES))(
    'keeps every graph type mapped from the only selected explorer type: %s',
    (explorerType) => {
      const excluded = new Set(graphTypesToExclude([explorerType]));

      for (const graphType of EXPLORER_TO_GRAPH_ENTITY_TYPES[explorerType]) {
        expect(excluded.has(graphType)).toBe(false);
      }
    },
  );

  it('keeps Event when only events are selected, even though browser-activity also maps to it', () => {
    const excluded = graphTypesToExclude(['event']);

    expect(excluded).not.toContain('Event');
    // browser-activity's other graph type has no selected owner, so it still goes.
    expect(excluded).toContain('Content');
    expect(excluded).toContain('Communication');
    expect(excluded).toContain('File');
  });

  it('keeps Content when only content (or only note) is selected', () => {
    expect(graphTypesToExclude(['content'])).not.toContain('Content');
    expect(graphTypesToExclude(['note'])).not.toContain('Content');
  });

  it('keeps both of browser-activity’s graph types when it is the only selection', () => {
    const excluded = graphTypesToExclude(['browser-activity']);

    expect(excluded).not.toContain('Event');
    expect(excluded).not.toContain('Content');
    expect(excluded).toContain('Person');
  });

  it('keeps a selected type that a deselected type shares, in a multi-type selection', () => {
    const excluded = graphTypesToExclude(['event', 'communication']);

    expect(excluded).not.toContain('Event');
    expect(excluded).not.toContain('Communication');
    expect(excluded).toContain('Content');
  });

  it('never excludes connective CTI types (Pet, Group, Concept)', () => {
    const excluded = graphTypesToExclude(['person']);

    for (const connective of ['Concept', 'Goal', 'Tag', 'Pet', 'Group']) {
      expect(excluded).not.toContain(connective);
    }
  });

  it('excludes every mappable graph type when nothing is selected', () => {
    const excluded = new Set(graphTypesToExclude([]));

    const allMappable = Object.values(EXPLORER_TO_GRAPH_ENTITY_TYPES).flat();
    for (const graphType of allMappable) {
      expect(excluded.has(graphType)).toBe(true);
    }

    // Still never touches connective types.
    expect(excluded.has('Concept')).toBe(false);
  });
});

describe('graphEntityKindOf', () => {
  // The spellings `ci.entities` holds each kind under: a person is a Person or a Contact, a place is what
  // the geocoder mints (Location) or what memory.remember writes (Place), a concept is a Concept.
  it.each([
    ['Person', 'person'],
    ['Contact', 'person'],
    ['Location', 'place'],
    ['Place', 'place'],
    ['Concept', 'concept'],
  ])('names a %s node a %s', (entityType, kind) => {
    expect(graphEntityKindOf(entityType)).toBe(kind);
  });

  // Every other node has a purge of its own, or none: a detail table behind it, or no service at all.
  it.each([
    'Event',
    'Content',
    'Communication',
    'Item',
    'Object',
    'Thing',
    'File',
    'Product',
    'Organization',
  ])('names a %s node nothing', (entityType) => {
    expect(graphEntityKindOf(entityType)).toBeNull();
  });

  it('names a type it has never heard of nothing, and nothing nothing', () => {
    expect(graphEntityKindOf('Restaurant')).toBeNull();
    expect(graphEntityKindOf('')).toBeNull();
    expect(graphEntityKindOf(null)).toBeNull();
    expect(graphEntityKindOf(undefined)).toBeNull();
  });

  it('matches the spelling exactly, as PersonService and the importers’ upsert key do', () => {
    // `valid_entity_type` refuses a lower-case first letter, and a PERSON is stored but invisible to PersonService.
    expect(graphEntityKindOf('person')).toBeNull();
    expect(graphEntityKindOf('PERSON')).toBeNull();
  });
});

describe('GRAPH_ENTITY_TYPES', () => {
  it('agrees with the explorer vocabulary about which graph types are a person and a place', () => {
    expect([...GRAPH_ENTITY_TYPES.person].sort()).toEqual([...EXPLORER_TO_GRAPH_ENTITY_TYPES.person].sort());
    expect([...GRAPH_ENTITY_TYPES.place].sort()).toEqual([...EXPLORER_TO_GRAPH_ENTITY_TYPES.place].sort());
    expect(GRAPH_ENTITY_TYPES.concept).toEqual(['Concept']);
  });

  it('holds only types the graph vocabulary lists, and no type under two kinds', () => {
    const all = [...GRAPH_ENTITY_TYPES.person, ...GRAPH_ENTITY_TYPES.place, ...GRAPH_ENTITY_TYPES.concept];

    expect(new Set(all).size).toBe(all.length);

    for (const type of all) {
      expect(ENTITY_TYPES as readonly string[]).toContain(type);
    }
  });
});
