import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';

import { IMPORT_DATABASE_ENV } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 20260930022046 — A CONTACT CARD'S OWN EMAILS AND PHONES, INDEXED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The migration repairs Persons imported while staging kept only ONE handle
 * per card: it reads the card's own typed `Emails` / `Phones`, adds what is a
 * contact method to `emails` / `phones`, and indexes it first-writer-wins.
 * Every rule it applies is one the TypeScript applies at import
 * (`staging/identity.ts` `contactIdentifiers`), so each is pinned here on rows
 * Postgres holds, in one transaction that is rolled back.
 *
 * Invented throughout: 555-01XX numbers, `.example` mail.
 */

const availability = databaseAvailability(IMPORT_DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[import/indexContactCardIdentifiers.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

function migrationUp(): string {
  const file = path.resolve(
    __dirname,
    '../../../../db/postgres/migrations/20260930022046_index_contact_card_emails_and_phones.sql',
  );
  const sql = readFileSync(file, 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no migrate:up / migrate:down markers.`);
  }

  return sql.slice(start + '-- migrate:up'.length, end);
}

describeWithDb(`indexing a contact card's own emails and phones (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let userId: string;

  const ids = {
    /** A mail stub minted for Ada's address before her card was repaired: it holds the identifier. */
    stub: randomUUID(),
    /** Keyed on the office fax, as a real card was. */
    ada: randomUUID(),
    bo: randomUUID(),
    /** A card imported after faxes were filed apart. */
    cy: randomUUID(),
    /** Merged away: a tombstone is a redirect, not a person. */
    tombstone: randomUUID(),
    /** Not from a contact card at all. */
    chat: randomUUID(),
    /** A card whose only number carries an extension, and a user TYPED that number into the form. */
    eve: randomUUID(),
    /** A card whose fake a form save round-tripped: "verified", yet no one typed it. */
    fin: randomUUID(),
    /** A merge survivor with an extension fake, and the record merged into it. */
    gus: randomUUID(),
    gusStub: randomUUID(),
    /** An extension the old pattern missed: not at the end of the value. */
    hal: randomUUID(),
    /** A household staging collapsed onto one row, and one person under two spellings. */
    ruiz: randomUUID(),
    kit: randomUUID(),
    /** Kai's card, and a friend's card that lists Kai's address beside her own. */
    kai: randomUUID(),
    lumi: randomUUID(),
    /** Two copies of one person's card, under one name. */
    sam: randomUUID(),
    samToo: randomUUID(),
  };

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  async function seed(
    entityId: string,
    name: string,
    properties: Record<string, unknown>,
    createdAt: string,
    extra: { mergedInto?: string } = {},
  ): Promise<void> {
    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, created_at,
                                merged_into_entity_id, is_active)
       VALUES ($1, 'Person', $2, $3::jsonb, $4, $5::timestamptz, $6, $7)`,
      [
        entityId,
        name,
        JSON.stringify(properties),
        userId,
        createdAt,
        extra.mergedInto ?? null,
        extra.mergedInto == null,
      ],
    );
  }

  async function indexed(kind: string, value: string): Promise<string | undefined> {
    const rows = await q<Array<{ entity_id: string }>>(
      `SELECT entity_id FROM ci.entity_identifiers
        WHERE owner_user_id = $1 AND kind = $2 AND value_normalized = $3`,
      [userId, kind, value],
    );

    return rows[0]?.entity_id;
  }

  async function propertiesOf(entityId: string): Promise<Record<string, unknown>> {
    const [row] = await q<Array<{ properties: Record<string, unknown> }>>(
      `SELECT properties FROM ci.entities WHERE entity_id = $1`,
      [entityId],
    );

    return row.properties;
  }

  beforeAll(async () => {
    const connection = resolveConnection(IMPORT_DATABASE_ENV);

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
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'IndexContactCardIdentifiers');

    await seed(ids.stub, 'ada@quill-legal.example', { emails: ['ada@quill-legal.example'] }, '2026-01-01');
    await q(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized)
       VALUES ($1, $2, 'email', 'ada@quill-legal.example')`,
      [ids.stub, userId],
    );

    // A card of Ada's whose only number was the office line at her extension
    // left its key, 5550110229, on her row as a "phone".
    await seed(
      ids.ada,
      'Ada Quill',
      {
        Emails: ['Ada Quill <Ada@Quill-Legal.example>', 'info@quill-legal.example', 'not an address'],
        Phones: [
          '(212) 555-0110;229',
          '(212) 555-0118',
          'tel:(646) 555-0142',
          '(646) 555-0142 x7',
          'Front desk',
        ],
        phones: ['5550110229', '2125550118'],
        phone: '5550110229',
      },
      '2026-01-02',
    );
    await q(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized)
       VALUES ($1, $2, 'phone', '2125550118'), ($1, $2, 'phone', '5550110229')`,
      [ids.ada, userId],
    );
    await seed(ids.eve, 'Eve Quill', { Phones: ['(202) 555-0199 x5'], phones: ['0255501995'] }, '2026-01-07');
    await q(
      `INSERT INTO ci.entity_identifiers
         (entity_id, owner_user_id, kind, value_normalized, raw_value, source, verified_at)
       VALUES ($1, $2, 'phone', '0255501995', '(202) 555-0199 x5', 'user', now())`,
      [ids.eve, userId],
    );
    // replaceForEntity promotes every row a form save round-trips — the fake
    // included — and never writes a raw_value for it.
    await seed(ids.fin, 'Fin Quill', { Phones: ['(212) 555-0162;4'], phones: ['1255501624'] }, '2026-01-12');
    await q(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, source, verified_at)
       VALUES ($1, $2, 'phone', '1255501624', 'user', now())`,
      [ids.fin, userId],
    );
    await seed(
      ids.gus,
      'Gus Quill',
      { Phones: ['(212) 555-0147 x229'], phones: ['5550147229'] },
      '2026-01-13',
    );
    await q(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized)
       VALUES ($1, $2, 'phone', '5550147229')`,
      [ids.gus, userId],
    );
    await seed(ids.gusStub, '+1 (555) 014-7229', { phones: ['5550147229'] }, '2026-01-14', {
      mergedInto: ids.gus,
    });
    await seed(
      ids.hal,
      'Hal Quill',
      { Phones: ['(646) 555-0170 x31 (office)', '(646) 555-0171'], phones: ['6555017031'] },
      '2026-01-15',
    );
    await q(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized)
       VALUES ($1, $2, 'phone', '6555017031')`,
      [ids.hal, userId],
    );

    await seed(
      ids.bo,
      'Bo Brightwater',
      {
        Emails: ['bo@quill-legal.example'],
        Phones: ['212-555-0110', '212-555-0118'],
        phones: ['2125550110'],
      },
      '2026-01-03',
    );

    await seed(
      ids.cy,
      'Cy Quill',
      { Phones: ['(202) 555-0150', '(202) 555-0151'], Faxes: ['202-555-0151'] },
      '2026-01-04',
    );

    await seed(ids.tombstone, 'Ada Q', { Emails: ['ada.q@example.com'] }, '2026-01-05', {
      mergedInto: ids.gus,
    });
    await seed(ids.chat, 'Dee Park', { phones: ['2025550177'] }, '2026-01-06');

    // The friend's card is the OLDER one: first writer wins would hand her Kai's address.
    await seed(ids.lumi, 'Lumi Park', { Emails: ['lumi@park.example', 'kai@mori.example'] }, '2026-01-08');
    await seed(ids.kai, 'Kai Mori', { Emails: ['kai@mori.example'] }, '2026-01-09');
    await seed(ids.sam, 'Sam Tully', { Emails: ['sam@tully.example'] }, '2026-01-10');
    await seed(ids.samToo, 'Sam Tully', { Emails: ['sam@tully.example'] }, '2026-01-11');

    await seed(
      ids.ruiz,
      'Ana Ruiz',
      {
        Names: ['Ana Ruiz', 'Luis Ruiz'],
        Emails: ['ana.ruiz@example.com', 'luis.ruiz@example.org'],
        Phones: ['(415) 555-0100', '(415) 555-0111', '(415) 555-0122'],
        phones: ['4155550100'],
      },
      '2026-01-16',
    );
    await seed(
      ids.kit,
      'Kit Moss',
      { Names: ['Kit Moss', 'Kit A. Moss'], Emails: ['kit@moss.example'] },
      '2026-01-17',
    );

    await q(migrationUp());
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('adds the card’s own methods after the ones the row already had, and drops the extension fake', async () => {
    expect(await propertiesOf(ids.ada)).toMatchObject({
      // The address inside <…>, lower-cased; the role inbox and the non-address left out.
      emails: ['ada@quill-legal.example'],
      email: 'ada@quill-legal.example',
      // The fake is gone, and the primary with it; then the office number as
      // it was, and the cell. The extension-bearing cell and the note are no line.
      phones: ['2125550118', '6465550142'],
      phone: '2125550118',
    });
  });

  it('takes the fake out of the index, but never a number a user typed', async () => {
    expect(await indexed('phone', '5550110229')).toBeUndefined();
    // Eve typed her extension number into the form: the row keeps the typed
    // form, and it is hers to change, not this migration's.
    expect(await indexed('phone', '0255501995')).toBe(ids.eve);
  });

  it('takes out a fake a form save marked verified — no one typed it', async () => {
    expect(await indexed('phone', '1255501624')).toBeUndefined();
    expect((await propertiesOf(ids.fin)).phones).toBeUndefined();
  });

  it("leaves a merge survivor's numbers alone: they can be a merged-in record's real line", async () => {
    expect((await propertiesOf(ids.gus)).phones).toEqual(['5550147229']);
    expect(await indexed('phone', '5550147229')).toBe(ids.gus);
  });

  it('recognises an extension anywhere in the value, not only at its end', async () => {
    expect((await propertiesOf(ids.hal)).phones).toEqual(['6465550171']);
    expect(await indexed('phone', '6555017031')).toBeUndefined();
    expect(await indexed('phone', '6465550171')).toBe(ids.hal);
  });

  it('never adds a number the card files as a fax', async () => {
    expect(await propertiesOf(ids.cy)).toMatchObject({ phones: ['2025550150'], phone: '2025550150' });
  });

  it('keeps the fax of a row imported before faxes were filed apart — it cannot tell', async () => {
    expect((await propertiesOf(ids.bo)).phones).toEqual(['2125550110', '2125550118']);
  });

  it('indexes first-writer-wins, exactly as import does', async () => {
    // New: nobody held them.
    expect(await indexed('phone', '6465550142')).toBe(ids.ada);
    expect(await indexed('email', 'bo@quill-legal.example')).toBe(ids.bo);
    expect(await indexed('phone', '2025550150')).toBe(ids.cy);
    // Held already: the stub keeps Ada's address and Ada keeps the office
    // fax. Those pairs are what the duplicate detector's claim pass finds.
    expect(await indexed('email', 'ada@quill-legal.example')).toBe(ids.stub);
    expect(await indexed('phone', '2125550118')).toBe(ids.ada);
    // Never indexed at all.
    expect(await indexed('email', 'info@quill-legal.example')).toBeUndefined();
    expect(await indexed('phone', '5550110229')).toBeUndefined();
    expect(await indexed('phone', '2025550151')).toBeUndefined();
  });

  it('never indexes a value another card lists under a different name, and keeps it on the record', async () => {
    // Under the older card, Kai's address would resolve Kai's mail to his friend.
    expect(await indexed('email', 'kai@mori.example')).toBeUndefined();
    expect(await indexed('email', 'lumi@park.example')).toBe(ids.lumi);
    expect((await propertiesOf(ids.lumi)).emails).toEqual(['lumi@park.example', 'kai@mori.example']);
    expect((await propertiesOf(ids.kai)).emails).toEqual(['kai@mori.example']);
    // One person's two cards: the older one claims it, as at import.
    expect(await indexed('email', 'sam@tully.example')).toBe(ids.sam);
  });

  it('repairs nothing on a row that is several people — it cannot say whose address is whose', async () => {
    expect(await propertiesOf(ids.ruiz)).toMatchObject({ phones: ['4155550100'] });
    expect(await propertiesOf(ids.ruiz)).not.toHaveProperty('emails');
    expect(await indexed('email', 'luis.ruiz@example.org')).toBeUndefined();
    expect(await indexed('email', 'ana.ruiz@example.com')).toBeUndefined();
    // One person under two spellings is still one person.
    expect((await propertiesOf(ids.kit)).emails).toEqual(['kit@moss.example']);
    expect(await indexed('email', 'kit@moss.example')).toBe(ids.kit);
  });

  it('keeps the typed form beside the key, as EntityIdentifierService does', async () => {
    const [row] = await q<Array<{ raw_value: string | null; source: string | null }>>(
      `SELECT raw_value, source FROM ci.entity_identifiers
        WHERE owner_user_id = $1 AND kind = 'phone' AND value_normalized = '6465550142'`,
      [userId],
    );

    expect(row).toEqual({ raw_value: 'tel:(646) 555-0142', source: null });
  });

  it('leaves a tombstone and a row with no card alone', async () => {
    expect(await propertiesOf(ids.tombstone)).toEqual({ Emails: ['ada.q@example.com'] });
    expect(await indexed('email', 'ada.q@example.com')).toBeUndefined();
    expect(await propertiesOf(ids.chat)).toEqual({ phones: ['2025550177'] });
  });

  it('is idempotent: a second run changes nothing', async () => {
    const snapshot = async () =>
      q<unknown[]>(
        `SELECT e.entity_id, e.properties,
                (SELECT count(*)::int FROM ci.entity_identifiers i WHERE i.entity_id = e.entity_id) AS indexed
           FROM ci.entities e WHERE e.owner_user_id = $1 ORDER BY e.entity_id`,
        [userId],
      );
    const before = await snapshot();

    await q(migrationUp());

    expect(await snapshot()).toEqual(before);
  });
});
