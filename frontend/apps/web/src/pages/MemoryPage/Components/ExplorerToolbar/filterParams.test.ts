import { describe, expect, it } from 'vitest';

import { explorerSearchTypeFilters, narrowedEntityTypes } from './filterParams';

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
