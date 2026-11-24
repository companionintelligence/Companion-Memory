import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity,
} from '@ci/domains/graph';
import { PushStage } from '@ci/domains/import';
import { BaseEntity, PersonEntity, PersonService } from '@ci/domains/memory';
import { UserEntity, UserService } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';

import { OnboardingService } from './OnboardingService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONBOARDING AND AN IMPORT, MAKING THE OWNER AT ONCE, END ON ONE PERSON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The import push provisions the owner's self Person when the account has none
 * (PushStage → GraphIngestService.ensureSelfEntityForOwner), and onboarding's
 * createPersonForUser makes one too. Both read `ci.users.entity_id` as NULL and
 * both create a Person, so each guarded its pointer write — and the side that
 * lost still left its own `is_self` Person behind: when the import lost, it
 * claimed the owner's address for its orphan as well.
 *
 * They now create the Person under one linked key, so whichever inserts first
 * makes the row and the other is handed it. This runs both against real rows,
 * concurrently, over separate connections, for accounts with no pointer, and
 * asserts what a race must leave: one live `is_self` Person, the pointer on it,
 * and the owner's address claimed for it.
 *
 * Racing by hand only lands on the orderings the scheduler happens to pick, so
 * the orderings that matter are also forced, one at a time, by holding one side
 * at a chosen statement while the other runs: the import landing on onboarding's
 * row between its create and its pointer write, onboarding finishing inside the
 * import's, and the pointer moving to a Person off the key under either. And an
 * account onboarded before the key existed — an `is_self` Person with no linked
 * key — must have the import adopt that Person, not mint a second.
 *
 * Opt-in like its neighbours: set `ONBOARDING_TEST_DATABASE_URL` (or
 * `DATABASE_URL`) to a migrated database of your own. Rows are committed, and
 * everything this suite makes is deleted in `afterAll`.
 */

const URL_ENV = { urlEnvVar: 'ONBOARDING_TEST_DATABASE_URL' };
const availability = databaseAvailability(URL_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[onboarding/OnboardingService.selfRace.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(180_000);

const ITERATIONS = 8;

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describeWithDb(`onboarding racing the import's self provisioning (${availability.target})`, () => {
  let dataSource: DataSource;
  let graph: GraphIngestService;
  let onboarding: OnboardingService;
  let userService: UserService;
  let personService: PersonService;
  let importStage: PushStage;
  const events = { send: jest.fn() };
  const users: string[] = [];

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(URL_ENV),
      entities: [
        BaseEntity,
        PersonEntity,
        NodeEntity,
        RelationshipEntity,
        EntityIdentifierEntity,
        UserEntity,
      ],
      synchronize: false,
      logging: false,
      extra: { max: 8 },
    });
    await dataSource.initialize();

    const identifiers = new EntityIdentifierService(
      dataSource.getRepository(EntityIdentifierEntity),
      logger(),
    );

    graph = new GraphIngestService(
      dataSource.getRepository(NodeEntity),
      dataSource.getRepository(RelationshipEntity),
      identifiers,
      logger(),
      { record: jest.fn(), recordMany: jest.fn() } as never,
    );

    // Only what createPersonForUser touches is real; the rest of onboarding
    // (threads, concepts, answers, …) is never reached from it.
    const unused = {} as never;
    userService = new UserService(dataSource.getRepository(UserEntity), events as never);
    personService = new PersonService(dataSource.getRepository(PersonEntity), logger(), events as never);
    onboarding = new OnboardingService(
      userService,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      personService,
      unused,
      identifiers,
      unused,
      logger(),
    );

    // The import's way in, for real: the push reads the pointer and provisions
    // through `graph` when there is none. Nothing else of the stage is reached.
    importStage = new PushStage(
      dataSource,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      graph,
      unused,
      logger(),
    );
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }

    for (const userId of users) {
      await dataSource.query(`UPDATE ci.users SET entity_id = NULL WHERE id = $1`, [userId]);
      await dataSource.query(`DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1`, [userId]);
      await dataSource.query(`DELETE FROM ci.entities WHERE owner_user_id = $1`, [userId]);
      await dataSource.query(`DELETE FROM ci.users WHERE id = $1`, [userId]);
    }

    await dataSource.destroy();
  });

  /** A ci.users row with no self Person and no pointer: what a fresh signup has. */
  async function freshAccount(): Promise<string> {
    const userId = await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'SelfRace');
    users.push(userId);

    return userId;
  }

  async function settled(userId: string) {
    const selves = await dataSource.query<Array<{ entity_id: string }>>(
      `SELECT entity_id
         FROM ci.entities
        WHERE owner_user_id = $1
          AND entity_type = 'Person'
          AND merged_into_entity_id IS NULL
          AND (is_self IS TRUE OR properties ->> 'is_self' = 'true')`,
      [userId],
    );
    const [{ count: people }] = await dataSource.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM ci.entities WHERE owner_user_id = $1 AND entity_type = 'Person'`,
      [userId],
    );
    const [{ entity_id: pointer }] = await dataSource.query<Array<{ entity_id: string | null }>>(
      `SELECT entity_id FROM ci.users WHERE id = $1`,
      [userId],
    );
    const emailClaims = await dataSource.query<Array<{ entity_id: string }>>(
      `SELECT entity_id FROM ci.entity_identifiers WHERE owner_user_id = $1 AND kind = 'email'`,
      [userId],
    );

    return { selves: selves.map((row) => row.entity_id), people, pointer, emailClaims };
  }

  type Racer = 'import' | 'onboarding';

  /** Every racer at once, each on its own pooled connection; the ids each one ended on. */
  async function race(userId: string, racers: Racer[]): Promise<string[]> {
    const context = { userId } as UserServiceContext;

    return Promise.all(
      racers.map(async (racer) =>
        racer === 'import'
          ? (await graph.ensureSelfEntityForOwner(context))!.id
          : (await onboarding.createPersonForUser(context)).id,
      ),
    );
  }

  const lineups: Racer[][] = [
    ['import', 'onboarding'],
    ['onboarding', 'import'],
    ['import', 'import', 'onboarding'],
  ];

  /** What one race left, as the assertions below read it; every field true or 1 when it went right. */
  async function outcomeOf(userId: string, ended: string[]) {
    const state = await settled(userId);
    const [stored] = await dataSource.query<Array<{ first_name: string | null }>>(
      `SELECT properties ->> 'first_name' AS first_name FROM ci.entities WHERE entity_id = $1`,
      [state.pointer],
    );

    return {
      selves: state.selves.length,
      people: state.people,
      pointedAtTheSelf: state.pointer != null && state.pointer === state.selves[0],
      everyRacerEndedOnIt: ended.every((id) => id === state.pointer),
      // The owner's address is claimed for the Person the account points at.
      addressClaimedForIt: state.emailClaims.length === 1 && state.emailClaims[0].entity_id === state.pointer,
      // Onboarding's details are on it, whichever side inserted it.
      onboardingDetailsOnIt: stored?.first_name === 'SelfRace',
    };
  }

  for (const lineup of lineups) {
    it(`leaves one self Person, pointed at and claimed, when ${lineup.join(' + ')} run at once`, async () => {
      const outcomes = [];
      const accounts: string[] = [];

      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const userId = await freshAccount();
        const ended = await race(userId, lineup);

        accounts.push(userId);
        outcomes.push(await outcomeOf(userId, ended));
      }

      expect(outcomes).toEqual(
        Array.from({ length: ITERATIONS }, () => ({
          selves: 1,
          people: 1,
          pointedAtTheSelf: true,
          everyRacerEndedOnIt: true,
          addressClaimedForIt: true,
          onboardingDetailsOnIt: true,
        })),
      );

      // One key, whoever inserted it.
      for (const userId of accounts) {
        const [stored] = await dataSource.query<Array<{ linked_table: string; linked_id: string }>>(
          `SELECT e.linked_table, e.linked_id FROM ci.users u JOIN ci.entities e ON e.entity_id = u.entity_id WHERE u.id = $1`,
          [userId],
        );

        expect({ linkedTable: stored.linked_table, linkedId: stored.linked_id }).toEqual(
          GraphIngestService.selfEntityLink(userId),
        );
      }
    });
  }

  it('makes the self Person on the shared key when onboarding runs alone', async () => {
    const userId = await freshAccount();
    events.send.mockClear();

    const person = await onboarding.createPersonForUser({ userId } as UserServiceContext);
    const state = await settled(userId);

    expect(state.selves).toEqual([person.id]);
    expect(state.pointer).toBe(person.id);

    const [stored] = await dataSource.query<Array<{ description: string | null; linked_table: string }>>(
      `SELECT description, linked_table FROM ci.entities WHERE entity_id = $1`,
      [person.id],
    );
    expect(stored).toEqual({ description: 'This is you!', linked_table: 'import:self' });

    // A plain signup announces exactly what it always did: the Person, then the pointer.
    expect(events.send.mock.calls).toEqual([
      ['person.created', { personId: person.id }],
      ['user.updated', { userId }],
    ]);
  });

  /** The push's own lookup of the owner, which provisions one when the account has none. */
  function importResolvesTheOwner(userId: string): Promise<string | null> {
    return (
      importStage as unknown as { resolveSelfEntityId(context: unknown): Promise<string | null> }
    ).resolveSelfEntityId({ userId, runId: 'self-race' });
  }

  /**
   * An account as onboarding left it before it created the self Person under
   * the import's key: an `is_self` Person with no linked key. `pointed` says
   * whether onboarding got as far as pointing the account at it.
   */
  async function accountWithAnUnkeyedSelf(pointed: boolean): Promise<{ userId: string; selfId: string }> {
    const userId = await freshAccount();
    const { id: selfId } = await onboarding.createPersonForUser({ userId } as UserServiceContext);

    await dataSource.query(
      `UPDATE ci.entities SET linked_table = NULL, linked_id = NULL WHERE entity_id = $1`,
      [selfId],
    );
    if (!pointed) {
      await dataSource.query(`UPDATE ci.users SET entity_id = NULL WHERE id = $1`, [userId]);
      await dataSource.query(`DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1`, [userId]);
    }

    return { userId, selfId };
  }

  /** Whether `entity_id` still holds the owner's claim, on both places markSelfEntity writes it. */
  async function selfFlagsOf(entityId: string) {
    const [row] = await dataSource.query<Array<{ column: boolean | null; property: string | null }>>(
      `SELECT is_self AS column, properties ->> 'is_self' AS property FROM ci.entities WHERE entity_id = $1`,
      [entityId],
    );

    return row;
  }

  /** A Person of the owner's that is not on the shared key, as something else would have made it. */
  async function foreignSelf(userId: string): Promise<string> {
    const person = await personService.create({ userId } as UserServiceContext, {
      name: 'Pointed Elsewhere',
      properties: { is_self: true },
    });

    return person.id;
  }

  /** A promise and the function that settles it, for ordering two flows by hand. */
  function latch() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });

    return { open, opened };
  }

  const TYPED_NAME = 'Ada Typed-Name';
  const typed = { name: TYPED_NAME } as never;

  describe('an account whose self Person carries no key', () => {
    it('has the import adopt the is_self Person it already has when the pointer is NULL', async () => {
      const { userId, selfId } = await accountWithAnUnkeyedSelf(false);

      const ended = await importResolvesTheOwner(userId);
      const state = await settled(userId);

      expect({
        ended,
        selves: state.selves,
        people: state.people,
        pointer: state.pointer,
        claimed: state.emailClaims.map((row) => row.entity_id),
      }).toEqual({ ended: selfId, selves: [selfId], people: 1, pointer: selfId, claimed: [selfId] });
    });

    it('has the import leave an account pointed at it exactly as it is', async () => {
      const { userId, selfId } = await accountWithAnUnkeyedSelf(true);
      const rowOf = () =>
        dataSource.query(
          `SELECT name, linked_table, linked_id, is_self, properties, updated_at FROM ci.entities WHERE entity_id = $1`,
          [selfId],
        );
      const before = await rowOf();

      const ended = await importResolvesTheOwner(userId);
      const state = await settled(userId);

      expect(ended).toBe(selfId);
      expect(state.selves).toEqual([selfId]);
      expect(state.people).toBe(1);
      expect(state.pointer).toBe(selfId);
      expect(await rowOf()).toEqual(before);
    });
  });

  describe('interleavings forced step by step', () => {
    it("keeps the name the owner typed when the import's upsert lands between onboarding's create and pointer write", async () => {
      const userId = await freshAccount();
      const context = { userId } as UserServiceContext;
      const importLookedForASelf = latch();
      const onboardingCreated = latch();
      const importDone = latch();

      // The import has looked for a self Person and found none — onboarding has
      // not made one yet — and reads the account's name to make its own. It
      // goes on to upsert on the key only once onboarding has created there.
      const query = dataSource.manager.query.bind(dataSource.manager);
      let held = false;
      const lookup = jest.spyOn(dataSource.manager, 'query').mockImplementation(async (sql, params) => {
        const rows = await query(sql, params);
        if (!held && sql.includes('SELECT name, email FROM ci.users')) {
          held = true;
          importLookedForASelf.open();
          await onboardingCreated.opened;
        }

        return rows;
      });
      const setPointer = userService.setEntityIdIfUnchanged.bind(userService);
      const pointerWrite = jest
        .spyOn(userService, 'setEntityIdIfUnchanged')
        .mockImplementationOnce(async (...args) => {
          onboardingCreated.open();
          await importDone.opened;

          return setPointer(...args);
        });

      try {
        const imported = graph.ensureSelfEntityForOwner(context).finally(() => importDone.open());
        await importLookedForASelf.opened;
        const [importEnded, onboarded] = await Promise.all([
          imported,
          onboarding.createPersonForUser(context, typed),
        ]);

        const state = await settled(userId);
        const [stored] = await dataSource.query<Array<{ name: string }>>(
          `SELECT name FROM ci.entities WHERE entity_id = $1`,
          [state.pointer],
        );

        expect(held).toBe(true);
        expect({
          selves: state.selves.length,
          people: state.people,
          bothOnIt: importEnded?.id === state.pointer && onboarded.id === state.pointer,
          name: stored?.name,
        }).toEqual({ selves: 1, people: 1, bothOnIt: true, name: TYPED_NAME });
      } finally {
        lookup.mockRestore();
        pointerWrite.mockRestore();
      }
    });

    it("ends on one self Person when onboarding finishes between the import's upsert and its pointer write", async () => {
      const userId = await freshAccount();
      const context = { userId } as UserServiceContext;

      const query = dataSource.manager.query.bind(dataSource.manager);
      // Set inside the hook, which TypeScript cannot see run.
      let onboarded = null as { id: string } | null;
      const pointerWrite = jest.spyOn(dataSource.manager, 'query').mockImplementation(async (sql, params) => {
        if (onboarded == null && sql.startsWith('UPDATE ci.users SET entity_id = $2')) {
          onboarded = await onboarding.createPersonForUser(context, typed);
        }

        return query(sql, params);
      });

      try {
        const importEnded = await graph.ensureSelfEntityForOwner(context);
        const state = await settled(userId);
        const [stored] = await dataSource.query<Array<{ name: string; description: string | null }>>(
          `SELECT name, description FROM ci.entities WHERE entity_id = $1`,
          [state.pointer],
        );

        expect({
          selves: state.selves.length,
          people: state.people,
          bothOnIt: importEnded?.id === state.pointer && onboarded?.id === state.pointer,
          claimed: state.emailClaims.map((row) => row.entity_id),
          stored,
        }).toEqual({
          selves: 1,
          people: 1,
          bothOnIt: true,
          claimed: [state.pointer],
          // Onboarding's details, on the Person the import made.
          stored: { name: TYPED_NAME, description: 'This is you!' },
        });
      } finally {
        pointerWrite.mockRestore();
      }
    });

    it('leaves one is_self Person when the pointer moves to a foreign Person under onboarding', async () => {
      const userId = await freshAccount();
      const context = { userId } as UserServiceContext;

      let foreign = null as string | null;
      let minted = null as string | null;
      const setPointer = userService.setEntityIdIfUnchanged.bind(userService);
      const pointerWrite = jest
        .spyOn(userService, 'setEntityIdIfUnchanged')
        .mockImplementationOnce(async (ctx, id, entityId, expected) => {
          minted = entityId;
          foreign = await foreignSelf(userId);
          await dataSource.query(`UPDATE ci.users SET entity_id = $2 WHERE id = $1 AND entity_id IS NULL`, [
            userId,
            foreign,
          ]);

          return setPointer(ctx, id, entityId, expected);
        });

      try {
        const onboarded = await onboarding.createPersonForUser(context, typed);
        const state = await settled(userId);

        expect(onboarded.id).toBe(foreign);
        expect(state.selves).toEqual([foreign]);
        expect(state.pointer).toBe(foreign);
        // The row onboarding made is still there, no longer claiming to be the owner.
        expect(state.people).toBe(2);
        expect(await selfFlagsOf(minted!)).toEqual({ column: false, property: 'false' });
      } finally {
        pointerWrite.mockRestore();
      }
    });

    it('leaves one is_self Person when the pointer moves to a foreign Person under the import', async () => {
      const userId = await freshAccount();
      const context = { userId } as UserServiceContext;

      const query = dataSource.manager.query.bind(dataSource.manager);
      let foreign = null as string | null;
      const pointerWrite = jest.spyOn(dataSource.manager, 'query').mockImplementation(async (sql, params) => {
        if (foreign == null && sql.startsWith('UPDATE ci.users SET entity_id = $2')) {
          foreign = await foreignSelf(userId);
          await query(`UPDATE ci.users SET entity_id = $2 WHERE id = $1 AND entity_id IS NULL`, [
            userId,
            foreign,
          ]);
        }

        return query(sql, params);
      });

      try {
        const importEnded = await graph.ensureSelfEntityForOwner(context);
        const state = await settled(userId);
        const [minted] = await dataSource.query<Array<{ entity_id: string }>>(
          `SELECT entity_id FROM ci.entities WHERE owner_user_id = $1 AND linked_table = 'import:self'`,
          [userId],
        );

        expect(importEnded?.id).toBe(foreign);
        expect(state.selves).toEqual([foreign]);
        expect(state.pointer).toBe(foreign);
        expect(state.emailClaims.map((row) => row.entity_id)).toEqual([foreign]);
        expect(state.people).toBe(2);
        expect(await selfFlagsOf(minted.entity_id)).toEqual({ column: false, property: 'false' });
      } finally {
        pointerWrite.mockRestore();
      }
    });
  });
});
