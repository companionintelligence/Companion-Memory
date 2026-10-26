import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { SearchService } from '../SearchService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE BOX SAY "NO" TO A QUESTION ABOUT SOMEONE IT NEVER MET?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `searchPrompt` is the retrieval half of the ask path: another person asks
 * this box a question, and whatever this returns becomes a "Yes."/"No."/count
 * disclosed to them. The two ways it can be wrong are not symmetric — returning
 * too little under-answers, returning anything at all for a person who does not
 * exist makes this appliance assert a false claim about its owner to someone
 * whose opinion of the owner matters.
 *
 * Measured on the owner's real 19,241-entity archive with the OLD OR-rewrite:
 *   "Have you seen <invented name>?"           → 297 matches (all on 'seen')
 *   "Do you have photos of <invented name>?"   → 529 matches (all on 'photo')
 *   "Do you know Liam Fnargle?" on box A       → 210 matches → "Yes."
 * All three now return zero, while "Do you know Liam Broza?" — a person who IS
 * there — still returns 31 on the same box.
 *
 * A mocked DataSource cannot prove any of this: `phraseto_tsquery` adjacency,
 * the AND between required phrases and alternative terms, and `count(*) OVER ()`
 * being the pre-LIMIT total are all facts about Postgres, not about our code.
 */

const SEARCH_NEXT_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(SEARCH_NEXT_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/SearchService.promptSearch.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`SearchService.searchPrompt against a live Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: SearchService;

  const owner = randomUUID();
  const stranger = randomUUID();
  const context = { userId: owner } as UserServiceContext;

  // Never called: searchPrompt is keyword-only by construction, so an ask can
  // never make this box compute an embedding of asker-supplied text.
  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn(),
  } as unknown as EmbeddingGenerationService;

  const seed = async (userId: string, entityType: string, text: string) => {
    const entityId = randomUUID();
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, $2, $3, setweight(to_tsvector('english', $4), 'A'), $5)`,
      [randomUUID(), entityType, entityId, text, userId],
    );

    return entityId;
  };

  beforeAll(async () => {
    const connection = resolveConnection(SEARCH_NEXT_DATABASE_ENV);

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();

    service = new SearchService(
      dataSource,
      embeddingGenerationService,
      { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as never,
      { send: jest.fn().mockResolvedValue([]) } as never,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [
        [owner, stranger],
      ]);
      await dataSource.destroy();
    }
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [
      [owner, stranger],
    ]);
    jest.clearAllMocks();
  });

  describe('an invented name gets no for an answer', () => {
    it('returns nothing when neither word of the name is anywhere in memory', async () => {
      await seed(owner, 'person', 'Steve Miller');
      await seed(owner, 'note', 'things I know about hiking');

      const result = await service.searchPrompt(context, {
        prompt: 'Do you know Zerbcorpolis Fnargle?',
        subjectIsName: true,
      });

      expect(result.items).toEqual([]);
      expect(result.totalMatches).toBe(0);
    });

    it('returns nothing when only the SURNAME is in memory, on a different person', async () => {
      // THE HEADLINE DEFECT. 'miller' matches Steve Miller, so the OR rewrite
      // answered "Yes, I know David Miller" — a false claim, invisible to the
      // owner because a boolean answer discloses only the word "Yes".
      await seed(owner, 'person', 'Steve Miller');

      const result = await service.searchPrompt(context, {
        prompt: 'Do you know David Miller?',
        subjectIsName: true,
      });

      expect(result.items).toEqual([]);
    });

    it('returns nothing when only the FIRST name is in memory', async () => {
      await seed(owner, 'person', 'Liam Broza');

      const result = await service.searchPrompt(context, {
        prompt: 'Do you know Liam Fnargle?',
        subjectIsName: true,
      });

      expect(result.items).toEqual([]);
    });

    it('is not rescued by capitalisation the asker never used', async () => {
      await seed(owner, 'person', 'Steve Miller');

      const result = await service.searchPrompt(context, {
        prompt: 'do you know david miller',
        subjectIsName: true,
      });

      expect(result.items).toEqual([]);
    });

    it('returns nothing when a common word in the question matches everything', async () => {
      // "Have you seen X?" used to match every entity carrying 'seen' — 297 of
      // them on the owner's archive. The word describes the asking, not the
      // memory, so it can no longer be the only reason a row comes back.
      await seed(owner, 'note', 'I have not seen that film');
      await seed(owner, 'note', 'seen from the ridge at dawn');

      const result = await service.searchPrompt(context, {
        prompt: 'Have you seen Quixtramble Vorbenhaus?',
      });

      expect(result.items).toEqual([]);
    });

    it('requires a named thing even when the topic word matches hundreds', async () => {
      // A phrase group is a CONSTRAINT, AND-ed with the alternatives. Without
      // that, 'photo' alone answered "yes" 529 times on the owner's archive.
      await seed(owner, 'file', 'holiday photos from the coast');
      await seed(owner, 'file', 'more photos');

      const result = await service.searchPrompt(context, {
        prompt: 'Do you have photos of Zerbcorpolis Fnargle?',
      });

      expect(result.items).toEqual([]);
    });
  });

  describe('photo asks', () => {
    it('does not answer "photos of <topic>" from the word photo alone', async () => {
      // Every photo event carries 'photo'; the OR of terms let that answer
      // "at least one" to "photos of the volcano" for anyone with photos.
      await seed(owner, 'event', 'Photo Oct 22 2026 Google Pixel 9');
      await seed(owner, 'file', 'holiday photos from the coast');

      const result = await service.searchPrompt(context, {
        prompt: 'Do you have any photos of the volcano?',
      });

      expect(result.items).toEqual([]);
    });

    it('finds a photo by its file name, which Postgres indexes as one word', async () => {
      const photo = await seed(owner, 'file', 'PXL_20261021_115500_010.jpg image/jpeg');
      await seed(owner, 'file', 'PXL_20261020_094600_001.jpg image/jpeg');

      const result = await service.searchPrompt(context, {
        prompt: 'Do you have photos of PXL_20261021_115500_010.jpg?',
        includeTypes: ['file'],
      });

      expect(result.items.map((item) => item.id)).toEqual([photo]);
    });
  });

  describe('a real question still gets a real answer', () => {
    it('finds the person the asker actually named, and only them', async () => {
      const steve = await seed(owner, 'person', 'Steve Miller');
      await seed(owner, 'person', 'Karen Davis');
      await seed(owner, 'person', 'Brian Wilson');

      const result = await service.searchPrompt(context, {
        prompt: 'Do you know Steve Miller?',
        subjectIsName: true,
      });

      expect(result.items).toEqual([{ id: steve, type: 'person' }]);
    });

    it('finds them when the asker types the name in lower case', async () => {
      const tom = await seed(owner, 'person', 'Tom Wilson');

      const result = await service.searchPrompt(context, {
        prompt: 'do you know tom wilson',
        subjectIsName: true,
      });

      expect(result.items).toEqual([{ id: tom, type: 'person' }]);
    });

    it('keeps the loose OR for a topic ask, where no entity holds every word', async () => {
      // Nothing carries 'dentist' adjacent to 'appointment'. Requiring that
      // would answer "no dentist appointments" to a box holding two of them —
      // a fix that eliminates false positives by eliminating all results.
      const dentist = await seed(owner, 'event', 'Dentist');
      const apple = await seed(owner, 'event', 'Apple appointment');

      const result = await service.searchPrompt(context, { prompt: 'dentist appointment' });

      expect(result.items.map((item) => item.id).sort()).toEqual([dentist, apple].sort());
    });
  });

  describe('a saturated answer is distinguishable from an exact one', () => {
    it('reports the true total and flags truncation when the cap bites', async () => {
      // A `count` rung reports a NUMBER to another person. Stopping silently at
      // the cap states a figure that is not true about the owner's life.
      for (let index = 0; index < 7; index += 1) {
        await seed(owner, 'file', `beach photo number ${index}`);
      }

      // 'beach', not 'photo': a kind word is no longer a match on its own (see
      // promptQuery's PHOTO_KIND_WORDS).
      const result = await service.searchPrompt(context, { prompt: 'beach', maxResults: 3 });

      expect(result.items).toHaveLength(3);
      expect(result.totalMatches).toBe(7);
      expect(result.truncated).toBe(true);
      expect(result.limit).toBe(3);
    });

    it('does not flag truncation when the set fits exactly', async () => {
      await seed(owner, 'file', 'beach photo one');
      await seed(owner, 'file', 'beach photo two');

      const result = await service.searchPrompt(context, { prompt: 'beach', maxResults: 2 });

      expect(result.items).toHaveLength(2);
      expect(result.totalMatches).toBe(2);
      expect(result.truncated).toBe(false);
    });
  });

  describe('fails closed', () => {
    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['punctuation', '???'],
      ['scaffolding only', 'do you know?'],
    ])('%s matches nothing rather than everything', async (_label, prompt) => {
      await seed(owner, 'note', 'anything at all');
      await seed(owner, 'person', 'someone I know');

      const result = await service.searchPrompt(context, { prompt, subjectIsName: true });

      expect(result.items).toEqual([]);
      expect(result.totalMatches).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('never computes an embedding of asker-supplied text', async () => {
      await seed(owner, 'person', 'Steve Miller');

      await service.searchPrompt(context, { prompt: 'Do you know Steve Miller?', subjectIsName: true });

      expect(embeddingGenerationService.generateEmbeddingString).not.toHaveBeenCalled();
    });
  });

  describe('still scoped', () => {
    it("never returns another user's row for the identical name", async () => {
      const mine = await seed(owner, 'person', 'Steve Miller');
      await seed(stranger, 'person', 'Steve Miller');

      const result = await service.searchPrompt(context, {
        prompt: 'Steve Miller',
        subjectIsName: true,
      });

      expect(result.items).toEqual([{ id: mine, type: 'person' }]);
      expect(result.totalMatches).toBe(1);
    });

    it('honours includeTypes', async () => {
      const person = await seed(owner, 'person', 'Steve Miller');
      await seed(owner, 'note', 'Steve Miller called');

      const result = await service.searchPrompt(context, {
        prompt: 'Steve Miller',
        subjectIsName: true,
        includeTypes: ['person'],
      });

      expect(result.items).toEqual([{ id: person, type: 'person' }]);
    });

    it('excludes raw message fragments by default, as entity search does', async () => {
      const note = await seed(owner, 'note', 'Steve Miller called');
      await seed(owner, 'message', 'Steve Miller called');

      const result = await service.searchPrompt(context, {
        prompt: 'Steve Miller',
        subjectIsName: true,
      });

      expect(result.items).toEqual([{ id: note, type: 'note' }]);
    });
  });
});
