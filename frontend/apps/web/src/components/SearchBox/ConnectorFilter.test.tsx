import { describe, expect, it } from 'vitest';

import { sourceSystemsVariables } from './ConnectorFilter';

describe('sourceSystemsVariables', () => {
  it('asks for every browsed kind when the What bar is not narrowed', () => {
    expect(sourceSystemsVariables(new URLSearchParams('view=list'))).toEqual({});
  });

  it("pares the list to the kinds the What bar has selected, in the search index's names", () => {
    expect(sourceSystemsVariables(new URLSearchParams('includedEntityTypes=Content,Browser'))).toEqual({
      includeTypes: ['browser-activity', 'content'],
    });
  });

  it('follows the When override, so a source that only undated kinds carry is not offered', () => {
    const params = new URLSearchParams(
      'from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z&includedEntityTypes=Content,Event',
    );

    expect(sourceSystemsVariables(params)).toEqual({ includeTypes: ['event'] });
  });
});
