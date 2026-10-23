import { describe, expect, it } from 'vitest';

import { localListOptionsFromParams } from './localListParams';

const params = (query: string) => new URLSearchParams(query);

describe('localListOptionsFromParams', () => {
  it('reads the search, tags, sort and date range the explorer URL carries', () => {
    const { query, ignored, nothingLeft } = localListOptionsFromParams(
      params(
        'view=list&search=harbour&tags=vacation&tags=family&from=2026-01-01T00:00:00.000Z&to=2026-01-07T23:59:59.999Z&sortBy=time&sortOrder=asc',
      ),
      '/memory',
    );

    expect(query).toMatchObject({
      query: 'harbour',
      tags: ['vacation', 'family'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-07T23:59:59.999Z',
      sort: 'oldest',
    });
    expect(ignored).toEqual([]);
    expect(nothingLeft).toBe(false);
  });

  it('maps the What picker names to the device types the way the appliance request does', () => {
    const { query } = localListOptionsFromParams(
      params('view=list&includedEntityTypes=Thing,Person'),
      '/memory',
    );

    // In the What picker's own order (Person before Thing), as the appliance request is.
    expect(query.includeTypes).toEqual(['person', 'item']);
  });

  it('a When filter keeps only dated kinds, and says when nothing is left', () => {
    const range = 'from=2026-01-01T00:00:00.000Z&to=2026-01-07T23:59:59.999Z';
    const dated = localListOptionsFromParams(
      params(`view=list&${range}&includedEntityTypes=Event,Person`),
      '/memory',
    );

    expect(dated.query.includeTypes).toEqual(['event']);
    expect(dated.nothingLeft).toBe(false);

    const none = localListOptionsFromParams(
      params(`view=list&${range}&includedEntityTypes=Person`),
      '/memory',
    );

    expect(none.nothingLeft).toBe(true);
  });

  it('relevance when there is no time sort, newest for Newest', () => {
    expect(localListOptionsFromParams(params('view=list&search=x'), '/memory').query.sort).toBe('relevance');
    expect(
      localListOptionsFromParams(params('view=list&sortBy=time&sortOrder=desc'), '/memory').query.sort,
    ).toBe('newest');
  });

  it('reads every structured filter the explorer URL carries', () => {
    const { query, ignored } = localListOptionsFromParams(
      params(
        'view=list&people=Ana&people=Brian&places=Harbour&connectors=gmail,discord&eventTypes=meal&direction=inbound&fileKinds=image,video&hasLocation=1&areas=-118,33,-117,34',
      ),
      '/memory',
    );

    expect(query).toMatchObject({
      people: ['Ana', 'Brian'],
      places: ['Harbour'],
      connectors: ['gmail', 'discord'],
      eventTypes: ['meal'],
      direction: 'inbound',
      fileKinds: ['image', 'video'],
      hasLocation: true,
      areas: [[-118, 33, -117, 34]],
    });
    expect(ignored).toEqual([]);
  });

  it('names semantic search as the one filter the device cannot apply', () => {
    expect(localListOptionsFromParams(params('view=list&search=x&semantic=1'), '/memory').ignored).toEqual([
      'semantic',
    ]);
    expect(localListOptionsFromParams(params('view=list&search=x&semantic=0'), '/memory').ignored).toEqual(
      [],
    );
  });
});
