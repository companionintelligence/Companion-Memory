import { dataClassesIn, formForArchetype, parseAskGrammar, toAskQuery } from './askGrammar';

const VALID = {
  prompt: 'Do you have photos of us from the lake trip?',
  queries: [{ id: 'q1', archetype: 'content' as const, dataClass: 'photos' }],
};

describe('parseAskGrammar', () => {
  it('accepts a minimal well-formed ask', () => {
    expect(parseAskGrammar(VALID).queries[0].archetype).toBe('content');
  });

  it('rejects unknown archetypes', () => {
    expect(() => parseAskGrammar({ ...VALID, queries: [{ id: 'q1', archetype: 'exfiltrate' }] })).toThrow();
  });

  it('strips nothing — unknown keys are a hard error, not silently ignored', () => {
    expect(() => parseAskGrammar({ ...VALID, evil: true })).toThrow();
    expect(() =>
      parseAskGrammar({ ...VALID, queries: [{ id: 'q1', archetype: 'content', sqlWhere: '1=1' }] }),
    ).toThrow();
  });

  it('bounds every collection and string', () => {
    expect(() => parseAskGrammar({ ...VALID, prompt: 'x'.repeat(501) })).toThrow();
    expect(() => parseAskGrammar({ ...VALID, queries: [] })).toThrow();
    expect(() =>
      parseAskGrammar({
        ...VALID,
        queries: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, archetype: 'content' })),
      }),
    ).toThrow();
  });

  describe('claim paths', () => {
    const withPath = (path: string) => ({
      ...VALID,
      queries: [{ id: 'q1', archetype: 'content' as const, claims: [{ path }] }],
    });

    it('accepts dotted lowercase claim names', () => {
      expect(() => parseAskGrammar(withPath('event.title'))).not.toThrow();
    });

    it('rejects traversal, wildcards and injection shapes', () => {
      for (const bad of ['../secrets', '*', 'a..b', 'Event.Title', "a'; DROP", 'a b', '$.a', '']) {
        expect(() => parseAskGrammar(withPath(bad))).toThrow();
      }
    });
  });

  describe('time window', () => {
    const win = (from?: string, to?: string) => ({
      ...VALID,
      queries: [{ id: 'q1', archetype: 'content' as const, from, to }],
    });

    it('requires both bounds together', () => {
      expect(() => parseAskGrammar(win('2026-08-01T00:00:00Z', undefined))).toThrow();
      expect(() => parseAskGrammar(win(undefined, '2026-08-01T00:00:00Z'))).toThrow();
    });

    it('rejects an inverted window', () => {
      expect(() => parseAskGrammar(win('2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z'))).toThrow();
    });
  });

  it('rejects duplicate query ids', () => {
    expect(() =>
      parseAskGrammar({
        ...VALID,
        queries: [
          { id: 'dup', archetype: 'content' },
          { id: 'dup', archetype: 'relationship' },
        ],
      }),
    ).toThrow();
  });

  it('rejects a querySet referencing an unknown id (it would match nothing)', () => {
    expect(() => parseAskGrammar({ ...VALID, querySets: [{ options: [['ghost']] }] })).toThrow();
  });
});

describe('toAskQuery', () => {
  it('projects the PRIMARY query onto the fields the grant gate matches', () => {
    const q = toAskQuery(parseAskGrammar(VALID));
    expect(q.queryType).toBe('content');
    expect(q.dataClass).toBe('photos');
    expect(q.prompt).toBe(VALID.prompt);
  });

  it('does not let an appended alternative widen the grant match', () => {
    const grammar = parseAskGrammar({
      ...VALID,
      queries: [
        { id: 'q1', archetype: 'content', dataClass: 'photos' },
        { id: 'q2', archetype: 'content', dataClass: 'health' },
      ],
    });
    const q = toAskQuery(grammar);
    // the gate still sees only the primary class
    expect(q.dataClass).toBe('photos');
    // ...but the sensitive class is still visible for ceiling evaluation
    expect(dataClassesIn(grammar)).toEqual(['photos', 'health']);
  });

  it('carries purpose through for purpose-bound grants', () => {
    const q = toAskQuery(parseAskGrammar({ ...VALID, purpose: 'wedding invites' }));
    expect(q.filters?.purpose).toBe('wedding invites');
  });
});

describe('formForArchetype', () => {
  it('fixes the disclosure surface per archetype', () => {
    expect(formForArchetype('relationship')).toBe('boolean');
    expect(formForArchetype('content')).toBe('existence');
    expect(formForArchetype('availability')).toBe('attribute');
    expect(formForArchetype('identity')).toBe('identity');
  });
});
