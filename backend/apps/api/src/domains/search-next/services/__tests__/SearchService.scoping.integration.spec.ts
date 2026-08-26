import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { SearchService } from '../SearchService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE SQL ACTUALLY SCOPE BY USER AND TYPE, AGAINST A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * search()/keywordSearch()/semanticSearch()/boostedKeywordSearch() are this
 * appliance's primary retrieval path and had zero coverage beyond the
 * separate searchMessages() RAG channel. The two things the audit calls out
 * as catastrophic if they regress — a dropped `WHERE user_id = $1` leaking
 * another user's rows, or a broken type filter returning the wrong union of
 * entity kinds — are exactly the kind of bug a mocked DataSource cannot
 * catch (a mock returns whatever the test tells it to, regardless of what
 * WHERE clause was actually sent). SearchService.dispatch.test.ts pins the
 * mode-routing logic with a mock; this file seeds two users' worth of real
 * rows and proves each search strategy only ever returns the CALLER's own,
 * correctly-typed rows.
 */

const SEARCH_NEXT_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(SEARCH_NEXT_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/SearchService.scoping.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

// A fixed 768-dim unit-ish vector. Every seeded embedding uses the SAME
// vector, so cosine distance to the (also fixed) query vector is 0 for every
// row regardless of which entity/user it belongs to — the only thing that
// can exclude a row from results is the SQL's WHERE clause (user_id, type),
// which is exactly what these tests are proving.
const FIXED_VECTOR = `[${Array(768).fill('0.1').join(',')}]`;

describeWithDatabase(`SearchService scoping against a live Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: SearchService;

  const userA = randomUUID();
  const userB = randomUUID();
  const contextA = { userId: userA } as UserServiceContext;

  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn().mockResolvedValue(FIXED_VECTOR),
  } as unknown as EmbeddingGenerationService;

  const seedVector = async (userId: string, entityType: string, text: string, entityId = randomUUID()) => {
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, $2, $3, setweight(to_tsvector('english', $4), 'A'), $5)`,
      [randomUUID(), entityType, entityId, text, userId],
    );

    return entityId;
  };

  const seedEmbedding = async (userId: string, entityType: string, entityId = randomUUID()) => {
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, embedding, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), entityType, entityId, FIXED_VECTOR, userId],
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
        [userA, userB],
      ]);
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = ANY($1::uuid[])', [
        [userA, userB],
      ]);
      await dataSource.destroy();
    }
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [[userA, userB]]);
    await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = ANY($1::uuid[])', [
      [userA, userB],
    ]);
  });

  describe('keywordSearch (mode: keyword)', () => {
    it("never returns another user's row, even for the identical matching term", async () => {
      await seedVector(userA, 'person', 'mochi the golden retriever');
      await seedVector(userB, 'person', 'mochi the golden retriever');

      const results = await service.search(contextA, { query: 'mochi', mode: 'keyword' });

      expect(results).toHaveLength(1);
      // Confirm it's genuinely user A's row, not an accidental match: re-query
      // directly, scoped, and compare entity ids.
      const [ownRow] = await dataSource.query(
        'SELECT entity_id FROM ci_search.vectors WHERE user_id = $1::uuid',
        [userA],
      );
      expect(results[0].id).toBe(ownRow.entity_id);
    });

    it('includeTypes restricts the result to exactly that type', async () => {
      await seedVector(userA, 'person', 'mochi the dog');
      await seedVector(userA, 'place', 'mochi cafe');

      const results = await service.search(contextA, {
        query: 'mochi',
        mode: 'keyword',
        includeTypes: ['person'],
      });

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('person');
    });

    it('excludeTypes drops exactly that type and keeps the rest', async () => {
      await seedVector(userA, 'person', 'mochi the dog');
      await seedVector(userA, 'place', 'mochi cafe');

      const results = await service.search(contextA, {
        query: 'mochi',
        mode: 'keyword',
        excludeTypes: ['place'],
      });

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('person');
    });
  });

  describe('semanticSearch (mode: semantic)', () => {
    it("never returns another user's embedding row", async () => {
      await seedEmbedding(userA, 'person');
      await seedEmbedding(userB, 'person');

      const results = await service.search(contextA, { query: 'irrelevant text', mode: 'semantic' });

      expect(results).toHaveLength(1);
      const [ownRow] = await dataSource.query(
        'SELECT entity_id FROM ci_search.embeddings WHERE user_id = $1::uuid',
        [userA],
      );
      expect(results[0].id).toBe(ownRow.entity_id);
    });

    it('includeTypes restricts the result to exactly that type', async () => {
      await seedEmbedding(userA, 'person');
      await seedEmbedding(userA, 'place');

      const results = await service.search(contextA, {
        query: 'irrelevant text',
        mode: 'semantic',
        includeTypes: ['place'],
      });

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('place');
    });
  });

  describe('boostedKeywordSearch (mode: boosted)', () => {
    it("never returns another user's row even when both keyword and embedding tables carry the match", async () => {
      // Same entity id in both tables per user, so a correctly-scoped result
      // set is unambiguous: exactly one row, belonging to the caller.
      const entityIdA = randomUUID();
      const entityIdB = randomUUID();
      await seedVector(userA, 'person', 'mochi the dog', entityIdA);
      await seedEmbedding(userA, 'person', entityIdA);
      await seedVector(userB, 'person', 'mochi the dog', entityIdB);
      await seedEmbedding(userB, 'person', entityIdB);

      const results = await service.search(contextA, { query: 'mochi', mode: 'boosted' });

      expect(results).toEqual([{ id: entityIdA, type: 'person' }]);
    });
  });

  describe('hybridSearch (mode: hybrid)', () => {
    it("fuses both channels but still never leaks another user's row", async () => {
      const entityIdA = randomUUID();
      const entityIdB = randomUUID();
      await seedVector(userA, 'person', 'mochi the dog', entityIdA);
      await seedEmbedding(userA, 'person', entityIdA);
      await seedVector(userB, 'person', 'mochi the dog', entityIdB);
      await seedEmbedding(userB, 'person', entityIdB);

      const results = await service.search(contextA, { query: 'mochi', mode: 'hybrid' });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.id === entityIdA)).toBe(true);
    });
  });
});
