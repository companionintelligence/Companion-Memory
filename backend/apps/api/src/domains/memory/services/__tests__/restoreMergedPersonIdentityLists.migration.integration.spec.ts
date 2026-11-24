import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PersonEntity } from '../../entities/PersonEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { PersonMergeService } from '../PersonMergeService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT AN IMPORT ERASED FROM A MERGE SURVIVOR COMES BACK. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until the ingest fix (`graph/utils/ingestedProperties.ts`), re-importing a
 * merge target's own card replaced its `properties` wholesale, and every
 * identity value `PersonMergeService` had folded in from a merged-away
 * duplicate vanished. {@link MIGRATION} puts them back from the one copy the
 * import could not reach: the source's bag in `ci.entity_merges.details`.
 *
 * Each case below makes its merges with the REAL `PersonMergeService`, so the
 * audit rows, the fold and the path compression are the ones production
 * writes; then applies the pre-fix refresh the way it ran
 * (`properties = <the card's bag>`); then, for the cases about history the
 * current code cannot produce, rewrites a row the way a later repair or an
 * older merge left it. The migration is applied verbatim from disk, once, and
 * every case asserts what it left — including that it rewrote exactly the rows
 * it should have and no other (a row's `ctid` moves on every UPDATE).
 *
 * Everything happens in one transaction, rolled back in `afterAll`. Opt-in
 * like its neighbours — set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to
 * a migrated database of your OWN: a private `ci/database` container with
 * `yarn workspace @ci/be-api migrate` run against it. Host port 5432 usually
 * belongs to another worktree's stack.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:…@127.0.0.1:<port>/companion \
 *     yarn workspace @ci/be-api jest restoreMergedPersonIdentityLists.migration
 *
 * Every person, number and address here is invented: 555-01XX under real area
 * codes, Ofcom's drama range for the UK number, `.example` domains.
 */

const MIGRATION = '20260930025958_restore_merged_person_identity_lists.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/restoreMergedPersonIdentityLists.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = () =>
  ({ setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as never;

type Bag = Record<string, unknown> | null;

interface StoredRow {
  properties: Bag;
  /** Moves on every UPDATE, so an unmoved one proves the row was not rewritten. */
  ctid: string;
  updated_at: Date;
}

/** What every seeded row's `updated_at` says, so a bump is visible. */
const SEEDED_AT = new Date('2026-09-01T00:00:00Z');

/** A bag as a bind value: `null` must bind SQL NULL, not the jsonb value null. */
function jsonb(bag: Bag): string | null {
  return bag === null ? null : JSON.stringify(bag);
}

describeWithDb(`restoring what an import erased from a merge survivor (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let merges: PersonMergeService;
  let owner: UserServiceContext;
  let stranger: UserServiceContext;
  let transactionNow: Date;

  /** Every row a case made, by label, and the rows the migration must rewrite. */
  const ids = new Map<string, string>();
  const repaired = new Set<string>();
  const before = new Map<string, StoredRow>();
  let identifiersBefore: Array<Record<string, string>>;

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  function id(label: string): string {
    const found = ids.get(label);

    if (found == null) {
      throw new Error(`no row seeded as "${label}"`);
    }

    return found;
  }

  async function person(label: string, bag: Bag, who: UserServiceContext = owner): Promise<string> {
    const [{ entity_id }] = await q<Array<{ entity_id: string }>>(
      `INSERT INTO ci.entities (entity_type, owner_user_id, name, properties, updated_at)
       VALUES ('Person', $1, $2, $3::jsonb, $4)
       RETURNING entity_id`,
      [who.userId, label, jsonb(bag), SEEDED_AT],
    );

    ids.set(label, entity_id);

    return entity_id;
  }

  /** The real merge, then its audit rows re-dated to when the case says it happened. */
  async function merge(
    sources: string[],
    target: string,
    mergedAt: string,
    who: UserServiceContext = owner,
  ): Promise<void> {
    await merges.mergePeople(who, sources.map(id), id(target));
    await q(
      `UPDATE ci.entity_merges SET created_at = $3
        WHERE source_entity_id = ANY($1::uuid[]) AND target_entity_id = $2`,
      [sources.map(id), id(target), mergedAt],
    );
  }

  /**
   * The pre-fix refresh: `ON CONFLICT ... DO UPDATE SET properties = EXCLUDED.properties`
   * — the card's bag, whatever the row held. `updated_at` is put back so the
   * migration's own bump is the only one there is.
   */
  async function reimport(label: string, card: Bag): Promise<void> {
    await q(`UPDATE ci.entities SET properties = $2::jsonb, updated_at = $3 WHERE entity_id = $1`, [
      id(label),
      jsonb(card),
      SEEDED_AT,
    ]);
  }

  async function row(label: string): Promise<StoredRow> {
    const [found] = await q<StoredRow[]>(
      `SELECT properties, ctid::text AS ctid, updated_at FROM ci.entities WHERE entity_id = $1`,
      [id(label)],
    );

    return found;
  }

  async function snapshotAll(): Promise<Map<string, StoredRow>> {
    const rows = new Map<string, StoredRow>();

    for (const label of ids.keys()) {
      rows.set(label, await row(label));
    }

    return rows;
  }

  // ── The cases ─────────────────────────────────────────────────────────────

  // Ada's work card lists her office line. Her mobile only ever reached the
  // appliance as a chat participant, which minted a stub; the user merged it
  // into her card, and the card was then imported again — with a second office
  // line added since.
  const adaCard = {
    Source: 'vCard',
    Names: ['Ada Quill'],
    Emails: ['ada@quill-legal.example'],
    Phones: ['(212) 555-0118'],
    phone: '2125550118',
    phones: ['2125550118'],
    names: ['Ada Quill'],
    emails: ['ada@quill-legal.example'],
  };
  const adaStub = {
    Phones: ['+1 212-555-0144'],
    phone: '2125550144',
    phones: ['2125550144'],
    names: ['Ada Q'],
    emails: ['ada.q@mail.example'],
  };

  async function seedAda(): Promise<void> {
    await person('ada', adaCard);
    await person('ada-stub', adaStub);
    // The chat lane indexed the stub's number when it minted the stub; the
    // merge re-points that row to Ada, and nothing after it removes the row.
    await q(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, source)
       VALUES ($1, $2, 'phone', '2125550144', 'import:communications:participant')`,
      [id('ada-stub'), owner.userId],
    );
    await merge(['ada-stub'], 'ada', '2026-08-12T10:00:00Z');
    await reimport('ada', { ...adaCard, Phones: ['(212) 555-0118', '(212) 555-0199'] });
    repaired.add('ada');
  }

  // Ben's row holds its lists in shapes a merge never writes: a duplicate
  // member, a lone string for `Phones`, an empty `emails`, no `names` at all.
  async function seedBen(): Promise<void> {
    await person('ben', {
      Source: 'vCard',
      Phones: ['(202) 555-0100'],
      phones: ['2025550100'],
      names: ['Ben Ortiz'],
    });
    await person('ben-stub', {
      Phones: ['202-555-0177'],
      phones: ['2025550177', '2025550100'],
      names: ['B. Ortiz'],
      emails: ['ben@ortiz.example'],
    });
    await merge(['ben-stub'], 'ben', '2026-08-12T10:00:00Z');
    await reimport('ben', {
      Source: 'vCard',
      Phones: '(202) 555-0100',
      phones: ['2025550101', '2025550100', '2025550101'],
      emails: [],
    });
    repaired.add('ben');
  }

  // Cy's duplicate wrote his numbers differently: the same digits in another
  // format, a non-number padded with a no-break space, a name in lower case.
  const cyCard = {
    Phones: ['(303) 555-0163', 'ask front desk'],
    phones: ['3035550163'],
    names: ['Cy Stone'],
  };

  async function seedCy(): Promise<void> {
    await person('cy', cyCard);
    await person('cy-stub', {
      Phones: ['303.555.0163', ' ask front desk\u00a0', '+44 20 7946 0958'],
      phones: ['3035550163'],
      names: ['Cy Stone', 'cy stone'],
    });
    await merge(['cy-stub'], 'cy', '2026-08-12T10:00:00Z');
    await reimport('cy', cyCard);
    repaired.add('cy');
  }

  // Dee had two duplicates, merged in the opposite order to their audit dates
  // so the dates, not the ids, have to decide the order; they share a number.
  const deeCard = { phones: ['4155550100'], names: ['Dee Park'] };

  async function seedDee(): Promise<void> {
    await person('dee', deeCard);
    await person('dee-stub-later', { phones: ['4155550122', '4155550111'], names: ['D. Park'] });
    await person('dee-stub-earlier', { phones: ['4155550111'], names: ['Dee'] });
    await merge(['dee-stub-later'], 'dee', '2026-09-10T10:00:00Z');
    await merge(['dee-stub-earlier'], 'dee', '2026-08-10T10:00:00Z');
    await reimport('dee', deeCard);
    repaired.add('dee');
  }

  // Eve absorbed a stub, lost its number to her own list's re-import, and was
  // then merged into Evelyn — so the stub's number survives nowhere but its
  // own merge row, whose target is now a tombstone one hop from Evelyn.
  const eveList = { Source: 'Contact list', phones: ['5035550141'], names: ['Eve Adler'] };
  const evelynCard = { Source: 'vCard', phones: ['5035550142'], names: ['Evelyn Adler'] };

  async function seedEve(): Promise<void> {
    await person('eve-stub', { phones: ['5035550140'], names: ['Evie'] });
    await person('eve', eveList);
    await person('evelyn', evelynCard);
    await merge(['eve-stub'], 'eve', '2026-08-12T10:00:00Z');
    await reimport('eve', eveList);
    await merge(['eve'], 'evelyn', '2026-08-20T10:00:00Z');
    await reimport('evelyn', evelynCard);
    repaired.add('evelyn');
  }

  // Fay's chain is the same shape, but made before path compression (#1840):
  // the stub still points at Fay, a tombstone, not at Fiona.
  const fayList = { phones: ['6025550151'], names: ['Fay Oduya'] };
  const fionaCard = { phones: ['6025550152'], names: ['Fiona Oduya'] };

  async function seedFay(): Promise<void> {
    await person('fay-stub', { phones: ['6025550150'], names: ['Fay O'] });
    await person('fay', fayList);
    await person('fiona', fionaCard);
    await merge(['fay-stub'], 'fay', '2026-08-03T10:00:00Z');
    await reimport('fay', fayList);
    await merge(['fay'], 'fiona', '2026-08-04T10:00:00Z');
    await q(`UPDATE ci.entities SET merged_into_entity_id = $2 WHERE entity_id = $1`, [
      id('fay-stub'),
      id('fay'),
    ]);
    await reimport('fiona', fionaCard);
    repaired.add('fiona');
  }

  // Gus's duplicate was a call-log heading minted as a person, which a later
  // repair deleted outright.
  const gusCard = { phones: ['7185550161'], names: ['Gus Brandt'] };

  async function seedGus(): Promise<void> {
    await person('gus', gusCard);
    await person('gus-stub', { phones: ['7185550160'], names: ['Missed call from Gus'] });
    await merge(['gus-stub'], 'gus', '2026-08-12T10:00:00Z');
    await q(`DELETE FROM ci.entities WHERE entity_id = $1`, [id('gus-stub')]);
    ids.delete('gus-stub');
    await reimport('gus', gusCard);
  }

  // Hal's duplicate was an alerts short code, later retyped out of Person.
  const halCard = { phones: ['8165550171'], names: ['Hal Moss'] };

  async function seedHal(): Promise<void> {
    await person('hal', halCard);
    await person('hal-stub', { phones: ['8165550170'], names: ['HAL alerts'] });
    await merge(['hal-stub'], 'hal', '2026-08-12T10:00:00Z');
    await q(`UPDATE ci.entities SET entity_type = 'Concept' WHERE entity_id = $1`, [id('hal-stub')]);
    await reimport('hal', halCard);
  }

  // Pat absorbed a stub and was merged into Patricia; a later repair then
  // retyped Pat's tombstone out of Person. Neither merge stands any more.
  const patriciaCard = { phones: ['5125550182'], names: ['Patricia Reyes'] };

  async function seedPat(): Promise<void> {
    await person('pat-stub', { phones: ['5125550180'], names: ['Pat R'] });
    await person('pat', { phones: ['5125550181'], names: ['Pat Reyes'] });
    await person('patricia', patriciaCard);
    await merge(['pat-stub'], 'pat', '2026-08-12T10:00:00Z');
    await reimport('pat', { phones: ['5125550181'], names: ['Pat Reyes'] });
    await merge(['pat'], 'patricia', '2026-08-20T10:00:00Z');
    await q(`UPDATE ci.entities SET entity_type = 'Concept' WHERE entity_id = $1`, [id('pat')]);
    await reimport('patricia', patriciaCard);
  }

  // Ivy's duplicate was a Twitter DM partner whose account id had been filed
  // as a phone number. 20260820000332 corrected the tombstone — phones gone,
  // names rewritten — but the merge row still holds the fabricated number.
  const ivyCard = { phones: ['3105550190'], names: ['Ivy Lin'] };

  async function seedIvy(): Promise<void> {
    await person('ivy', ivyCard);
    await person('ivy-stub', { phones: ['3305550191'], names: ['3305550191'], emails: ['ivy@home.example'] });
    await merge(['ivy-stub'], 'ivy', '2026-08-12T10:00:00Z');
    await q(
      `UPDATE ci.entities
          SET properties = (properties - 'phones' - 'names')
                           || jsonb_build_object('names', jsonb_build_array('twitter:id:3305550191'))
        WHERE entity_id = $1`,
      [id('ivy-stub')],
    );
    await reimport('ivy', ivyCard);
    repaired.add('ivy');
  }

  // Jo was merged into, erased, and then deleted by the user.
  async function seedJo(): Promise<void> {
    await person('jo', { phones: ['9195550111'] });
    await person('jo-stub', { phones: ['9195550110'] });
    await merge(['jo-stub'], 'jo', '2026-08-12T10:00:00Z');
    await reimport('jo', { phones: ['9195550111'] });
    await q(`UPDATE ci.entities SET is_active = FALSE WHERE entity_id = $1`, [id('jo')]);
  }

  // Kai's duplicate held every shape a bag can: nulls, blanks, a number and an
  // object in `phones`; a lone string where `foldProperties` reads only arrays
  // (`names`, `emails`) and where it reads one too (`Phones`); two faxes on
  // the same line.
  const kaiCard = { phones: ['6175550140'], names: ['Kai Kalani'] };

  async function seedKai(): Promise<void> {
    await person('kai', kaiCard);
    await person('kai-stub', {
      phones: [null, '', '   ', 42, { n: 1 }, '6175550142'],
      names: 'Kai K',
      emails: ' ',
      Phones: '(617) 555-0142',
      Faxes: ['(617) 555-0199', '617.555.0199'],
    });
    await merge(['kai-stub'], 'kai', '2026-08-12T10:00:00Z');
    await reimport('kai', kaiCard);
    repaired.add('kai');
  }

  // Two survivors whose bags are not objects: SQL NULL, and a corrupt array.
  async function seedOddBags(): Promise<void> {
    await person('ned', { phones: ['7725550150'] });
    await person('ned-stub', { phones: ['7725550151'] });
    await merge(['ned-stub'], 'ned', '2026-08-12T10:00:00Z');
    await reimport('ned', null);
    repaired.add('ned');

    await person('mo', { phones: ['7725550160'] });
    await person('mo-stub', { phones: ['7725550161'] });
    await merge(['mo-stub'], 'mo', '2026-08-12T10:00:00Z');
    await reimport('mo', ['corrupt'] as never);
  }

  // Another owner: one merge of their own, and one whose audit row claims the
  // first owner — which must not let it reach their rows.
  async function seedStranger(): Promise<void> {
    await person('lee', { phones: ['2065550121'], names: ['Lee Chen'] }, stranger);
    await person('lee-stub', { phones: ['2065550120'], names: ['Lee'] }, stranger);
    await merge(['lee-stub'], 'lee', '2026-08-12T10:00:00Z', stranger);
    await reimport('lee', { phones: ['2065550121'], names: ['Lee Chen'] });
    repaired.add('lee');

    await person('mon', { phones: ['2065550131'] }, stranger);
    await person('mon-stub', { phones: ['2065550130'] }, stranger);
    await merge(['mon-stub'], 'mon', '2026-08-12T10:00:00Z', stranger);
    await reimport('mon', { phones: ['2065550131'] });
    await q(`UPDATE ci.entity_merges SET owner_user_id = $2 WHERE source_entity_id = $1`, [
      id('mon-stub'),
      owner.userId,
    ]);
  }

  /** One ledger row per Person stage, each under the spelling that stage writes. */
  async function ledger(label: string): Promise<void> {
    await q(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, user_id)
       SELECT t.entity_type, $1::uuid, t.stage, 1, 'done', $2::uuid
         FROM (VALUES ('person', 'index.embed_person'), ('person', 'index.vector'),
                      ('Person', 'enrich.person_self_claim'), ('entity', 'clean.duplicate_detect'))
              AS t(entity_type, stage)
       ON CONFLICT DO NOTHING`,
      [id(label), owner.userId],
    );
  }

  async function identifiers(): Promise<Array<Record<string, string>>> {
    return q(
      `SELECT entity_id, kind, value_normalized
         FROM ci.entity_identifiers
        WHERE owner_user_id = ANY($1::uuid[])
        ORDER BY kind, value_normalized`,
      [[owner.userId, stranger.userId]],
    );
  }

  async function ledgerStages(label: string): Promise<string[]> {
    const rows = await q<Array<{ stage: string }>>(
      `SELECT stage FROM ci.pipeline_state WHERE entity_id = $1 ORDER BY stage`,
      [id(label)],
    );

    return rows.map((r) => r.stage);
  }

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
      entities: [BaseEntity, PersonEntity],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    // The migration row-locks every survivor it repairs, whoever owns it, for
    // as long as this transaction is open.
    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'memory/restoreMergedPersonIdentityLists.migration',
    );

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    const [{ now }] = await q<Array<{ now: Date }>>(`SELECT now() AS now`);

    transactionNow = now;

    owner = {
      userId: await createSyntheticTestUser((sql, params) => q(sql, params), 'IdentityRestore'),
    } as never;
    stranger = {
      userId: await createSyntheticTestUser((sql, params) => q(sql, params), 'IdentityRestoreOther'),
    } as never;

    // The delta writer takes a DataSource and only ever calls `query` on it.
    // Pointed at the transaction, its rows land — and roll back — with the rest.
    const inTransaction = {
      query: (sql: string, params?: unknown[]) => runner.query(sql, params),
    } as unknown as DataSource;

    // The real merge. Its own transaction nests as a savepoint on this runner.
    merges = new PersonMergeService(
      runner.manager.getRepository(PersonEntity),
      logger(),
      { send: jest.fn() } as never,
      new GraphDeltaWriter(inTransaction, logger()),
    );

    await seedAda();
    await seedBen();
    await seedCy();
    await seedDee();
    await seedEve();
    await seedFay();
    await seedGus();
    await seedHal();
    await seedPat();
    await seedIvy();
    await seedJo();
    await seedKai();
    await seedOddBags();
    await seedStranger();
    await ledger('ada');
    await ledger('gus');

    for (const [label, stored] of await snapshotAll()) {
      before.set(label, stored);
    }

    identifiersBefore = await identifiers();

    await q(migrationUpSql());
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    await schemaLock?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  // ── What it restores ──────────────────────────────────────────────────────

  it('gives a merge target back what its merged-away stub brought in, after the card’s own members', async () => {
    expect((await row('ada')).properties).toEqual({
      ...adaCard,
      Phones: ['(212) 555-0118', '(212) 555-0199', '+1 212-555-0144'],
      phones: ['2125550118', '2125550144'],
      names: ['Ada Quill', 'Ada Q'],
      emails: ['ada@quill-legal.example', 'ada.q@mail.example'],
    });
  });

  it('only appends: duplicates, a lone scalar and an empty list keep what they held, in order', async () => {
    expect((await row('ben')).properties).toEqual({
      Source: 'vCard',
      Phones: ['(202) 555-0100', '202-555-0177'],
      phones: ['2025550101', '2025550100', '2025550101', '2025550177'],
      emails: ['ben@ortiz.example'],
      names: ['B. Ortiz'],
    });
  });

  it('de-duplicates typed numbers on their digits and exact lists on jsonb equality, as the fold does', async () => {
    expect((await row('cy')).properties).toEqual({
      // Same digits, other format: held. A digit-less entry, keyed on its
      // trimmed text (JavaScript's trim, so the no-break space goes): held. A
      // number with other digits: appended.
      Phones: ['(303) 555-0163', 'ask front desk', '+44 20 7946 0958'],
      phones: ['3035550163'],
      // `names` compares exactly, as `foldProperties`' Set does.
      names: ['Cy Stone', 'cy stone'],
    });
  });

  it('appends several merges’ values oldest merge first, each value once', async () => {
    expect((await row('dee')).properties).toEqual({
      phones: ['4155550100', '4155550111', '4155550122'],
      names: ['Dee Park', 'Dee', 'D. Park'],
    });
  });

  it('follows a merge target that was itself merged away one hop to its survivor', async () => {
    expect((await row('evelyn')).properties).toEqual({
      ...evelynCard,
      // Eve's own values (the merge into Evelyn) before her stub's, which only
      // the stub's own merge row still held.
      phones: ['5035550142', '5035550141', '5035550140'],
      names: ['Evelyn Adler', 'Eve Adler', 'Evie'],
    });
  });

  it('reads a source value the way foldProperties does: strings, not blank, lone ones only for Phones / Faxes', async () => {
    expect((await row('kai')).properties).toEqual({
      phones: ['6175550140', '6175550142'],
      names: ['Kai Kalani'],
      Phones: ['(617) 555-0142'],
      Faxes: ['(617) 555-0199'],
    });
  });

  it('treats a survivor whose bag is SQL NULL as empty', async () => {
    expect((await row('ned')).properties).toEqual({ phones: ['7725550151'] });
  });

  it('repairs another owner’s survivor from that owner’s own merge', async () => {
    expect((await row('lee')).properties).toEqual({
      phones: ['2065550121', '2065550120'],
      names: ['Lee Chen', 'Lee'],
    });
  });

  // ── What it refuses ───────────────────────────────────────────────────────

  it('restores nothing a later repair took off the source’s tombstone', async () => {
    expect((await row('ivy')).properties).toEqual({
      // Neither the account id filed as a phone, nor the name either spelling
      // of it: the first is gone from the tombstone, the second never was in
      // the snapshot. The address, still on both, comes back.
      phones: ['3105550190'],
      names: ['Ivy Lin'],
      emails: ['ivy@home.example'],
    });
  });

  it('skips a chain two hops deep, as every one-hop reader would', async () => {
    // Fay's own values come back through her merge into Fiona; her stub's do
    // not, because its tombstone still points at Fay.
    expect((await row('fiona')).properties).toEqual({
      ...fionaCard,
      phones: ['6025550152', '6025550151'],
      names: ['Fiona Oduya', 'Fay Oduya'],
    });
  });

  it.each([
    ['a source a later repair deleted', 'gus'],
    ['a source retyped out of Person', 'hal'],
    ['a survivor reached only through a target retyped out of Person', 'patricia'],
    ['a survivor the user deleted', 'jo'],
    ['a survivor whose bag is not an object', 'mo'],
    ['a survivor another owner’s audit row names', 'mon'],
  ])('leaves %s alone', async (_label, survivor) => {
    expect((await row(survivor)).ctid).toBe(before.get(survivor)!.ctid);
  });

  // ── What else it touches ──────────────────────────────────────────────────

  it('rewrites exactly the survivors it repairs — never a tombstone, never an untouched row', async () => {
    const rewritten: string[] = [];

    for (const [label, stored] of await snapshotAll()) {
      if (stored.ctid !== before.get(label)!.ctid) {
        rewritten.push(label);
      }
    }

    expect(rewritten.sort()).toEqual([...repaired].sort());
  });

  it('stamps updated_at on the rows it repairs, and only those', async () => {
    for (const [label, stored] of await snapshotAll()) {
      const was = before.get(label)!.updated_at;

      expect([label, stored.updated_at]).toEqual([label, repaired.has(label) ? transactionNow : was]);
    }

    // Visible as a bump: every repaired row was seeded (and re-imported) earlier.
    expect([...repaired].map((label) => before.get(label)!.updated_at)).toEqual(
      [...repaired].map(() => SEEDED_AT),
    );
  });

  it('re-opens every pipeline stage for a repaired survivor, whatever the ledger calls its type', async () => {
    expect(await ledgerStages('ada')).toEqual([]);
    expect(await ledgerStages('gus')).toEqual([
      'clean.duplicate_detect',
      'enrich.person_self_claim',
      'index.embed_person',
      'index.vector',
    ]);
  });

  it('writes and deletes no identifier — the merge had already moved the stub’s to its survivor', async () => {
    expect(await identifiers()).toEqual(identifiersBefore);
    expect(identifiersBefore).toContainEqual({
      entity_id: id('ada'),
      kind: 'phone',
      value_normalized: '2125550144',
    });
  });

  // ── Last: it must be safe to run again ────────────────────────────────────

  it('changes nothing when run a second time', async () => {
    const afterFirst = await snapshotAll();

    await ledger('ada');
    await q(migrationUpSql());

    for (const [label, stored] of await snapshotAll()) {
      expect([label, stored.ctid]).toEqual([label, afterFirst.get(label)!.ctid]);
    }

    // Nothing was repaired, so nothing was re-opened.
    expect(await ledgerStages('ada')).toHaveLength(4);
  });
});
