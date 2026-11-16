import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import { AGENT_TURN_MESSAGE_CATEGORY, CommunicationType } from '@ci/domains/memory';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { COMMUNICATION_TYPES, communicationTypeClause, SearchService } from '../SearchService';

/**
 * "My most recent email" has no word to search for. With a term required, Hermes searched
 * "email" and answered with the newest email that contained the word (2026-09-22) while mail
 * from 2026-11-13 sat in the index (seen 2026-11-16). `recentPage` lists the newest entries in
 * scope with no term; `communicationTypes` tells an email from a text or a chat, which share one
 * entity type. Real rows: both rules are correlated subqueries a mocked DataSource would accept
 * however wrong.
 */

const SEARCH_NEXT_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(SEARCH_NEXT_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/SearchService.recentPage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const FIXED_VECTOR = `[${Array(768).fill('0.1').join(',')}]`;

it('repeats the memory domain communication kinds exactly', () => {
  expect([...COMMUNICATION_TYPES].sort()).toEqual(Object.values(CommunicationType).sort());
});

it('never writes a kind that is not a communication type into the statement', () => {
  const clause = communicationTypeClause('v', ['email', "x'); DROP TABLE ci.users; --"]);

  expect(clause).toContain("IN ('email')");
  expect(clause).not.toContain('DROP');
  expect(communicationTypeClause('v', ['letter'])).toContain('IN (NULL)');
});

describeWithDatabase(`SearchService newest entries (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: SearchService;

  const userId = randomUUID();
  const context = { userId } as UserServiceContext;

  const oldEmail = randomUUID();
  const newEmail = randomUUID();
  const text = randomUUID();
  const agentTurn = randomUUID();
  const person = randomUUID();

  const seedCommunication = async (
    id: string,
    options: { kind: string; category?: string; time: string },
  ) => {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Communication', 'message', $2::uuid, 'communications', $1::uuid)`,
      [id, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, user_id, time, communication_type, direction, category, content)
       VALUES ($1, $2, $3::timestamptz, $4::ci.communication_type, 'inbound', $5, 'fixture')`,
      [id, userId, options.time, options.kind, options.category ?? null],
    );
  };

  const seedIndex = async (entityType: string, entityId: string, words: string) => {
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, $2, $3, setweight(to_tsvector('english', $4), 'A'), $5)`,
      [randomUUID(), entityType, entityId, words, userId],
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
      [userId, 'Recent page fixture', `recentpage.${userId}@example.invalid`],
    );

    // The old email is the only one that says "email"; the newest says nothing of the kind.
    await seedCommunication(oldEmail, { kind: 'email', time: '2026-09-22T03:01:40Z' });
    await seedCommunication(newEmail, { kind: 'email', time: '2026-11-13T12:06:41Z' });
    await seedCommunication(text, { kind: 'sms', time: '2026-11-14T09:00:00Z' });
    await seedCommunication(agentTurn, {
      kind: 'chat',
      category: AGENT_TURN_MESSAGE_CATEGORY,
      time: '2026-11-16T21:00:00Z',
    });

    await seedIndex('communication', oldEmail, 'you are receiving this email because you signed in');
    await seedIndex('communication', newEmail, 'gfiber payment confirmation');
    await seedIndex('communication', text, 'running late');
    await seedIndex('communication', agentTurn, 'the most recent email is from grubhub');
    // No record behind the index row, so no time at all: never "newest".
    await seedIndex('person', person, 'Kyle');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  const ids = (items: { id: string }[]) => items.map((item) => item.id);

  it('lists the newest emails first with no word, agents and texts left out', async () => {
    const page = await service.recentPage(context, {
      includeTypes: ['communication'],
      communicationTypes: ['email'],
      showAgentTurnsFrom: [],
    });

    expect(ids(page.items)).toEqual([newEmail, oldEmail]);
    expect(page.totalMatches).toBe(2);
    expect(page.modeTaken).toBe('recent');
  });

  it('leaves out entries with no time of their own, and keeps every dated kind when none is named', async () => {
    const page = await service.recentPage(context, { showAgentTurnsFrom: [] });

    expect(ids(page.items)).toEqual([text, newEmail, oldEmail]);
  });

  it('applies since / until to each entry’s own time, and counts the window', async () => {
    const page = await service.recentPage(context, {
      includeTypes: ['communication'],
      showAgentTurnsFrom: [],
      since: new Date('2026-11-01T00:00:00Z'),
      until: new Date('2026-11-13T23:59:59Z'),
      maxResults: 1,
    });

    expect(ids(page.items)).toEqual([newEmail]);
    expect(page.totalMatches).toBe(1);
    expect(page.truncated).toBe(false);
  });

  it('reports a cut page as truncated with the whole count', async () => {
    const page = await service.recentPage(context, { includeTypes: ['communication'], maxResults: 2 });

    // No agent rule: recall sees the agent's own turn, newest of all.
    expect(ids(page.items)).toEqual([agentTurn, text]);
    expect(page.totalMatches).toBe(4);
    expect(page.truncated).toBe(true);
  });

  it('filters a keyword page and a count by kind too', async () => {
    const page = await service.searchPage(context, {
      query: 'email',
      mode: 'keyword',
      communicationTypes: ['email'],
      showAgentTurnsFrom: [],
    });
    const count = await service.count(context, {
      communicationTypes: ['sms'],
      includeTypes: ['communication'],
    });

    expect(ids(page.items)).toEqual([oldEmail]);
    expect(count).toBe(1);
  });

  it('knows a query of only common words from one with a real term', async () => {
    await expect(service.hasSearchTerms('the')).resolves.toBe(false);
    await expect(service.hasSearchTerms('your I you')).resolves.toBe(false);
    await expect(service.hasSearchTerms('gfiber')).resolves.toBe(true);
    await expect(service.hasSearchTerms('   ')).resolves.toBe(false);
  });
});
