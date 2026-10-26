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

    const events = { send: jest.fn() } as never;
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
    onboarding = new OnboardingService(
      new UserService(dataSource.getRepository(UserEntity), events),
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      new PersonService(dataSource.getRepository(PersonEntity), logger(), events),
      unused,
      identifiers,
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

    const person = await onboarding.createPersonForUser({ userId } as UserServiceContext);
    const state = await settled(userId);

    expect(state.selves).toEqual([person.id]);
    expect(state.pointer).toBe(person.id);

    const [stored] = await dataSource.query<Array<{ description: string | null; linked_table: string }>>(
      `SELECT description, linked_table FROM ci.entities WHERE entity_id = $1`,
      [person.id],
    );
    expect(stored).toEqual({ description: 'This is you!', linked_table: 'import:self' });
  });
});
