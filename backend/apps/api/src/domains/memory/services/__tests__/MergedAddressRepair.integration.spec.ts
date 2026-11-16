import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { MergedAddressRepairService } from '../MergedAddressRepairService';

/**
 * The repair of person merges that dropped the merged-in person's addresses,
 * against Postgres: the merge records, tombstones and Change History rows it
 * reads, and the bag it writes.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied; with nothing reachable this suite SKIPS legibly.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest MergedAddressRepair.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/MergedAddressRepair.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const WORK = {
  label: 'work',
  street_address: '1 Market St',
  street_address_2: null,
  city: 'Oakland',
  region: null,
  postal_code: null,
  country: null,
  is_primary: true,
};
const HOME = { ...WORK, label: 'home', street_address: null, city: 'Berkeley', is_primary: false };
const CABIN = { ...HOME, label: 'cabin', city: 'Bend' };
/** The flat keys the app writes beside the list, mirroring its primary. */
const WORK_FLAT = { address: '1 Market St, Oakland', street_address: '1 Market St', city: 'Oakland' };
const NEW_ROAD = { ...WORK, label: null, street_address: '3 New Rd', city: 'Eugene' };
const NEW_ROAD_FLAT = { address: '3 New Rd, Eugene', street_address: '3 New Rd', city: 'Eugene' };
const OAK_AVE = { ...WORK, label: null, street_address: '5 Oak Ave' };

describeWithDb(`MergedAddressRepairService, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let repairer: MergedAddressRepairService;
  const send = jest.fn(async () => []);

  const owner = uuidv7();
  const otherOwner = uuidv7();

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

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

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/MergedAddressRepair.integration');

    for (const id of [owner, otherOwner]) {
      await dataSource.query(`INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3)`, [
        id,
        'Merged address repair fixture',
        `merged-address-repair.${id}@example.invalid`,
      ]);
    }

    repairer = new MergedAddressRepairService(
      dataSource,
      noopLogger,
      { send } as never,
      new GraphDeltaWriter(dataSource, noopLogger),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      for (const id of [owner, otherOwner]) {
        await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [id]);
        await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [id]);
        await dataSource.query(
          'UPDATE ci.entities SET merged_into_entity_id = NULL WHERE owner_user_id = $1',
          [id],
        );
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [id]);
        await dataSource.query('DELETE FROM ci.users WHERE id = $1', [id]);
      }

      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const insertPerson = async (
    name: string,
    properties: Record<string, unknown>,
    mergedInto: string | null = null,
    ownerId = owner,
  ): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, merged_into_entity_id, is_active)
       VALUES ($1, 'Person', $2, $3::jsonb, $4, $5, $6)`,
      [id, name, JSON.stringify(properties), ownerId, mergedInto, mergedInto == null],
    );

    return id;
  };

  /** A merge record as `PersonMergeService` wrote it, a day ago. */
  const insertMerge = async (
    source: string,
    target: string,
    sourceProperties: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    ownerId = owner,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details, created_at)
       VALUES ($1, $2, $3, 'Person', $4::jsonb, now() - interval '1 day')`,
      [ownerId, source, target, JSON.stringify({ counts: {}, sourceProperties, ...extra })],
    );
  };

  /**
   * A merge record a day ago, with the Change History row the merge wrote on
   * its target in the same transaction (so at the same time): the bag it left.
   */
  const insertMergeWithHistory = async (
    source: string,
    target: string,
    sourceProperties: Record<string, unknown>,
    mergedProperties: Record<string, unknown>,
  ): Promise<void> => {
    await dataSource.query(
      `WITH merge AS (
         INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details, created_at)
         VALUES ($1, $2, $3, 'Person', $4::jsonb, now() - interval '1 day')
         RETURNING created_at
       )
       INSERT INTO ci.graph_deltas (entity_id, node_type, entity_type, change_type, changed_fields, change_source,
                                    owner_user_id, changed_by_user_id, changed_at)
       SELECT $3, 'entity', 'Person', 'updated', $5::jsonb, 'PersonMergeService.mergePeople', $1, $1, merge.created_at
         FROM merge`,
      [
        owner,
        source,
        target,
        JSON.stringify({ counts: {}, sourceProperties }),
        JSON.stringify({ properties: { new: mergedProperties } }),
      ],
    );
  };

  /** An edit through the app, as `PersonService` records it. */
  const insertEdit = async (personId: string, changedFields: Record<string, unknown>): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (entity_id, node_type, entity_type, change_type, changed_fields, change_source, owner_user_id, changed_by_user_id)
       VALUES ($1, 'entity', 'Person', 'updated', $2::jsonb, 'PersonService.patch', $3, $3)`,
      [personId, JSON.stringify(changedFields), owner],
    );
  };

  const propertiesOf = async (id: string): Promise<Record<string, unknown>> => {
    const [row]: Array<{ properties: Record<string, unknown> }> = await dataSource.query(
      'SELECT properties FROM ci.entities WHERE entity_id = $1',
      [id],
    );

    return row.properties;
  };

  // What a merge left before the fold kept addresses: the kept person's empty
  // list from the app, and the other person's flat street and city.
  const droppedOnto = {
    emails: ['johnny.doe@example.com'],
    addresses: [],
    address: '1 Market St, Oakland',
    street_address: '1 Market St',
    city: 'Oakland',
  };

  let lost: string;
  let lostSource: string;
  let cleared: string;
  let trimmed: string;
  let folded: string;
  let hopped: string;
  let relayed: string;
  let foreign: string;
  let ownFlat: string;
  let mixed: string;
  let reprimaried: string;
  let movedOn: string;
  let result: Awaited<ReturnType<MergedAddressRepairService['repair']>>;

  beforeAll(async () => {
    // 1. Addresses dropped by a merge.
    lost = await insertPerson('Johnny Doe', droppedOnto);
    const john = { emails: ['johnny.doe@example.com'], addresses: [WORK, HOME], ...WORK_FLAT };
    lostSource = await insertPerson('John Doe', john, lost);
    await insertMerge(lostSource, lost, john);

    // 2. The person then removed the one address the merge had shown, by hand.
    cleared = await insertPerson('Annie Lee', {
      addresses: [],
      address: null,
      street_address: null,
      city: null,
      user_edited_keys: ['address', 'city', 'street_address'],
    });
    const ann = { addresses: [WORK, HOME], ...WORK_FLAT };
    await insertMerge(await insertPerson('Ann Lee', ann, cleared), cleared, ann);
    await insertEdit(cleared, {
      city: { old: 'Oakland', new: null },
      address: { old: '1 Market St, Oakland', new: null },
      street_address: { old: '1 Market St', new: null },
    });

    // 3. A later edit took the cabin off the list; the home was never there.
    trimmed = await insertPerson('Kim Ward', { addresses: [WORK] });
    const kimW = { addresses: [CABIN, HOME] };
    await insertMerge(await insertPerson('Kim W', kimW, trimmed), trimmed, kimW);
    await insertEdit(trimmed, { addresses: { old: [WORK, CABIN], new: [WORK] } });

    // 4. A merge that already folded its addresses.
    folded = await insertPerson('Ola Brandt', { addresses: [WORK] });
    const ola = { addresses: [HOME] };
    await insertMerge(await insertPerson('Ola B', ola, folded), folded, ola, { addressesFolded: true });

    // 5. The kept person was merged on into another: one hop.
    hopped = await insertPerson('Theo Ward', { addresses: [] });
    const theoOld = await insertPerson('Theodore Ward', { addresses: [] }, hopped);
    const theo = { addresses: [HOME] };
    await insertMerge(await insertPerson('T. Ward', theo, hopped), theoOld, theo);

    // 6. Another owner's merge record naming this owner's people.
    foreign = await insertPerson('Zoe Young', { addresses: [] });
    const zoe = { addresses: [HOME] };
    await insertMerge(await insertPerson('Zoe Y', zoe, foreign), foreign, zoe, {}, otherOwner);

    // 7. One hop, and the address the merge had shown removed by hand on the
    // row it went into, before that row was merged on.
    relayed = await insertPerson('Rae Kim', { addresses: [] });
    const raeOld = await insertPerson(
      'Rae K',
      { addresses: [], street_address: null, city: null, user_edited_keys: ['city', 'street_address'] },
      relayed,
    );
    const rae = { addresses: [WORK, HOME], ...WORK_FLAT };
    await insertMerge(await insertPerson('R. Kim', rae, relayed), raeOld, rae);
    await insertEdit(raeOld, {
      city: { old: 'Oakland', new: null },
      street_address: { old: '1 Market St', new: null },
    });

    // 8. The kept person's own address stayed in the flat fields through the
    // merge (its Change History row says so), and the person later moved that
    // address to another city. The merged-in address in the old city was never
    // shown there, so it comes back.
    ownFlat = await insertPerson('Lena Fox', {
      addresses: [],
      street_address: '5 Oak Ave',
      city: 'Berkeley',
      user_edited_keys: ['city'],
    });
    const lena = { addresses: [WORK], ...WORK_FLAT };
    await insertMergeWithHistory(await insertPerson('L. Fox', lena, ownFlat), ownFlat, lena, {
      addresses: [],
      street_address: '5 Oak Ave',
      city: 'Oakland',
    });
    await insertEdit(ownFlat, { city: { old: 'Oakland', new: 'Berkeley' } });

    // 9. A merge into a row merged on later (the cabin), then one straight into
    // the kept person (the home). An edit on that other row took a home off its
    // own list before the rows were merged; it says nothing about the home the
    // second merge brought. The straight merge folds first, so its home is primary.
    mixed = await insertPerson('Mia Park', { addresses: [] });
    const miaOld = await insertPerson('Mia P', { addresses: [] }, mixed);
    const miaT = { addresses: [CABIN] };
    await insertMerge(await insertPerson('M. Park', miaT, mixed), miaOld, miaT);
    const miaS = { addresses: [HOME] };
    await insertMerge(await insertPerson('Mia', miaS, mixed), mixed, miaS);
    await insertEdit(miaOld, { addresses: { old: [HOME], new: null } });

    // 10. The address the merge had shown stayed on the list when the person
    // made another one primary, so the flat fields moved off it. It is still
    // there: the merge gives it back its label.
    reprimaried = await insertPerson('Pia Holt', {
      addresses: [NEW_ROAD, { ...WORK, label: null, is_primary: false }],
      ...NEW_ROAD_FLAT,
      user_edited_keys: ['address', 'addresses', 'city', 'street_address'],
    });
    const pia = { addresses: [WORK, HOME], ...WORK_FLAT };
    await insertMergeWithHistory(await insertPerson('P. Holt', pia, reprimaried), reprimaried, pia, {
      addresses: [],
      ...WORK_FLAT,
    });
    await insertEdit(reprimaried, {
      addresses: { old: null, new: [NEW_ROAD, { ...WORK, label: null, is_primary: false }] },
      address: { old: '1 Market St, Oakland', new: '3 New Rd, Eugene' },
      street_address: { old: '1 Market St', new: '3 New Rd' },
      city: { old: 'Oakland', new: 'Eugene' },
    });

    // 11. One hop where the row merged on showed the merged-in address only in
    // its flat fields, into a person with an address of its own that later
    // moved city. The kept person never showed the work address, and it comes
    // back with its label.
    movedOn = await insertPerson('Nia Shaw', {
      addresses: [{ ...OAK_AVE, city: 'Berkeley' }],
      street_address: '5 Oak Ave',
      city: 'Berkeley',
      user_edited_keys: ['address', 'addresses', 'city'],
    });
    const niaT = { addresses: [], ...WORK_FLAT };
    const niaOld = await insertPerson('Nia', niaT, movedOn);
    const niaA = { addresses: [WORK, HOME], ...WORK_FLAT };
    await insertMergeWithHistory(await insertPerson('N. Shaw', niaA, movedOn), niaOld, niaA, niaT);
    await insertMergeWithHistory(niaOld, movedOn, niaT, {
      addresses: [OAK_AVE],
      street_address: '5 Oak Ave',
      city: 'Oakland',
    });
    await insertEdit(movedOn, {
      addresses: { old: [OAK_AVE], new: [{ ...OAK_AVE, city: 'Berkeley' }] },
      city: { old: 'Oakland', new: 'Berkeley' },
    });

    result = await repairer.repair([owner, otherOwner]);
  });

  it('puts back the addresses a merge dropped, as a merge folds them now, and says so in Change History', async () => {
    // Eleven of this owner's merges (one more already folded its addresses);
    // eight people changed; three addresses left off as removed by hand.
    expect(result).toEqual({ merges: 11, people: 8, leftOff: 3 });

    const johnny = await propertiesOf(lost);
    expect(johnny.addresses).toEqual([
      expect.objectContaining({
        label: 'work',
        street_address: '1 Market St',
        city: 'Oakland',
        is_primary: true,
      }),
      expect.objectContaining({ label: 'home', city: 'Berkeley', is_primary: false }),
    ]);
    expect(johnny).toMatchObject({ address: '1 Market St, Oakland', city: 'Oakland' });
    expect(johnny.emails).toEqual(['johnny.doe@example.com']);

    const [history]: Array<{
      change_source: string;
      change_reason: string;
      changed_fields: Record<string, unknown>;
    }> = await dataSource.query(
      `SELECT change_source, change_reason, changed_fields FROM ci.graph_deltas
          WHERE entity_id = $1 AND change_source = 'MergedAddressRepairService.repair'`,
      [lost],
    );
    expect(history.change_reason).toMatch(/merged into this one/);
    expect(Object.keys(history.changed_fields)).toEqual(['addresses']);
    expect(send).toHaveBeenCalledWith('person.updated', { personId: lost });
  });

  it('leaves an address the person removed by hand after the merge off', async () => {
    // Cleared by hand: nothing comes back.
    expect((await propertiesOf(cleared)).addresses).toEqual([]);

    // Taken off the list: the cabin stays off, the home comes back.
    expect((await propertiesOf(trimmed)).addresses).toEqual([
      expect.objectContaining({ label: 'work', city: 'Oakland', is_primary: true }),
      expect.objectContaining({ label: 'home', city: 'Berkeley', is_primary: false }),
    ]);

    // Removed on the row the merge went into, which was merged on later: the
    // work address stays off the person it ended up on, the home comes back.
    expect((await propertiesOf(relayed)).addresses).toEqual([
      expect.objectContaining({ label: 'home', city: 'Berkeley', is_primary: true }),
    ]);
  });

  it('reads a flat-field edit as a removal only of an address the merge left there, and only edits on the rows that held it', async () => {
    // The person's own address moved city; the merged-in one in the old city comes back.
    const lena = await propertiesOf(ownFlat);
    expect(lena.addresses).toEqual([
      expect.objectContaining({
        label: null,
        street_address: '5 Oak Ave',
        city: 'Berkeley',
        is_primary: true,
      }),
      expect.objectContaining({
        label: 'work',
        street_address: '1 Market St',
        city: 'Oakland',
        is_primary: false,
      }),
    ]);
    expect(lena).toMatchObject({ street_address: '5 Oak Ave', city: 'Berkeley' });

    // The other row's edit leaves the straight merge's home alone, and that
    // merge folds before the one through the other row.
    expect((await propertiesOf(mixed)).addresses).toEqual([
      expect.objectContaining({ label: 'home', city: 'Berkeley', is_primary: true }),
      expect.objectContaining({ label: 'cabin', city: 'Bend', is_primary: false }),
    ]);
  });

  it('gives an address removed by hand its label back when the person still has it or another merge brings it', async () => {
    expect((await propertiesOf(reprimaried)).addresses).toEqual([
      expect.objectContaining({ label: null, street_address: '3 New Rd', is_primary: true }),
      expect.objectContaining({ label: 'work', street_address: '1 Market St', is_primary: false }),
      expect.objectContaining({ label: 'home', city: 'Berkeley', is_primary: false }),
    ]);

    expect((await propertiesOf(movedOn)).addresses).toEqual([
      expect.objectContaining({
        label: null,
        street_address: '5 Oak Ave',
        city: 'Berkeley',
        is_primary: true,
      }),
      expect.objectContaining({
        label: 'work',
        street_address: '1 Market St',
        city: 'Oakland',
        is_primary: false,
      }),
      expect.objectContaining({ label: 'home', city: 'Berkeley', is_primary: false }),
    ]);
  });

  it("follows one hop, skips merges that folded their addresses and never reads another owner's record", async () => {
    expect((await propertiesOf(hopped)).addresses).toEqual([
      expect.objectContaining({ label: 'home', city: 'Berkeley', is_primary: true }),
    ]);
    expect((await propertiesOf(folded)).addresses).toEqual([expect.objectContaining({ city: 'Oakland' })]);
    expect((await propertiesOf(foreign)).addresses).toEqual([]);

    const flags: Array<{ flagged: boolean }> = await dataSource.query(
      `SELECT details ? 'addressesFolded' AS flagged FROM ci.entity_merges WHERE owner_user_id = $1`,
      [owner],
    );
    expect(flags.every((row) => row.flagged)).toBe(true);
  });

  it('reads each merge once, so a second run changes nothing and an address removed since stays removed', async () => {
    await dataSource.query(
      `UPDATE ci.entities SET properties = properties || '{"addresses": []}' WHERE entity_id = $1`,
      [lost],
    );

    await expect(repairer.repair([owner, otherOwner])).resolves.toEqual({ merges: 0, people: 0, leftOff: 0 });
    expect((await propertiesOf(lost)).addresses).toEqual([]);
  });
});
