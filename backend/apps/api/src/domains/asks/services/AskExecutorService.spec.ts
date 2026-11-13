import { type Ask } from '../entities/AskEntity';

import { AskExecutorService } from './AskExecutorService';

function fakeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: 'ask-1',
    askerUserId: 'asker-1',
    responderUserId: 'responder-1',
    query: { queryType: 'photos', prompt: 'beach photos?' },
    status: 'answering',
    consentBasis: null,
    createdAt: new Date('2026-07-15T00:00:00Z'),
    updatedAt: new Date('2026-07-15T00:00:00Z'),
    expiresAt: null,
    ...overrides,
  } as Ask;
}

const NO_PLACE = { places: [], fileIds: [], total: 0 };

function makeService(
  result: Partial<{
    items: { id: string; type: string }[];
    totalMatches: number;
    truncated: boolean;
    limit: number;
  }> = {},
  atPlace: { places: { id: string; name: string }[]; fileIds: string[]; total: number } = NO_PLACE,
) {
  const searchService = {
    searchPrompt: jest.fn().mockResolvedValue({
      items: [{ id: 'e1', type: 'file' }],
      totalMatches: 1,
      truncated: false,
      limit: 50,
      ...result,
    }),
    // Present so a regression back to the loose OR-joined keyword mode shows up
    // as an assertion here rather than as a false "Yes." on a peer's screen.
    search: jest.fn().mockResolvedValue([]),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const places = { photosAtNamedPlace: jest.fn().mockResolvedValue(atPlace) };
  const service = new AskExecutorService(searchService as never, logger as never, places as never);

  return { service, searchService, logger, places };
}

describe('AskExecutorService.execute', () => {
  it('runs the query in the RESPONDER scope, as a prompt search', async () => {
    const { service, searchService } = makeService();

    const result = await service.execute(fakeAsk({ query: { queryType: 'x', prompt: 'ramen place' } }));

    expect(searchService.searchPrompt).toHaveBeenCalledWith(
      { userId: 'responder-1' }, // run-as-owner: the responder, never the asker
      { prompt: 'ramen place', subjectIsName: false, maxResults: 50 },
    );
    expect(result).toEqual([{ id: 'e1', type: 'file' }]);
  });

  it('maps a known data class to entity-type filters', async () => {
    const { service, searchService } = makeService();

    await service.execute(fakeAsk({ query: { queryType: 'x', dataClass: 'photos', prompt: 'lake' } }));

    expect(searchService.searchPrompt).toHaveBeenCalledWith(
      { userId: 'responder-1' },
      {
        prompt: 'lake',
        subjectIsName: false,
        maxResults: 50,
        includeTypes: ['file'],
        mediaEvents: 'photos',
        mediaEventPlaces: false,
      },
    );
  });

  it('lets a photo ask match an event by its place only for a tier that may learn places', async () => {
    // "Any photos from 14 Elm Street?" matched on a photo event's place answers
    // a location question at the photos ceiling. Below household the location
    // ceiling is lower, so the place there must not match.
    const { service, searchService } = makeService();
    const ask = fakeAsk({
      query: { queryType: 'content', dataClass: 'photos', prompt: 'Any photos from 14 Elm Street?' },
    });

    await service.execute(ask, { tier: 'stranger' });
    await service.execute(ask, { tier: 'family' });
    await service.execute(ask, { tier: 'household' });
    await service.execute(ask);

    expect(searchService.searchPrompt.mock.calls.map((call) => call[1].mediaEventPlaces)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it('searches photo events beside files for a photo ask, and no events for other file classes', async () => {
    // A photo's place and capture date are on its event, so "photos from
    // Lisbon" filtered to files alone could only ever answer "none".
    const { service, searchService } = makeService();

    await service.execute(fakeAsk({ query: { queryType: 'x', dataClass: 'media', prompt: 'Lisbon' } }));
    await service.execute(fakeAsk({ query: { queryType: 'x', dataClass: 'files', prompt: 'Lisbon' } }));
    await service.execute(fakeAsk({ query: { queryType: 'x', dataClass: 'events', prompt: 'Lisbon' } }));

    expect(searchService.searchPrompt.mock.calls[0][1]).toMatchObject({
      includeTypes: ['file'],
      mediaEvents: 'media',
    });
    expect(searchService.searchPrompt.mock.calls[1][1]).not.toHaveProperty('mediaEvents');
    expect(searchService.searchPrompt.mock.calls[2][1]).not.toHaveProperty('mediaEvents');
  });

  it('reads "photos of …" in a class-less ask as the photos class', async () => {
    // buildPromptQuery no longer lets the word 'photos' match (it matched every
    // photo event, so "photos of the volcano" answered "at least one" for
    // anyone with photos). The kind it named becomes the type filter instead.
    const { service, searchService } = makeService();

    await service.execute(
      fakeAsk({ query: { queryType: 'content', prompt: 'Do you have any photos of the volcano?' } }),
    );

    expect(searchService.searchPrompt).toHaveBeenCalledWith(
      { userId: 'responder-1' },
      {
        prompt: 'Do you have any photos of the volcano?',
        subjectIsName: false,
        maxResults: 50,
        includeTypes: ['file'],
        mediaEvents: 'photos',
        mediaEventPlaces: false,
      },
    );
  });

  it('reads "videos of …" as the media class and a blank class as no class', async () => {
    const { service, searchService } = makeService();

    await service.execute(fakeAsk({ query: { queryType: 'content', prompt: 'Any videos of the volcano?' } }));
    // A zero-width class canonicalizes to nothing, which the grant evaluator
    // also reads as "no class named".
    await service.execute(
      fakeAsk({ query: { queryType: 'content', dataClass: '​', prompt: 'photos of the volcano' } }),
    );

    expect(searchService.searchPrompt.mock.calls[0][1]).toHaveProperty('includeTypes', ['file']);
    expect(searchService.searchPrompt.mock.calls[1][1]).toHaveProperty('includeTypes', ['file']);
  });

  it('does not read a kind into a name ask or a capitalised name', async () => {
    const { service, searchService } = makeService();

    await service.execute(fakeAsk({ query: { queryType: 'relationship', prompt: 'photos smith' } }));
    await service.execute(fakeAsk({ query: { queryType: 'content', prompt: 'my Google Photos backup' } }));

    expect(searchService.searchPrompt.mock.calls[0][1]).not.toHaveProperty('includeTypes');
    expect(searchService.searchPrompt.mock.calls[1][1]).not.toHaveProperty('includeTypes');
  });

  it('leaves an unknown data class unfiltered (still responder-scoped)', async () => {
    const { service, searchService } = makeService();

    await service.execute(fakeAsk({ query: { queryType: 'x', dataClass: 'nonsense', prompt: 'q' } }));

    expect(searchService.searchPrompt).toHaveBeenCalledWith(
      { userId: 'responder-1' },
      { prompt: 'q', subjectIsName: false, maxResults: 50 },
    );
  });

  it('refuses to execute an ask with no local responder', async () => {
    const { service, searchService } = makeService();

    await expect(service.execute(fakeAsk({ responderUserId: null }))).rejects.toThrow('no local responder');
    expect(searchService.searchPrompt).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE ASKER'S SENTENCE NEVER REACHES THE LOOSE KEYWORD MODE ═══
   *
   * `search({ mode: 'keyword' })` OR-joins every token with no floor. That is
   * the right behaviour for the owner searching their own memory and a
   * fabrication risk for an ask: on the owner's real 19,241-entity archive it
   * answered "Yes." to "Have you seen <invented name>?" with 297 matches, every
   * one of them on the word 'seen'. If this assertion ever fails, the box has
   * gone back to answering questions about people who do not exist.
   */
  it('never routes an ask through the loose OR-joined keyword search', async () => {
    const { service, searchService } = makeService();

    await service.execute(fakeAsk());

    expect(searchService.search).not.toHaveBeenCalled();
  });
});

describe('AskExecutorService name-subject binding', () => {
  /**
   * A relationship ask's prompt is a PERSON, not a topic: the peer wire puts
   * `relationshipAskSchema.subject` straight into it. Binding it as a phrase is
   * what stops "David Miller" being answered by Steve Miller. Flip this flag off
   * and that fabrication comes back.
   */
  it.each(['relationship', 'know', 'boolean', 'identity', 'identity-claim', 'confirm', 'are-you'])(
    'treats a %s ask as a name',
    async (queryType) => {
      const { service, searchService } = makeService();

      await service.execute(fakeAsk({ query: { queryType, prompt: 'David Miller' } }));

      expect(searchService.searchPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subjectIsName: true }),
      );
    },
  );

  it('is case-insensitive about the archetype the asker declared', async () => {
    const { service, searchService } = makeService();

    await service.execute(fakeAsk({ query: { queryType: 'Relationship', prompt: 'David Miller' } }));

    expect(searchService.searchPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectIsName: true }),
    );
  });

  /**
   * The inverse matters just as much. Nothing in a corpus carries 'photo'
   * adjacent to 'beach', so binding a TOPIC ask as a name would answer "no" to
   * every content question — eliminating the false positives by eliminating all
   * results, which is not a fix.
   */
  it.each(['photos', 'content', 'documents', 'events', 'attribute'])(
    'treats a %s ask as a topic',
    async (queryType) => {
      const { service, searchService } = makeService();

      await service.execute(fakeAsk({ query: { queryType, prompt: 'photos of the beach' } }));

      expect(searchService.searchPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subjectIsName: false }),
      );
    },
  );

  it('SECURITY (G1): forces subjectIsName=true when a topic queryType carries a lowercase "do you know" prompt', async () => {
    const { service, searchService } = makeService();

    await service.execute(fakeAsk({ query: { queryType: 'content', prompt: 'do you know david miller' } }));

    expect(searchService.searchPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectIsName: true }),
    );
  });
});

describe('AskExecutorService.executeWithMeta', () => {
  it('carries the truncation signal through to the caller', async () => {
    const { service } = makeService({
      items: Array.from({ length: 50 }, (_unused, index) => ({ id: `e${index}`, type: 'file' })),
      totalMatches: 607,
      truncated: true,
      limit: 50,
    });

    const result = await service.executeWithMeta(fakeAsk());

    expect(result.totalMatches).toBe(607);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(50);
  });

  /**
   * ═══ A COUNT THAT SATURATED IS A NUMBER THAT IS NOT TRUE ═══
   *
   * The disclosure ladder turns 50-of-50 and 50-of-607 into the same figure.
   * The executor cannot make the caller say "at least", so it says so where the
   * OWNER can see it — on the owner's own box, disclosing nothing to the asker.
   */
  it('warns the owner when a disclosed count would be a lower bound', async () => {
    const { service, logger } = makeService({ totalMatches: 607, truncated: true, limit: 50 });

    await service.executeWithMeta(fakeAsk());

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('607'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lower bound'));
  });

  it('stays quiet when the count is exact', async () => {
    const { service, logger } = makeService({ totalMatches: 3, truncated: false });

    await service.executeWithMeta(fakeAsk());

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('honours a caller-supplied cap', async () => {
    const { service, searchService } = makeService();

    await service.executeWithMeta(fakeAsk(), { maxResults: 5 });

    expect(searchService.searchPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxResults: 5 }),
    );
  });
});

/**
 * A photo's place is matched in the text search only through its event's `location_name`, which a geocoder writes.
 * Memory Desktop has none, so "Do you have photos of Blue Bottle Coffee?" answered "They have none." while chat found
 * the photos by where they were taken. A photo ask that names only a place now answers the way chat does.
 */
describe('AskExecutorService photos at a named place', () => {
  const BLUE_BOTTLE = {
    places: [{ id: 'place-1', name: 'Blue Bottle Coffee' }],
    fileIds: ['f1', 'f2', 'f3'],
    total: 8,
  };
  const photoAsk = (prompt: string) =>
    fakeAsk({ query: { queryType: 'content', dataClass: 'photos', prompt } });
  const noTextMatch = { items: [], totalMatches: 0, truncated: false, limit: 50 };

  it('answers with the photos taken at the place, for a tier that may learn places', async () => {
    const { service, places } = makeService(noTextMatch, BLUE_BOTTLE);

    const result = await service.executeWithMeta(photoAsk('Do you have photos of Blue Bottle Coffee?'), {
      tier: 'household',
    });

    expect(places.photosAtNamedPlace).toHaveBeenCalledWith(
      { userId: 'responder-1' },
      'Do you have photos of Blue Bottle Coffee?',
      50,
    );
    expect(result).toEqual({
      items: [
        { id: 'f1', type: 'file' },
        { id: 'f2', type: 'file' },
        { id: 'f3', type: 'file' },
      ],
      totalMatches: 8,
      truncated: true,
      limit: 50,
    });
  });

  it('reads a lowercase place name and "taken at" the same way', async () => {
    const { service } = makeService(noTextMatch, BLUE_BOTTLE);

    const result = await service.executeWithMeta(photoAsk('any photos taken at blue bottle coffee?'), {
      tier: 'household',
    });

    expect(result.totalMatches).toBe(8);
  });

  it('keeps the text search when the prompt also names something the place cannot say', async () => {
    // Every photo taken at the coffee shop is not a photo of the dog.
    const { service } = makeService(noTextMatch, BLUE_BOTTLE);

    const result = await service.executeWithMeta(
      photoAsk('Do you have photos of my dog at Blue Bottle Coffee?'),
      {
        tier: 'household',
      },
    );

    expect(result).toEqual(noTextMatch);
  });

  it('never looks a place up for a tier that may not learn places', async () => {
    const { service, places } = makeService(noTextMatch, BLUE_BOTTLE);
    const ask = photoAsk('Do you have photos of Blue Bottle Coffee?');

    await expect(service.executeWithMeta(ask, { tier: 'family' })).resolves.toEqual(noTextMatch);
    await expect(service.executeWithMeta(ask)).resolves.toEqual(noTextMatch);
    expect(places.photosAtNamedPlace).not.toHaveBeenCalled();
  });

  it('never looks a place up for an ask that is not about photos', async () => {
    const { service, places } = makeService(noTextMatch, BLUE_BOTTLE);

    await service.executeWithMeta(
      fakeAsk({ query: { queryType: 'content', prompt: 'Do you have notes about Blue Bottle Coffee?' } }),
      { tier: 'household' },
    );

    expect(places.photosAtNamedPlace).not.toHaveBeenCalled();
  });

  it('keeps the text search when no photo was taken at the place', async () => {
    const textMatch = { items: [{ id: 'e1', type: 'event' }], totalMatches: 1, truncated: false, limit: 50 };
    const { service } = makeService(textMatch, { ...BLUE_BOTTLE, fileIds: [], total: 0 });

    const result = await service.executeWithMeta(photoAsk('Do you have photos of Blue Bottle Coffee?'), {
      tier: 'household',
    });

    expect(result).toEqual(textMatch);
  });

  it('falls back to the text search, and says so, when the place lookup fails', async () => {
    const { service, places, logger } = makeService(noTextMatch, BLUE_BOTTLE);
    places.photosAtNamedPlace.mockRejectedValue(new Error('connection reset'));

    const result = await service.executeWithMeta(photoAsk('Do you have photos of Blue Bottle Coffee?'), {
      tier: 'household',
    });

    expect(result).toEqual(noTextMatch);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
  });
});
