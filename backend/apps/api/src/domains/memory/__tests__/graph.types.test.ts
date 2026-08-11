import { EXPLORER_TO_GRAPH_ENTITY_TYPES, graphTypesToExclude } from '../graph.types';

const ALL_EXPLORER_TYPES = Object.keys(EXPLORER_TO_GRAPH_ENTITY_TYPES);

describe('graphTypesToExclude', () => {
  it('returns [] when every explorer type is selected (filter inactive)', () => {
    expect(graphTypesToExclude(ALL_EXPLORER_TYPES)).toEqual([]);
  });

  it('excludes graph types mapped from deselected explorer types, keeping the selected ones', () => {
    const excluded = graphTypesToExclude(['person', 'place']);

    // Selected: person -> Person, place -> Location must survive.
    expect(excluded).not.toContain('Person');
    expect(excluded).not.toContain('Location');

    // Deselected: event/content/file/item/communication map to graph types that must be excluded.
    expect(excluded).toContain('Event');
    expect(excluded).toContain('Content');
    expect(excluded).toContain('File');
    expect(excluded).toContain('Communication');
    expect(excluded).toEqual(expect.arrayContaining(['Object', 'Item']));
    expect(excluded).not.toContain('Thing');
  });

  it('never excludes connective NER types (no explorer equivalent)', () => {
    const excluded = graphTypesToExclude(['person']);

    for (const connective of ['Concept', 'Goal', 'Tag']) {
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
