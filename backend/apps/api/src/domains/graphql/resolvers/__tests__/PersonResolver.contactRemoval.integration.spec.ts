import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { EntityIdentifierEntity, EntityIdentifierService } from '@ci/domains/graph';
import { BaseEntity, PersonEntity, PersonService } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PersonIdentifiersLoader } from '../../loaders/PersonIdentifiersLoader';
import { GlobalUID } from '../../types/GlobalUID';
import type { PersonIdentifierType } from '../../types/PersonIdentifierType';
import { PersonResolver } from '../PersonResolver';

/**
 * Removing a contact in the person edit form, against a real Postgres.
 *
 * A contact the form shows can live in two places: the `ci.entity_identifiers`
 * index, and the person's own `properties` (`createPerson` writes every typed
 * email and phone into `emails` / `phones`, the import push copies a contact's
 * handle into `email` / `phone`, and migration 20260930020117 parks extension
 * numbers in `phones`). `identifiers` shows the union, the form seeds from it,
 * and a save used to reconcile the index alone — so a removed row came straight
 * back from the property copy, on the Details card and in the next edit.
 *
 * The flow here is the form's own: read `identifiers`, keep every row but the
 * ones the user deleted, send them as `contacts`, read `identifiers` back on a
 * fresh request. The services are the real ones, so what is proved is what the
 * rows say afterwards, not what a mock was told to return.
 *
 * Numbers are invented 555-01XX values; addresses use the reserved `.test` TLD.
 *
 * Opt-in like the sibling DB-backed suites: set `MEMORY_TEST_DATABASE_URL` (or
 * `DATABASE_URL`) to a database with migrations applied.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graphql/PersonResolver.contactRemoval.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** What `personDraftFrom` + `personDraftToInput` send back for the rows the form shows. */
function formContacts(rows: readonly PersonIdentifierType[]) {
  const contacts = rows
    .filter((row) => row.kind === 'email' || row.kind === 'phone')
    .map((row) => ({
      kind: row.kind,
      // The form prefers the raw form: it is what the user typed.
      value: row.rawValue?.trim() || row.value,
      label: row.label ?? '',
    }));

  return contacts.map((contact, index) => ({
    ...contact,
    isPrimary: contacts.findIndex((other) => other.kind === contact.kind) === index,
  }));
}

describeWithDb(`PersonResolver — removing a contact in the edit form (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let resolver: PersonResolver;
  let owner: string;
  let stranger: string;

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  /**
   * A fresh request context per call, as each GraphQL request has: the
   * identifiers loader caches per context, and reusing one would read back the
   * cache instead of the rows.
   */
  const as = (userId: string) => ({ userId }) as RequestContext;

  beforeAll(async () => {
    const connection = resolveConnection(ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
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
      entities: [BaseEntity, PersonEntity, EntityIdentifierEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real ci.entities / ci.entity_identifiers rows,
    // which a migration suite may be altering inside its own transaction. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PersonResolver.contactRemoval');

    const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
    owner = await createSyntheticTestUser(query, 'PersonResolver-contactRemoval');
    stranger = await createSyntheticTestUser(query, 'PersonResolver-contactRemoval-stranger');

    const personService = new PersonService(dataSource.getRepository(PersonEntity), noopLogger, {
      send: async () => [],
    } as unknown as EventService);
    const entityIdentifierService = new EntityIdentifierService(
      dataSource.getRepository(EntityIdentifierEntity),
      noopLogger,
    );
    // Nothing on these paths reaches merges, duplicates, tags or the graph.
    const unused = {} as never;

    resolver = new PersonResolver(
      personService,
      unused,
      unused,
      unused,
      unused,
      entityIdentifierService,
      new PersonIdentifiersLoader(entityIdentifierService, noopLogger),
      unused,
      unused,
      unused,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const owners = [owner, stranger].filter(Boolean);
      await dataSource.query('DELETE FROM ci.entity_identifiers WHERE owner_user_id = ANY($1::uuid[])', [
        owners,
      ]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [owners]);
      // Before destroy(): the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** A Person row as an import or a migration leaves it — written straight to the table. */
  async function seedPerson(name: string, properties: Record<string, unknown>, linkedTable?: string) {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Person', $2, $3::jsonb, $4, $5, $6)`,
      [id, name, JSON.stringify(properties), owner, linkedTable ?? null, linkedTable ? uuidv7() : null],
    );

    return id;
  }

  async function seedIdentifier(
    entityId: string,
    kind: 'email' | 'phone',
    valueNormalized: string,
    source: string,
  ) {
    await dataSource.query(
      `INSERT INTO ci.entity_identifiers (owner_user_id, entity_id, kind, value_normalized, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [owner, entityId, kind, valueNormalized, source],
    );
  }

  /** What the Details card — and the next edit — reads, on a fresh request. */
  async function shown(personId: string, userId = owner): Promise<PersonIdentifierType[]> {
    const context = as(userId);
    const person = await resolver.person(context, GlobalUID.encode('person', personId));
    if (person == null) {
      throw new Error(`person ${personId} is not readable`);
    }

    return resolver.identifiers(context, person);
  }

  async function storedProperties(personId: string): Promise<Record<string, unknown>> {
    const [row] = (await dataSource.query('SELECT properties FROM ci.entities WHERE entity_id = $1', [
      personId,
    ])) as Array<{ properties: Record<string, unknown> }>;

    return row.properties;
  }

  /** The `kind:value` identifiers the index gives this person. */
  async function indexed(personId: string): Promise<string[]> {
    const rows = (await dataSource.query(
      'SELECT kind, value_normalized FROM ci.entity_identifiers WHERE entity_id = $1',
      [personId],
    )) as Array<{ kind: string; value_normalized: string }>;

    return rows.map((row) => `${row.kind}:${row.value_normalized}`);
  }

  /**
   * Save the form with every shown row except those `drop` matches. `shownInResponse`
   * resolves `identifiers` on the mutation's own payload, in the mutation's
   * request — what the editor's Apollo cache is refreshed from.
   */
  async function saveWithout(
    personId: string,
    drop: (row: PersonIdentifierType) => boolean,
    extra: Array<{ kind: string; value: string }> = [],
  ) {
    const rows = await shown(personId);
    const context = as(owner);

    const payload = await resolver.updatePerson(context, {
      id: GlobalUID.encode('person', personId),
      contacts: [...formContacts(rows.filter((row) => !drop(row))), ...extra],
    });

    return {
      ...payload,
      shownInResponse: () =>
        payload.person ? resolver.identifiers(context, payload.person) : Promise.resolve([]),
    };
  }

  const byRaw = (raw: string) => (row: PersonIdentifierType) => (row.rawValue ?? row.value) === raw;

  it('keeps a contact removed in the form removed — on the Details card, in the next edit, and on the row', async () => {
    const created = await resolver.createPerson(as(owner), {
      name: 'Dana Example',
      contacts: [
        { kind: 'phone', value: '(555) 010-0142', label: 'mobile' },
        { kind: 'phone', value: '(555) 010-0143', label: 'work' },
        { kind: 'email', value: 'dana@example.test' },
        { kind: 'email', value: 'dana.work@example.test' },
      ],
    });
    const personId = GlobalUID.parse('person', created.person!.id);

    expect((await shown(personId)).map((row) => row.rawValue ?? row.value).sort()).toEqual([
      '(555) 010-0142',
      '(555) 010-0143',
      'dana.work@example.test',
      'dana@example.test',
    ]);

    const saved = await saveWithout(
      personId,
      (row) => byRaw('(555) 010-0143')(row) || byRaw('dana.work@example.test')(row),
    );
    expect(saved.success).toBe(true);
    // What the editor re-renders from before anything is re-fetched.
    expect((await saved.shownInResponse()).map((row) => `${row.kind}:${row.value}`).sort()).toEqual([
      'email:dana@example.test',
      'phone:5550100142',
    ]);

    const afterSave = await shown(personId);
    expect(afterSave.map((row) => `${row.kind}:${row.value}`).sort()).toEqual([
      'email:dana@example.test',
      'phone:5550100142',
    ]);

    // The next edit seeds from what is shown and sends it back unchanged.
    await saveWithout(personId, () => false);
    expect((await shown(personId)).map((row) => `${row.kind}:${row.value}`).sort()).toEqual([
      'email:dana@example.test',
      'phone:5550100142',
    ]);

    // The row's own copies agree, so nothing that reads them (the identifier
    // backfill re-indexes from them) can bring the number back either.
    const properties = await storedProperties(personId);
    expect(properties.phones).toEqual(['(555) 010-0142']);
    expect(properties.emails).toEqual(['dana@example.test']);
  });

  it("removes an imported contact's handle copies, and never edits the card's own typed record", async () => {
    const card = {
      Names: ['Lee Example'],
      Phones: ['(555) 010-0144', '+1 555 010 0145'],
      Emails: ['lee@example.test'],
    };
    const personId = await seedPerson(
      'Lee Example',
      { ...card, names: ['Lee Example'], phone: '5550100144', phones: ['5550100144'] },
      'import:vcard',
    );
    await seedIdentifier(personId, 'phone', '5550100144', 'import:vcard');

    expect((await shown(personId)).map((row) => `${row.kind}:${row.value}`)).toEqual(['phone:5550100144']);

    await saveWithout(personId, byRaw('5550100144'));

    expect(await shown(personId)).toEqual([]);

    const properties = await storedProperties(personId);
    expect(properties).toMatchObject({ phone: null, phones: [] });
    // Byte-for-byte what the import wrote: re-imports rewrite it, and
    // natural-key repairs read it back as evidence.
    expect(properties.Phones).toEqual(card.Phones);
    expect(properties.Emails).toEqual(card.Emails);
    expect(properties.Names).toEqual(card.Names);
  });

  it('keeps an extension number parked in properties.phones while the form sends it back, and removes it when the form stops', async () => {
    // Migration 20260930020117 (B1) moved a typed number with an extension out
    // of the identifier index and into `phones`, because it can no longer key
    // anybody. The property copy is the only place it lives.
    const typed = '(555) 010-0146;229';
    const personId = await seedPerson('Office Contact', { phones: [typed] });

    expect((await shown(personId)).map((row) => row.rawValue)).toEqual([typed]);

    await saveWithout(personId, () => false);
    expect((await storedProperties(personId)).phones).toEqual([typed]);
    expect((await shown(personId)).map((row) => row.rawValue)).toEqual([typed]);

    await saveWithout(personId, byRaw(typed));
    expect(await shown(personId)).toEqual([]);
    expect((await storedProperties(personId)).phones).toEqual([]);
  });

  it('never loses a stored number the form sends back re-spaced or re-cased', async () => {
    // The same number with the same extension. It matches by join key where it
    // has one; once an extension has none, a save may refuse the re-spelled
    // value before writing anything, or accept it — but it must not drop the
    // stored copy while the re-spelled one lands nowhere.
    const typed = '(555) 010-0146 ext 229';
    const personId = await seedPerson('Respelled Contact', { phones: [typed] });

    await resolver
      .updatePerson(as(owner), {
        id: GlobalUID.encode('person', personId),
        contacts: [{ kind: 'phone', value: '(555)  010-0146 EXT 229' }],
      })
      .catch((error: unknown) => expect(error).toBeInstanceOf(BadRequestException));

    expect((await storedProperties(personId)).phones).toEqual([typed]);
    expect(await shown(personId)).toHaveLength(1);
  });

  it('leaves alone a stored value the form never showed', async () => {
    const personId = await seedPerson('Junk Example', { phones: ['n/a', '(555) 010-0147'] });

    expect((await shown(personId)).map((row) => row.rawValue)).toEqual(['(555) 010-0147']);

    await saveWithout(personId, () => true);

    expect(await shown(personId)).toEqual([]);
    // Nobody saw it, so its absence from the form says nothing about it.
    expect((await storedProperties(personId)).phones).toEqual(['n/a']);
  });

  it('keeps an untouched contact that only the row states, however narrowly the index is reconciled', async () => {
    // The form sends back every row it showed. A list narrowed for the index —
    // one that leaves out an untouched property-only row so a save cannot
    // promote it to user-verified — must not be where "removed" is read from,
    // or every such row reads as removed and is pruned.
    const home = { value: 'kept@example.test', type: 'home' };
    const personId = await seedPerson('Property Only', { emails: [home, 'dropped@example.test'] });

    await saveWithout(personId, byRaw('dropped@example.test'));

    expect((await storedProperties(personId)).emails).toEqual([home]);
    expect((await shown(personId)).map((row) => `${row.kind}:${row.value}:${row.label}`)).toEqual([
      'email:kept@example.test:home',
    ]);
  });

  it('never leaves the index and the row disagreeing when a save is refused for a conflict', async () => {
    const holder = await seedPerson('Shared Mailbox Holder', {});
    await seedIdentifier(holder, 'email', 'shared@example.test', 'user');
    const personId = await seedPerson('Conflict Example', { emails: ['only.mine@example.test'] });
    await seedIdentifier(personId, 'email', 'only.mine@example.test', 'import:contacts');

    // Drop an address held both ways, and add one somebody else already holds.
    await expect(
      saveWithout(personId, byRaw('only.mine@example.test'), [
        { kind: 'email', value: 'shared@example.test' },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);

    // Whether the refusal lands before anything is written or after the index
    // half of the edit (both exist: a pre-write check, and the post-write race
    // backstop), the row's copy must end up where the index row did. An index
    // row gone with the copy left behind is the address coming back.
    const inIndex = (await indexed(personId)).includes('email:only.mine@example.test');
    const onRow = ((await storedProperties(personId)).emails as unknown[]).includes('only.mine@example.test');
    expect(onRow).toBe(inIndex);
    expect((await shown(personId)).map((row) => row.value)).toEqual(
      inIndex ? ['only.mine@example.test'] : [],
    );
    expect((await shown(holder)).map((row) => row.value)).toEqual(['shared@example.test']);
  });

  it('removes the property copy when one contact is removed with removePersonIdentifier', async () => {
    const personId = await seedPerson('Single Removal', { phones: ['(555) 010-0148', '(555) 010-0149'] });
    await seedIdentifier(personId, 'phone', '5550100148', 'import:contacts');

    await resolver.removePersonIdentifier(as(owner), {
      personId: GlobalUID.encode('person', personId),
      kind: 'phone',
      value: '555.010.0148',
    });

    expect((await shown(personId)).map((row) => row.value)).toEqual(['5550100149']);
    expect((await storedProperties(personId)).phones).toEqual(['(555) 010-0149']);
  });

  it('does not touch a person the caller does not own', async () => {
    const personId = await seedPerson('Not Yours', {
      phones: ['(555) 010-0150'],
      emails: ['not.yours@example.test'],
    });

    const result = await resolver.updatePerson(as(stranger), {
      id: GlobalUID.encode('person', personId),
      contacts: [],
    });

    expect(result.success).toBe(false);
    expect(await storedProperties(personId)).toEqual({
      phones: ['(555) 010-0150'],
      emails: ['not.yours@example.test'],
    });
  });
});
