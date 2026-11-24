import { DataSource, type QueryRunner } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity as IngestRelationshipEntity,
} from '@ci/domains/graph';
import {
  BaseEntity,
  GraphDeltaWriter,
  GraphNodeEntity,
  GraphQueryService,
  GraphUtilityService,
  PersonEntity,
  PersonService,
  RelationshipEntity,
  SELF_ENTITY_PROVISIONER,
  UserContextService,
} from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BrowserActivityInsightPreferenceService } from '../BrowserActivityInsightPreferenceService';
import { ChatModelPreferenceService } from '../ChatModelPreferenceService';
import { ImageDescriptionPreferenceService } from '../ImageDescriptionPreferenceService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SETTINGS THAT LIVE ON THE SELF PERSON, FOR AN ACCOUNT THAT HAS NONE — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ci.users.entity_id` stays NULL until something self-anchored is ingested, and an
 * account whose data came from an import never gets one. Five Settings writes store
 * their value on that person — the chat model, Tools and Thinking, "Describe
 * images", "Categorize browsing", and the Autonomy trust mode — and every one of
 * them answered 500 `Self entity not found` for such an account. The model picker
 * reverted its optimistic selection each time (six taps, six 500s on an iOS QA run);
 * the Autonomy dial could not be saved at all.
 *
 * Real here: the six services, `PersonService`'s owner-scoped jsonb leaf write,
 * `UserContextService`'s self lookup, and — as the provisioner they find through
 * `SELF_ENTITY_PROVISIONER` — the real `GraphIngestService`. Stood in: the queue
 * and the vision model. Every test runs inside one transaction on one connection
 * and rolls back, so nothing is committed.
 *
 * Lives in the llm domain because most of what it exercises is llm's (the chat-model,
 * image-description and browser-activity preference services), and the
 * `no-cross-domain-internals` rule (`yarn depcheck`) forbids reaching into another
 * domain's files. Those three are imported directly; the one service that is not
 * llm's, `PersonalizationService` (Autonomy), comes through its domain's public barrel.
 *
 * Opt-in like the other DB-backed suites: skips with the reason when nothing
 * listens at `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`, and `make test-db`
 * provides one.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[llm/SettingsWrites.noSelfEntity.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const VISION_MODEL = 'gemma4:e4b';

describeWithDb(`Settings writes for an account with no self entity (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;

  let ownerId: string;
  let strangerId: string;
  let owner: UserServiceContext;
  let stranger: UserServiceContext;

  let graph: GraphIngestService;
  let people: PersonService;
  let chatModel: ChatModelPreferenceService;
  let imageDescription: ImageDescriptionPreferenceService;
  let browserActivity: BrowserActivityInsightPreferenceService;
  let personalization: PersonalizationService;
  let backfills: unknown[];

  const query = (sql: string, params?: unknown[]) => runner.query(sql, params);

  /** The user's own entities, of any kind. */
  const entityCount = async (userId: string): Promise<number> => {
    const [row] = await query(`SELECT count(*)::int AS n FROM ci.entities WHERE owner_user_id = $1`, [
      userId,
    ]);

    return row.n as number;
  };

  const selfPointer = async (userId: string): Promise<string | null> => {
    const [row] = await query(`SELECT entity_id FROM ci.users WHERE id = $1`, [userId]);

    return (row?.entity_id as string | null) ?? null;
  };

  const entityRow = async (entityId: string) => {
    const [row] = await query(
      `SELECT entity_type, owner_user_id, is_self, properties FROM ci.entities WHERE entity_id = $1`,
      [entityId],
    );

    return row as {
      entity_type: string;
      owner_user_id: string;
      is_self: boolean | null;
      properties: Record<string, unknown>;
    };
  };

  const plannerOf = async (userId: string): Promise<Record<string, unknown>> => {
    const pointer = await selfPointer(userId);

    return pointer == null
      ? {}
      : (((await entityRow(pointer)).properties.planner ?? {}) as Record<string, unknown>);
  };

  /**
   * Every setting that lives on the self person: the write, what it leaves in the
   * `planner` bag, and how the service reads it back.
   */
  const SETTINGS = [
    {
      name: 'chat model',
      write: (ctx: UserServiceContext) => chatModel.setChatModel(ctx, 'qwen3.5:2b-mlx'),
      leaves: (planner: Record<string, unknown>) => planner.chat_model,
      expected: 'qwen3.5:2b-mlx',
      read: (userId: string) => chatModel.getChatModel(userId),
      defaultRead: null,
    },
    {
      name: 'Tools',
      write: (ctx: UserServiceContext) => chatModel.setToolsEnabled(ctx, false),
      leaves: (planner: Record<string, unknown>) => planner.tools_enabled,
      expected: false,
      read: (userId: string) => chatModel.getToolsEnabled(userId),
      defaultRead: true,
    },
    {
      name: 'Thinking',
      write: (ctx: UserServiceContext) => chatModel.setThinkingEnabled(ctx, false),
      leaves: (planner: Record<string, unknown>) => planner.thinking_enabled,
      expected: false,
      read: (userId: string) => chatModel.getThinkingEnabled(userId),
      defaultRead: true,
    },
    {
      name: 'Describe images',
      write: (ctx: UserServiceContext) => imageDescription.setEnabled(ctx, true),
      leaves: (planner: Record<string, unknown>) =>
        (planner.image_description_overrides as Record<string, unknown> | undefined)?.[VISION_MODEL],
      expected: true,
      read: (userId: string) => imageDescription.isEnabled(userId),
      // A user with no self entity reads as off, whatever the model.
      defaultRead: false,
    },
    {
      name: 'Categorize browsing',
      write: (ctx: UserServiceContext) => browserActivity.setEnabled(ctx, true),
      leaves: (planner: Record<string, unknown>) => planner.browser_activity_insight_enabled,
      expected: true,
      read: (userId: string) => browserActivity.isEnabled(userId),
      defaultRead: false,
    },
    {
      name: 'Autonomy (trust mode)',
      write: (ctx: UserServiceContext) => personalization.updateTrustMode(ctx, 'cautious'),
      leaves: (planner: Record<string, unknown>) => planner.trust_mode,
      expected: 'cautious',
      read: async (userId: string) => (await personalization.getProfile(userId)).trustMode,
      defaultRead: 'balanced',
    },
  ];

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [
        BaseEntity,
        UserEntity,
        PersonEntity,
        GraphNodeEntity,
        RelationshipEntity,
        NodeEntity,
        IngestRelationshipEntity,
        EntityIdentifierEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'llm/SettingsWrites.noSelfEntity');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ownerId = await createSyntheticTestUser(query, 'SettingsWrites-owner');
    strangerId = await createSyntheticTestUser(query, 'SettingsWrites-stranger');
    owner = { userId: ownerId };
    stranger = { userId: strangerId };

    const manager = runner.manager;

    graph = new GraphIngestService(
      manager.getRepository(NodeEntity),
      manager.getRepository(IngestRelationshipEntity),
      new EntityIdentifierService(manager.getRepository(EntityIdentifierEntity), logger as never),
      logger as never,
      // GraphDeltaWriter only ever calls `.query`, so this keeps its rows in the transaction too.
      new GraphDeltaWriter({ query } as never, logger as never),
    );
    people = new PersonService(
      manager.getRepository(PersonEntity),
      logger as never,
      {
        send: async () => [],
      } as never,
    );

    const userContext = new UserContextService(
      new GraphQueryService(
        {} as never,
        new GraphUtilityService(
          manager.getRepository(GraphNodeEntity),
          manager.getRepository(RelationshipEntity),
          logger as never,
        ),
      ),
      { query } as never,
      logger as never,
    );

    // What `SELF_ENTITY_PROVISIONER` is bound to in the app: the graph's own ingest service.
    const moduleRef = {
      get: (token: unknown) => {
        if (token !== SELF_ENTITY_PROVISIONER) {
          throw new Error(`unexpected token ${String(token)}`);
        }

        return graph;
      },
    } as never;

    backfills = [];
    chatModel = new ChatModelPreferenceService(people, userContext, moduleRef);
    imageDescription = new ImageDescriptionPreferenceService(
      people,
      userContext,
      {
        send: async (...args: unknown[]) => {
          backfills.push(args);
        },
      } as never,
      { resolveVisionModel: async () => ({ model: VISION_MODEL, supportsVision: true }) } as never,
      moduleRef,
    );
    browserActivity = new BrowserActivityInsightPreferenceService(people, userContext, moduleRef);
    personalization = new PersonalizationService(people, userContext, moduleRef);
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  // The premise: this is the account the iOS QA run had.
  it('starts from an account with no self entity and nothing in its graph', async () => {
    expect(await selfPointer(ownerId)).toBeNull();
    expect(await entityCount(ownerId)).toBe(0);
  });

  describe.each(SETTINGS)('$name', (setting) => {
    it('stores the setting on a self person it provisions for the caller, and reads it back', async () => {
      await setting.write(owner);

      const pointer = await selfPointer(ownerId);

      expect(pointer).not.toBeNull();
      expect(await entityCount(ownerId)).toBe(1);

      const row = await entityRow(pointer!);

      expect(row.entity_type).toBe('Person');
      expect(row.owner_user_id).toBe(ownerId);
      expect(row.is_self).toBe(true);
      expect(setting.leaves((row.properties.planner ?? {}) as Record<string, unknown>)).toBe(
        setting.expected,
      );
      expect(((row.properties.planner ?? {}) as Record<string, unknown>).source).toBe('settings');
      await expect(setting.read(ownerId)).resolves.toBe(setting.expected);
    });

    it('reuses that entity on the next write instead of minting another', async () => {
      await setting.write(owner);
      const first = await selfPointer(ownerId);

      await setting.write(owner);

      expect(await selfPointer(ownerId)).toBe(first);
      expect(await entityCount(ownerId)).toBe(1);
    });

    it('never provisions on a READ: the service keeps answering its default', async () => {
      await expect(setting.read(ownerId)).resolves.toBe(setting.defaultRead);

      expect(await selfPointer(ownerId)).toBeNull();
      expect(await entityCount(ownerId)).toBe(0);
    });

    it('provisions for the caller only: another account is neither created for nor touched', async () => {
      const strangerSelf = (await graph.ensureSelfEntityForOwner(stranger))!.id;
      await people.patchPropertyLeaves(stranger, strangerSelf, [
        { path: ['planner', 'marker'], value: 'stranger-was-here-first' },
      ]);
      const strangerBefore = await entityRow(strangerSelf);
      const strangerCountBefore = await entityCount(strangerId);

      await setting.write(owner);

      expect(await selfPointer(strangerId)).toBe(strangerSelf);
      expect(await entityCount(strangerId)).toBe(strangerCountBefore);
      expect(await entityRow(strangerSelf)).toEqual(strangerBefore);
      expect(await selfPointer(ownerId)).not.toBe(strangerSelf);
    });

    it('does not provision a second self person for an account that has one', async () => {
      const existing = (await graph.ensureSelfEntityForOwner(owner))!.id;
      await people.patchPropertyLeaves(owner, existing, [
        { path: ['planner', 'trust_mode'], value: 'hands_off' },
        { path: ['planner', 'source'], value: 'onboarding' },
      ]);
      const before = await entityCount(ownerId);

      await setting.write(owner);

      expect(await selfPointer(ownerId)).toBe(existing);
      expect(await entityCount(ownerId)).toBe(before);
      expect(setting.leaves(await plannerOf(ownerId))).toBe(setting.expected);
    });
  });

  it('writes one setting without disturbing another that is already on the entity', async () => {
    await personalization.updateTrustMode(owner, 'hands_off');
    await chatModel.setChatModel(owner, 'qwen3.5:2b-mlx');
    await browserActivity.setEnabled(owner, true);

    const planner = await plannerOf(ownerId);

    expect(planner.trust_mode).toBe('hands_off');
    expect(planner.chat_model).toBe('qwen3.5:2b-mlx');
    expect(planner.browser_activity_insight_enabled).toBe(true);
    expect(await entityCount(ownerId)).toBe(1);
  });

  it('turns "Describe images" on with a backfill, because a user with no self entity read as off', async () => {
    await expect(imageDescription.setEnabled(owner, true)).resolves.toBe(true);

    // A vision model is on by default once the entity exists, but until then the
    // setting read as off: this is a genuine off→on transition, and the images
    // already imported need describing.
    expect(backfills).toHaveLength(1);
  });

  it('keeps the leaf write scoped to its owner: a write aimed at somebody else’s self person changes nothing', async () => {
    const strangerSelf = (await graph.ensureSelfEntityForOwner(stranger))!.id;
    const before = await entityRow(strangerSelf);

    const result = await people.patchPropertyLeaves(owner, strangerSelf, [
      { path: ['planner', 'trust_mode'], value: 'hands_off' },
    ]);

    expect(result).toBeNull();
    expect(await entityRow(strangerSelf)).toEqual(before);
  });
});
