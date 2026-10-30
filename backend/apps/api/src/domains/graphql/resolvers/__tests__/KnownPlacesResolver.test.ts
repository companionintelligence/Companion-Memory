import type { RequestContext } from '@ci/common/context';

import { KnownPlacesResolver } from '../KnownPlacesResolver';

const context = { userId: 'owner-1' } as unknown as RequestContext;

const place = {
  id: 'relationship-1',
  locationId: 'location-1',
  label: 'Corner gym',
  kind: 'other' as const,
  coordinates: { lat: 34.1, lng: -118.2 },
  confidence: 0.9,
  activeFrom: null,
  activeTo: null,
  aliases: [],
  source: 'manual' as const,
};

function makeResolver() {
  const knownPlacesService = {
    getKnownPlaces: jest.fn().mockResolvedValue([place]),
    buildKnownPlaces: jest.fn().mockResolvedValue([]),
    updateKnownPlace: jest.fn().mockResolvedValue(place),
  };
  const dailyMetricsService = {
    refreshForUser: jest.fn().mockResolvedValue(undefined),
  };
  const tagService = {
    getTagsForEntities: jest.fn(async (_context, refs: Array<{ type: 'place'; id: string }>) => {
      return new Map([[refs[0], [{ id: 'tag-1', label: 'gym', taggedAt: new Date() }]]]);
    }),
    replaceEntityTags: jest.fn().mockResolvedValue(true),
    getTagsForEntity: jest.fn().mockResolvedValue([{ id: 'tag-1', label: 'gym', taggedAt: new Date() }]),
  };

  return {
    resolver: new KnownPlacesResolver(
      knownPlacesService as never,
      dailyMetricsService as never,
      tagService as never,
    ),
    knownPlacesService,
    dailyMetricsService,
    tagService,
  };
}

describe('KnownPlacesResolver tags', () => {
  it('projects the underlying Place tags with every known place', async () => {
    const { resolver, tagService } = makeResolver();

    const result = await resolver.knownPlaces(context);

    expect(tagService.getTagsForEntities).toHaveBeenCalledWith({ userId: 'owner-1' }, [
      { type: 'place', id: 'location-1' },
    ]);
    expect(result[0]).toMatchObject({ id: 'relationship-1', tags: ['gym'] });
  });

  it('replaces tags and identifies the relationship being recategorized in one mutation', async () => {
    const { resolver, knownPlacesService, tagService } = makeResolver();

    const result = await resolver.updateKnownPlace(context, {
      knownPlaceId: 'relationship-1',
      label: 'Corner gym',
      kind: 'social',
      locationId: 'location-1',
      tags: ['social', 'gym'],
    });

    expect(knownPlacesService.updateKnownPlace).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({
        knownPlaceId: 'relationship-1',
        kind: 'social',
        locationId: 'location-1',
      }),
    );
    expect(tagService.replaceEntityTags).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      { type: 'place', id: 'location-1' },
      ['social', 'gym'],
    );
    expect(result.tags).toEqual(['gym']);
  });
});
