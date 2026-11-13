import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import { AGENT_TURN_MESSAGE_CATEGORY } from '@ci/domains/memory';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { AGENT_TURN_CATEGORY, SearchService } from '../SearchService';

/**
 * Agents store every conversation turn as a message (`POST /memory/turn`, category `agent-turn`)
 * so they can recall it later, and those turns sat beside real mail in every search a person
 * reads. Seen 2026-11-13: OpenClaw searched "email" newest first and got its own earlier replies
 * back instead of the mail. `showAgentTurnsFrom` hides them unless the caller names the agent, and
 * leaves them alone when absent (recall). Real rows: the rule is a correlated subquery, which a
 * mocked DataSource would accept however wrong.
 */

const SEARCH_NEXT_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(SEARCH_NEXT_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/SearchService.agentTurns.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const FIXED_VECTOR = `[${Array(768).fill('0.1').join(',')}]`;

it('repeats the memory domain constant exactly', () => {
  expect(AGENT_TURN_CATEGORY).toBe(AGENT_TURN_MESSAGE_CATEGORY);
});

describeWithDatabase(`SearchService agent turns (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: SearchService;

  const userId = randomUUID();
  const context = { userId } as UserServiceContext;

  const mail = randomUUID();
  const openclawTurn = randomUUID();
  const hermesTurn = randomUUID();
  const note = randomUUID();

  const seedCommunication = async (
    id: string,
    options: { category?: string; sourceSystem?: string; time: string },
  ) => {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Communication', 'message', $2::uuid, 'communications', $1::uuid)`,
      [id, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, user_id, time, communication_type, direction, category, source_system, content)
       VALUES ($1, $2, $3::timestamptz, 'chat', 'inbound', $4, $5, 'fixture')`,
      [id, userId, options.time, options.category ?? null, options.sourceSystem ?? null],
    );
  };

  const seedIndex = async (entityType: string, entityId: string, text: string) => {
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, $2, $3, setweight(to_tsvector('english', $4), 'A'), $5)`,
      [randomUUID(), entityType, entityId, text, userId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, embedding, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), entityType, entityId, FIXED_VECTOR, userId],
    );
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
      {
        generateEmbeddingString: jest.fn().mockResolvedValue(FIXED_VECTOR),
      } as unknown as EmbeddingGenerationService,
      { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as never,
      { send: jest.fn().mockResolvedValue([]) } as never,
    );

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [userId, 'Agent turn fixture', `agentturns.${userId}@example.invalid`],
    );

    await seedCommunication(mail, { sourceSystem: 'email', time: '2026-11-05T15:14:12Z' });
    await seedCommunication(openclawTurn, {
      category: AGENT_TURN_MESSAGE_CATEGORY,
      sourceSystem: 'openclaw',
      time: '2026-11-13T21:00:00Z',
    });
    // An agent turn stored before turns had a source: hidden all the same.
    await seedCommunication(hermesTurn, {
      category: AGENT_TURN_MESSAGE_CATEGORY,
      time: '2026-11-13T21:05:00Z',
    });

    await seedIndex('communication', mail, 'your grubhub membership email');
    await seedIndex('communication', openclawTurn, 'the most recent email is from grubhub');
    await seedIndex('communication', hermesTurn, 'I found your latest email');
    await seedIndex('note', note, 'email the landlord');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  const ids = (items: { id: string }[]) => items.map((item) => item.id).sort();

  it.each(['keyword', 'semantic', 'boosted', 'hybrid'] as const)(
    'hides every agent turn from a %s page when no agent is named',
    async (mode) => {
      const page = await service.searchPage(context, { query: 'email', mode, showAgentTurnsFrom: [] });

      expect(ids(page.items)).toEqual([mail, note].sort());
    },
  );

  it('shows the turns of a named agent, and only those', async () => {
    const page = await service.searchPage(context, {
      query: 'email',
      mode: 'keyword',
      showAgentTurnsFrom: ['openclaw'],
    });

    expect(ids(page.items)).toEqual([mail, note, openclawTurn].sort());
  });

  it('keeps every turn when the caller sets no rule (recall)', async () => {
    const page = await service.searchPage(context, { query: 'email', mode: 'keyword' });

    expect(ids(page.items)).toEqual([mail, note, openclawTurn, hermesTurn].sort());
  });

  it('counts what the page would show, with and without a term', async () => {
    await expect(service.count(context, { query: 'email', showAgentTurnsFrom: [] })).resolves.toBe(2);
    await expect(service.count(context, { query: 'email', showAgentTurnsFrom: ['openclaw'] })).resolves.toBe(
      3,
    );
    await expect(
      service.count(context, { includeTypes: ['communication'], showAgentTurnsFrom: [] }),
    ).resolves.toBe(1);
    await expect(service.count(context, { includeTypes: ['communication'] })).resolves.toBe(3);
  });

  it('works with a newest-first window', async () => {
    const page = await service.searchPage(context, {
      query: 'email',
      mode: 'keyword',
      sort: 'recent',
      since: new Date('2026-01-01Z'),
      showAgentTurnsFrom: [],
    });

    expect(page.items.map((item) => item.id)).toEqual([mail]);
  });

  it('never writes a source that is not a slug into the statement', async () => {
    const page = await service.searchPage(context, {
      query: 'email',
      mode: 'keyword',
      showAgentTurnsFrom: ["openclaw') OR true --"],
    });

    expect(ids(page.items)).toEqual([mail, note].sort());
  });
});
