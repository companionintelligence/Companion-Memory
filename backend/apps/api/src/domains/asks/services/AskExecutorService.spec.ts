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

function makeService(
  result: Partial<{
    items: { id: string; type: string }[];
    totalMatches: number;
    truncated: boolean;
    limit: number;
  }> = {},
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
  const service = new AskExecutorService(searchService as never, logger as never);

  return { service, searchService, logger };
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
      { prompt: 'lake', subjectIsName: false, maxResults: 50, includeTypes: ['file'] },
    );
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
