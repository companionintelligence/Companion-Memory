import { sourcedTablesForTypes } from './SourceSystemService';

const types = (legs: ReturnType<typeof sourcedTablesForTypes>) => legs.map((leg) => leg.type);

describe('sourcedTablesForTypes', () => {
  it('offers the default browse kinds when nothing is narrowed', () => {
    expect(types(sourcedTablesForTypes())).toEqual(['event', 'communication', 'content', 'browser-activity']);
  });

  it('follows a What selection exactly, including the opt-in kinds it names', () => {
    expect(types(sourcedTablesForTypes(['content', 'receipt']))).toEqual(['content', 'receipt']);
  });

  it('drops excluded kinds from the default set', () => {
    expect(types(sourcedTablesForTypes(undefined, ['event', 'communication']))).toEqual([
      'content',
      'browser-activity',
    ]);
  });

  it('yields nothing for kinds that record no source', () => {
    // People only: nothing to list, so the picker shows it has no sources.
    expect(sourcedTablesForTypes(['person'])).toEqual([]);
  });
});
