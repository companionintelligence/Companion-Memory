import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import {
  BaseEntity,
  CommunicationBaseEntity,
  CommunicationEntity,
  ContentBaseEntity,
  ContentEntity,
  EventBaseEntity,
  EventEntity,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { InboxScanService } from '../InboxScanService';
import { TodoScanService } from '../TodoScanService';

/**
 * THE TODAY INBOX SCAN READS MAIL, NOT AGENT CONVERSATIONS.
 *
 * `POST /memory/turn` stores an agent's reply as an inbound `chat` with category
 * 'agent-turn', which is every column the scan used to select on. So the scan
 * read OpenClaw's and Hermes's answers as messages someone sent the owner and
 * could propose tasks from them. This runs the scan's two reads against rows
 * Postgres holds, in one transaction that is rolled back.
 *
 * Opt-in like the sibling integration specs: set PLANNING_TEST_DATABASE_URL to a
 * migrated database of your own, or run `make test-db`.
 */

const DATABASE_ENV = { urlEnvVar: 'PLANNING_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[planning/InboxScanService.agentTurns.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as LoggerService;

/** The to-do scan's private read: the memory hits it would ask the model about. */
interface TodoReads {
  memoryHits(context: { userId: string }): Promise<Array<{ id: string; text: string }> | null>;
}

/** The scan's two reads, which are private: what it would classify, and whether it runs at all. */
interface InboxReads {
  loadInboxPage(userId: string, cursor: null): Promise<CommunicationEntity[]>;
  scanAnchor(userId: string): Promise<Date | null>;
}

describeWithDb(`InboxScanService leaves agent conversations out (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let scan: InboxReads;

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  async function seedMessage(
    userId: string,
    row: {
      type: string;
      category: string | null;
      time: string;
      content: string;
      direction?: 'inbound' | 'outbound';
    },
  ): Promise<string> {
    const id = randomUUID();

    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Communication', $2, $3)`,
      [id, userId, row.content],
    );
    await q(
      `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, row.time, userId, row.type, row.direction ?? 'inbound', row.content, row.category],
    );

    return id;
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [
        BaseEntity,
        CommunicationEntity,
        CommunicationBaseEntity,
        ContentEntity,
        ContentBaseEntity,
        EventEntity,
        EventBaseEntity,
        UserEntity,
      ],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // Only the repository and the logger are reached by the two reads.
    const unused = undefined as never;

    scan = new InboxScanService(
      runner.manager.getRepository(CommunicationEntity),
      unused,
      unused,
      unused,
      unused,
      unused,
      logger,
    ) as unknown as InboxReads;
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('reads mail and chats, and skips the agent replies stored beside them', async () => {
    const userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'InboxScanAgentTurns');
    const mail = await seedMessage(userId, {
      type: 'email',
      category: null,
      time: '2026-10-20T09:00:00Z',
      content: 'Can you send the signed lease by Friday?',
    });
    const chat = await seedMessage(userId, {
      type: 'chat',
      category: null,
      time: '2026-10-21T09:00:00Z',
      content: 'Can you pick the kids up at five?',
    });
    await seedMessage(userId, {
      type: 'chat',
      category: 'agent-turn',
      time: '2026-10-22T09:00:00Z',
      content: 'Got it, I will remind you to renew the passport next week.',
    });

    const page = await scan.loadInboxPage(userId, null);

    expect(page.map((row) => row.id)).toEqual([chat, mail]);
    // The anchor is the newest message the scan could read, not the newer agent reply.
    expect((await scan.scanAnchor(userId))?.toISOString()).toBe('2026-10-21T09:00:00.000Z');
  });

  it('does not run at all for an account whose only inbound messages are agent replies', async () => {
    const userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'InboxScanAgentOnly');
    await seedMessage(userId, {
      type: 'chat',
      category: 'agent-turn',
      time: '2026-10-22T09:00:00Z',
      content: 'Sure, add "call the plumber" to your list.',
    });

    expect(await scan.loadInboxPage(userId, null)).toEqual([]);
    expect(await scan.scanAnchor(userId)).toBeNull();
  });
  it("keeps the agent's replies out of the to-do scan, and what the owner told the agent in", async () => {
    const userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'TodoScanAgentTurns');
    const owner = await seedMessage(userId, {
      type: 'chat',
      category: 'agent-turn',
      direction: 'outbound',
      time: '2026-10-22T08:59:00Z',
      content: 'Remind me to renew the passport next week.',
    });
    const reply = await seedMessage(userId, {
      type: 'chat',
      category: 'agent-turn',
      time: '2026-10-22T09:00:00Z',
      content: 'Got it, I will remind you to renew the passport next week.',
    });
    // The search is the ranking half; the row read after it is what decides.
    const searchService = { search: jest.fn().mockResolvedValue([{ id: owner }, { id: reply }]) };
    const todo = new TodoScanService(
      undefined as never,
      searchService as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { query: (sql: string, params?: unknown[]) => q(sql, params) } as never,
      undefined as never,
      logger,
    ) as unknown as TodoReads;

    const hits = await todo.memoryHits({ userId });

    expect(hits?.map((hit) => hit.id)).toEqual([owner]);
  });
});
