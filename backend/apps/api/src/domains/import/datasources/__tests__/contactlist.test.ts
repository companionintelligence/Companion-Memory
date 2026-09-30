import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { entityIdentityKey, legacyEntityIdentityKey } from '../../staging/identity';
import { ContactListFileImporter } from '../contactlist';
import type { DirEntry } from '../registry';
import type { Entity, EntityAttribute, Graph, ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

function makeParams() {
  const collected: EmittedGraph[] = [];

  return {
    params: { timeframe: undefined, pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) } },
    collected,
  };
}

/**
 * The header Google Contacts has exported since 2023, as far as its second
 * phone (a real export goes on with addresses, relations, websites and custom
 * fields). There is no `Name` column.
 */
const GOOGLE_HEADER = [
  'First Name',
  'Middle Name',
  'Last Name',
  'Phonetic First Name',
  'Phonetic Middle Name',
  'Phonetic Last Name',
  'Name Prefix',
  'Name Suffix',
  'Nickname',
  'File As',
  'Organization Name',
  'Organization Title',
  'Organization Department',
  'Birthday',
  'Notes',
  'Photo',
  'Labels',
  'E-mail 1 - Label',
  'E-mail 1 - Value',
  'E-mail 2 - Label',
  'E-mail 2 - Value',
  'Phone 1 - Label',
  'Phone 1 - Value',
  'Phone 2 - Label',
  'Phone 2 - Value',
];

/** The older Google Contacts header, as far as its first phone. */
const LEGACY_GOOGLE_HEADER = [
  'Name',
  'Given Name',
  'Additional Name',
  'Family Name',
  'Yomi Name',
  'Given Name Yomi',
  'Additional Name Yomi',
  'Family Name Yomi',
  'Name Prefix',
  'Name Suffix',
  'Initials',
  'Nickname',
  'Short Name',
  'Maiden Name',
  'Birthday',
  'Gender',
  'Location',
  'Billing Information',
  'Directory Server',
  'Mileage',
  'Occupation',
  'Hobby',
  'Sensitivity',
  'Priority',
  'Subject',
  'Notes',
  'Language',
  'Photo',
  'Group Membership',
  'E-mail 1 - Type',
  'E-mail 1 - Value',
  'Phone 1 - Type',
  'Phone 1 - Value',
];

/** Every column of an Outlook desktop export ("Export to a file" → CSV), in order. */
const OUTLOOK_HEADER = [
  'Title',
  'First Name',
  'Middle Name',
  'Last Name',
  'Suffix',
  'Company',
  'Department',
  'Job Title',
  'Business Street',
  'Business Street 2',
  'Business Street 3',
  'Business City',
  'Business State',
  'Business Postal Code',
  'Business Country/Region',
  'Home Street',
  'Home Street 2',
  'Home Street 3',
  'Home City',
  'Home State',
  'Home Postal Code',
  'Home Country/Region',
  'Other Street',
  'Other Street 2',
  'Other Street 3',
  'Other City',
  'Other State',
  'Other Postal Code',
  'Other Country/Region',
  "Assistant's Phone",
  'Business Fax',
  'Business Phone',
  'Business Phone 2',
  'Callback',
  'Car Phone',
  'Company Main Phone',
  'Home Fax',
  'Home Phone',
  'Home Phone 2',
  'ISDN',
  'Mobile Phone',
  'Other Fax',
  'Other Phone',
  'Pager',
  'Primary Phone',
  'Radio Phone',
  'TTY/TDD Phone',
  'Telex',
  'Account',
  'Anniversary',
  "Assistant's Name",
  'Billing Information',
  'Birthday',
  'Business Address PO Box',
  'Categories',
  'Children',
  'Directory Server',
  'E-mail Address',
  'E-mail Type',
  'E-mail Display Name',
  'E-mail 2 Address',
  'E-mail 2 Type',
  'E-mail 2 Display Name',
  'E-mail 3 Address',
  'E-mail 3 Type',
  'E-mail 3 Display Name',
  'Gender',
  'Government ID Number',
  'Hobby',
  'Home Address PO Box',
  'Initials',
  'Internet Free Busy',
  'Keywords',
  'Language',
  'Location',
  "Manager's Name",
  'Mileage',
  'Notes',
  'Office Location',
  'Organizational ID Number',
  'Other Address PO Box',
  'Priority',
  'Private',
  'Profession',
  'Referred By',
  'Sensitivity',
  'Spouse',
  'User 1',
  'User 2',
  'User 3',
  'User 4',
  'Web Page',
];

/**
 * What Outlook writes into an empty contact's columns: a blank date is
 * `0/0/00`, not an empty cell. The Outlook dialect reads `Birthday`, so every
 * named Outlook row carries a birth_date attribute, and one with no handle is
 * kept by the usefulness filter and keyed on its name.
 */
const OUTLOOK_BLANKS = {
  Anniversary: '0/0/00',
  Birthday: '0/0/00',
  Gender: 'Unspecified',
  Priority: 'Normal',
  Private: 'False',
  Sensitivity: 'Normal',
};

/**
 * A CSV of `records` under `header`, blank wherever a record names no value.
 * Throws on a column the header lacks, so a misspelt column cannot drop a value
 * and leave a test passing on nothing.
 */
function csvOf(header: readonly string[], records: ReadonlyArray<Record<string, string>>): string {
  for (const record of records) {
    for (const column of Object.keys(record)) {
      if (!header.includes(column)) {
        throw new Error(`the header has no "${column}" column`);
      }
    }
  }

  return [header, ...records.map((record) => header.map((column) => record[column] ?? ''))]
    .map((cells) => cells.join(','))
    .join('\n');
}

/** Import `csv` as one file: the contacts it emitted and the reasons it dropped rows. */
async function importCsv(csv: string): Promise<{ entities: Entity[]; dropped: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-'));
  const file = path.join(dir, 'contacts.csv');
  const entities: Entity[] = [];
  const dropped: string[] = [];
  const params: ImportParams = {
    timeframe: undefined,
    pipeline: {
      push: (g) => {
        if (g.entity) {
          entities.push(g.entity);
        }
      },
      drop: (reason) => dropped.push(reason),
    },
  };

  try {
    fs.writeFileSync(file, csv);
    await new ContactListFileImporter().fileImport(undefined, { fullPath: file } as DirEntry, params);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { entities, dropped };
}

function phonesOf(entity: Entity): EntityAttribute[] {
  return (entity.attributes ?? []).filter((attribute) => attribute.name === 'phone');
}

describe('Contact List datasource', () => {
  it('recognizes and imports Google Contacts style CSV', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      'Name,Birthday,E-mail 1 - Value,Phone 1 - Value\nAlice Example,1990-01-02,alice@example.com,+1234567',
    );
    const imp = new ContactListFileImporter();
    const rec = await imp.recognize(undefined, { fullPath: file } as DirEntry);
    expect(rec.confidence).toBeGreaterThan(0.5);
    const { params, collected } = makeParams();
    await imp.fileImport(undefined, { fullPath: file } as DirEntry, params as unknown as ImportParams);
    expect(collected.length).toBe(1);
    const ent = collected[0].entity;
    expect(ent!.name).toBe('Alice Example');
    expect(
      ent!.attributes!.some((a: EntityAttribute) => a.name === 'email' && a.value === 'alice@example.com'),
    ).toBe(true);
  });

  /**
   * bestColumnMapping scores every FormatDef in `formats` (contactlist.ts:30-65)
   * against the header and keeps whichever maps the most distinct canonical
   * fields. Only the Google Contacts dialect was ever exercised — a scoring
   * regression that made the wrong dialect win (or a header this dialect's
   * regexes fail to match at all) would pass silently. "First Name,Last
   * Name,Mobile Phone" only matches Outlook's column regexes (Generic's PHONE
   * regex requires the header to read exactly "phone"/"phone number", not
   * "Mobile Phone" — see contactlist.ts:59 vs :49), so a correct entity here
   * proves the Outlook dialect specifically won, not Generic falling back.
   */
  it('maps the Outlook / Microsoft Contacts column dialect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-outlook-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(file, 'First Name,Last Name,Mobile Phone\nBob,Builder,555-0100');
    const { params, collected } = makeParams();
    await new ContactListFileImporter().fileImport(
      undefined,
      { fullPath: file } as DirEntry,
      params as unknown as ImportParams,
    );
    expect(collected.length).toBe(1);
    const ent = collected[0].entity;
    expect(ent!.name).toBe('Bob Builder');
    expect(ent!.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'phone', value: '555-0100' })]),
    );
  });

  /**
   * "Full Name,Phone Number,Email Address,DOB" only matches the Generic
   * dialect's regexes (Outlook's EMAIL regex wants "...address" but its PHONE
   * regex wants a "<carrier> Phone" header, which "Phone Number" is not; see
   * contactlist.ts:52-65), covering the third FormatDef that had no test.
   */
  it('maps the Generic column dialect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-generic-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      'Full Name,Phone Number,Email Address,DOB\nCarla Cruz,555-0200,carla@example.com,1988-03-04',
    );
    const { params, collected } = makeParams();
    await new ContactListFileImporter().fileImport(
      undefined,
      { fullPath: file } as DirEntry,
      params as unknown as ImportParams,
    );
    expect(collected.length).toBe(1);
    const ent = collected[0].entity;
    expect(ent!.name).toBe('Carla Cruz');
    expect(ent!.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'phone', value: '555-0200' }),
        expect.objectContaining({ name: 'email', value: 'carla@example.com' }),
        expect.objectContaining({ name: 'birth_date', value: '1988-03-04' }),
      ]),
    );
  });

  /**
   * The "minimal usefulness" filter (contactlist.ts:182) drops a row unless it
   * has >= 2 mapped attributes, OR exactly a name plus 1 attribute. Below is
   * one row per branch of that filter, all under the same Generic header so
   * only the filter — not format selection — is under test.
   */
  it('drops rows below the minimal-usefulness threshold and keeps the rest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-minimal-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      [
        'Full Name,Phone Number,Email Address,DOB',
        ',555-1111,,', // no name, 1 attribute -> dropped
        'Dana Diaz,,,', // name, 0 attributes -> dropped (not the name+1 carve-out)
        'Eve Evans,,eve@example.com,', // name + 1 attribute -> kept
        ',555-2222,frank@example.com,', // no name, 2 attributes -> kept
      ].join('\n'),
    );
    const { params, collected } = makeParams();
    await new ContactListFileImporter().fileImport(
      undefined,
      { fullPath: file } as DirEntry,
      params as unknown as ImportParams,
    );
    const names = collected.map((c) => c.entity?.name);
    expect(names).toEqual(['Eve Evans', '']);
    expect(collected[1].entity!.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'phone', value: '555-2222' }),
        expect.objectContaining({ name: 'email', value: 'frank@example.com' }),
      ]),
    );
  });

  /**
   * A row whose cell count doesn't match the header is skipped outright
   * (contactlist.ts:148) rather than imported with missing trailing fields —
   * this is what stops a truncated/short CSV line from silently becoming a
   * contact with the wrong values shifted into the wrong columns.
   */
  it('skips a row whose column count does not match the header', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-malformed-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      [
        'Full Name,Phone Number,Email Address,DOB',
        'Grace Green,555-3333,grace@example.com,1985-05-05',
        'Hank Hill,555-4444', // missing Email Address and DOB cells -> malformed, skipped
        'Ivy Iverson,555-5555,ivy@example.com,1992-02-02',
      ].join('\n'),
    );
    const { params, collected } = makeParams();
    await new ContactListFileImporter().fileImport(
      undefined,
      { fullPath: file } as DirEntry,
      params as unknown as ImportParams,
    );
    const names = collected.map((c) => c.entity?.name);
    expect(names).toEqual(['Grace Green', 'Ivy Iverson']);
  });

  /**
   * The `Photo` column (Google Contacts' own export header) was recognized by
   * the header-canonicalization table (CANON.PICTURE) but its value was never
   * read anywhere — a genuine avatar URL, sitting parsed and then discarded.
   * `properties.avatar_url` is the exact key `PersonType.avatarUrl` reads
   * (backend/.../graphql/types/PersonType.ts) and `push/entities.ts` spreads
   * `entity.metadata` straight into `ci.entities.properties`, so this is the
   * whole path from CSV cell to what the People page renders.
   */
  it('carries the Photo column through as properties.avatar_url', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-photo-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      'Name,E-mail 1 - Value,Phone 1 - Value,Photo\n' +
        'Jill Jones,jill@example.com,555-6666,https://contacts.google.com/photo/jill.jpg',
    );
    const { params, collected } = makeParams();
    await new ContactListFileImporter().fileImport(
      undefined,
      { fullPath: file } as DirEntry,
      params as unknown as ImportParams,
    );

    expect(collected[0].entity?.metadata?.avatar_url).toBe('https://contacts.google.com/photo/jill.jpg');
  });

  it('does not treat a non-URL Photo cell as an avatar_url', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-photo-bad-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      'Name,E-mail 1 - Value,Phone 1 - Value,Photo\nKen Kelly,ken@example.com,555-7777,IMG_0001.HEIC',
    );
    const { params, collected } = makeParams();
    await new ContactListFileImporter().fileImport(
      undefined,
      { fullPath: file } as DirEntry,
      params as unknown as ImportParams,
    );

    expect(collected[0].entity?.metadata?.avatar_url).toBeUndefined();
  });

  /**
   * An Outlook export's "Company Main Phone" column puts the switchboard on
   * every colleague's row. Keyed on its smallest handle, each row keyed on that
   * number — digits sort before letters — and staging collapsed the rows into
   * ONE entity. This parser declares no `accumulate`, so the second and third
   * colleagues did not even survive as extra names: they vanished.
   */
  it('keys colleagues who share a company main line apart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contactlist-office-'));
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      [
        'First Name,Last Name,E-mail Address,Company Main Phone,Mobile Phone',
        'Priya,Natarajan,priya@example.com,555-010-0100,',
        'Tom,Becker,tom@example.com,555-010-0100,',
        'Lena,Ortiz,,555-010-0100,555-010-0142',
      ].join('\n'),
    );
    const { params, collected } = makeParams();
    await new ContactListFileImporter().fileImport(
      undefined,
      { fullPath: file } as DirEntry,
      params as unknown as ImportParams,
    );

    const entities = collected.map((g) => g.entity!);
    expect(entities.map((e) => e.name)).toEqual(['Priya Natarajan', 'Tom Becker', 'Lena Ortiz']);
    expect(entities.map(entityIdentityKey)).toEqual(['priya@example.com', 'tom@example.com', '5550100142']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Google Contacts export since 2023: no Name column', () => {
  /**
   * The Google dialect reads the older export's `Name`, and this export has
   * none: its name is `First Name`, `Middle Name` and `Last Name`, beside `Name
   * Prefix` and `Name Suffix`. Every row imported nameless, and a nameless row
   * needs two attributes to pass the usefulness filter, so a contact with one
   * email or one phone and nothing else, like Ben and Castellanos below, was
   * dropped as `insufficient_attributes`. The handles are the ones this export
   * always keyed on, so no key moves here.
   */
  it('names each contact from its name parts, and keeps the one-handle contacts it used to drop', async () => {
    const { entities, dropped } = await importCsv(
      csvOf(GOOGLE_HEADER, [
        {
          'First Name': 'Ana',
          'Middle Name': 'Maria',
          'Last Name': 'Ruiz',
          Labels: '* myContacts',
          'E-mail 1 - Label': '* Home',
          'E-mail 1 - Value': 'ana.ruiz@example.com',
          'Phone 1 - Label': 'Mobile',
          'Phone 1 - Value': '+1 555-010-0101',
        },
        {
          'Name Prefix': 'Dr.',
          'First Name': 'Ben',
          'Last Name': 'Okafor',
          'Name Suffix': 'Jr.',
          'E-mail 1 - Label': '* Work',
          'E-mail 1 - Value': 'ben.okafor@example.org',
        },
        { 'Last Name': 'Castellanos', 'Phone 1 - Label': 'Home', 'Phone 1 - Value': '555-010-0103' },
      ]),
    );

    expect(dropped).toEqual([]);
    expect(entities.map((e) => e.name)).toEqual(['Ana Maria Ruiz', 'Dr. Ben Okafor Jr.', 'Castellanos']);
    expect(entities.map(entityIdentityKey)).toEqual(['5550100101', 'ben.okafor@example.org', '5550100103']);
    expect(entities.map(legacyEntityIdentityKey)).toEqual(entities.map(entityIdentityKey));
  });

  /**
   * A business's card has no personal name. Google shows it under its
   * organization, as the older export's `Name` column and a vCard's `FN` do,
   * so that is its name here too. A person's card is named after the person
   * whatever organization it lists.
   */
  it('names a card with no personal name after its organization', async () => {
    const { entities, dropped } = await importCsv(
      csvOf(GOOGLE_HEADER, [
        {
          'Organization Name': 'Harbor Plumbing',
          'Phone 1 - Label': 'Work',
          'Phone 1 - Value': '555-010-0104',
        },
        {
          'First Name': 'Ana',
          'Last Name': 'Ruiz',
          'Organization Name': 'Harbor Plumbing',
          'Organization Title': 'Dispatcher',
          'E-mail 1 - Value': 'ana.ruiz@example.com',
        },
      ]),
    );

    expect(dropped).toEqual([]);
    expect(entities.map((e) => e.name)).toEqual(['Harbor Plumbing', 'Ana Ruiz']);
  });

  /**
   * A name is also what lets the shared-line rule see that two cards on one
   * number are two people. Nameless, Priya's and Tom's rows both keyed on the
   * office line and staged as ONE entity, and with no `accumulate` in this
   * parser, Tom vanished into it. Named, they key apart. Both keys move, so each
   * keeps the office line as its legacy key, and the push moves the row minted
   * under it onto one of them rather than minting both afresh (see
   * push/legacyKeys.ts).
   */
  it('keys colleagues on one office line apart, keeping the line as their legacy key', async () => {
    const { entities } = await importCsv(
      csvOf(GOOGLE_HEADER, [
        {
          'First Name': 'Priya',
          'Last Name': 'Natarajan',
          'E-mail 1 - Value': 'priya@example.com',
          'Phone 1 - Label': 'Work',
          'Phone 1 - Value': '555-010-0100',
        },
        {
          'First Name': 'Tom',
          'Last Name': 'Becker',
          'E-mail 1 - Value': 'tom@example.com',
          'Phone 1 - Label': 'Work',
          'Phone 1 - Value': '555-010-0100',
        },
      ]),
    );

    expect(entities.map(entityIdentityKey)).toEqual(['priya@example.com', 'tom@example.com']);
    expect(entities.map(legacyEntityIdentityKey)).toEqual(['5550100100', '5550100100']);
  });
});

describe('Google Contacts, older export: Name column', () => {
  /**
   * The older export states the display name outright, and `Name` wins over
   * the parts as it always did: the parts are borrowed only by a mapping with
   * no name at all.
   */
  it('still names contacts from Name and keys them as before', async () => {
    const { entities } = await importCsv(
      csvOf(LEGACY_GOOGLE_HEADER, [
        {
          Name: 'Annie Ruiz',
          'Given Name': 'Ana',
          'Family Name': 'Ruiz',
          'Group Membership': '* myContacts',
          'E-mail 1 - Type': '* Home',
          'E-mail 1 - Value': 'ana.ruiz@example.com',
          'Phone 1 - Type': 'Mobile',
          'Phone 1 - Value': '555-010-0101',
        },
      ]),
    );

    expect(entities.map((e) => e.name)).toEqual(['Annie Ruiz']);
    expect(entities[0].attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'email', value: 'ana.ruiz@example.com' })]),
    );
    expect(entities.map(entityIdentityKey)).toEqual(['5550100101']);
  });
});

describe('Outlook desktop export', () => {
  /**
   * Why the Google dialect's name parts are borrowed rather than listed as its
   * own patterns. This header has `First Name`, `Middle Name`, `Last Name`,
   * `Birthday` and `Gender`: a Google dialect listing the name parts would map
   * five of its fields, tie the Outlook dialect's five, win the tie as the
   * dialect listed first, and read none of the email and phone columns. The
   * Outlook dialect still reads no `Middle Name`, so the name is the "First
   * Last" it always was.
   */
  it('reads the whole export through the Outlook dialect', async () => {
    const { entities } = await importCsv(
      csvOf(OUTLOOK_HEADER, [
        {
          ...OUTLOOK_BLANKS,
          'First Name': 'Priya',
          'Middle Name': 'K',
          'Last Name': 'Natarajan',
          'E-mail Address': 'priya@example.com',
          'E-mail Type': 'SMTP',
          'E-mail Display Name': 'Priya Natarajan (priya@example.com)',
          'Mobile Phone': '555-010-0120',
        },
      ]),
    );

    expect(entities.map((e) => e.name)).toEqual(['Priya Natarajan']);
    expect(entities[0].attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'email', value: 'priya@example.com' }),
        expect.objectContaining({ name: 'phone', value: '555-010-0120' }),
      ]),
    );
    expect(entities.map(entityIdentityKey)).toEqual(['5550100120']);
  });

  /**
   * Outlook has nineteen number columns. The ones read are those that reach
   * the contact; contactlist.ts says why each other one is left out (an
   * assistant's line, a fax, a pager, a TTY relay, an ISDN data line, a
   * callback, a telex). The four read since 2026-09 are marked, which keeps
   * them out of the legacy key.
   */
  it('reads every phone column that reaches the contact, and no other', async () => {
    const { entities } = await importCsv(
      csvOf(OUTLOOK_HEADER, [
        {
          ...OUTLOOK_BLANKS,
          'First Name': 'Lena',
          'Last Name': 'Ortiz',
          "Assistant's Phone": '555-010-0130',
          'Business Fax': '555-010-0131',
          'Business Phone': '555-010-0132',
          'Business Phone 2': '555-010-0133',
          Callback: '555-010-0134',
          'Car Phone': '555-010-0135',
          'Company Main Phone': '555-010-0136',
          'Home Fax': '555-010-0137',
          'Home Phone': '555-010-0138',
          'Home Phone 2': '555-010-0139',
          ISDN: '555-010-0140',
          'Mobile Phone': '555-010-0141',
          'Other Fax': '555-010-0142',
          'Other Phone': '555-010-0143',
          Pager: '555-010-0144',
          'Primary Phone': '555-010-0145',
          'Radio Phone': '555-010-0146',
          'TTY/TDD Phone': '555-010-0147',
          Telex: '555-010-0148',
        },
      ]),
    );

    expect(phonesOf(entities[0]).map((phone) => [phone.value, phone.newSinceLegacyKey === true])).toEqual([
      ['555-010-0132', false], // Business Phone
      ['555-010-0133', true], // Business Phone 2
      ['555-010-0135', true], // Car Phone
      ['555-010-0136', false], // Company Main Phone
      ['555-010-0138', false], // Home Phone
      ['555-010-0139', true], // Home Phone 2
      ['555-010-0141', false], // Mobile Phone
      ['555-010-0143', false], // Other Phone
      ['555-010-0145', false], // Primary Phone
      ['555-010-0146', true], // Radio Phone
    ]);
  });

  /**
   * The cost of reading new columns: a contact keys on its smallest handle, and
   * digits sort before letters.
   *  - Lena was keyed on her email. Her second business line now sorts first.
   *  - Omar's new home line sorts after his mobile, so his key stays.
   *  - Rosa's car phone sorts below her mobile, so her key moves as well.
   * A moved contact keeps the key its existing row was minted under as its
   * legacy key. `StagedWriter` records it, and the push moves that row onto the
   * new key (push/legacyKeys.ts) instead of minting a second Person.
   */
  it('moves the key of a contact whose newly-read number sorts first, and keeps the old one as its legacy key', async () => {
    const { entities } = await importCsv(
      csvOf(OUTLOOK_HEADER, [
        {
          ...OUTLOOK_BLANKS,
          'First Name': 'Lena',
          'Last Name': 'Ortiz',
          'E-mail Address': 'lena@example.com',
          'Business Phone 2': '555-010-0142',
        },
        {
          ...OUTLOOK_BLANKS,
          'First Name': 'Omar',
          'Last Name': 'Haddad',
          'Mobile Phone': '555-010-0150',
          'Home Phone 2': '555-010-0190',
        },
        {
          ...OUTLOOK_BLANKS,
          'First Name': 'Rosa',
          'Last Name': 'Lindqvist',
          'Mobile Phone': '555-010-0170',
          'Car Phone': '555-010-0160',
        },
      ]),
    );

    expect(entities.map(entityIdentityKey)).toEqual(['5550100142', '5550100150', '5550100160']);
    expect(entities.map(legacyEntityIdentityKey)).toEqual(['lena@example.com', '5550100150', '5550100170']);
  });

  /**
   * The case the re-key cannot reach. With no email and no number in a column
   * read before, Kofi's row had no handle, but Outlook's `0/0/00` birthday kept
   * it, keyed on his NAME. Now it keys on his radio phone. A legacy key is a
   * handle, and Kofi had none, so a row already minted for him stays where it is
   * and the next import mints a second Person beside it.
   */
  it('keys a contact whose only number is newly read on that number, with no legacy key', async () => {
    const { entities } = await importCsv(
      csvOf(OUTLOOK_HEADER, [
        { ...OUTLOOK_BLANKS, 'First Name': 'Kofi', 'Last Name': 'Mensah', 'Radio Phone': '555-010-0180' },
      ]),
    );

    expect(entities.map((e) => e.name)).toEqual(['Kofi Mensah']);
    expect(entities.map(entityIdentityKey)).toEqual(['5550100180']);
    expect(entities.map(legacyEntityIdentityKey)).toEqual([null]);
  });

  /**
   * A newly-read column is evidence for the shared-line rule as well. Tom's
   * card files Priya's direct line as his second business number, so the line
   * is not hers alone and stops keying her: her key moves to her email and the
   * line stays her legacy key. Tom's key does not move. His second business line
   * was not read when his row was keyed, so his legacy key is his email, not a
   * number that would point the re-key at Priya's row.
   */
  it("lets a newly-read column mark another card's line as shared", async () => {
    const { entities } = await importCsv(
      csvOf(OUTLOOK_HEADER, [
        {
          ...OUTLOOK_BLANKS,
          'First Name': 'Priya',
          'Last Name': 'Natarajan',
          'E-mail Address': 'priya@example.com',
          'Business Phone': '555-010-0100',
        },
        {
          ...OUTLOOK_BLANKS,
          'First Name': 'Tom',
          'Last Name': 'Becker',
          'E-mail Address': 'tom@example.com',
          'Business Phone 2': '555-010-0100',
        },
      ]),
    );

    expect(entities.map(entityIdentityKey)).toEqual(['priya@example.com', 'tom@example.com']);
    expect(entities.map(legacyEntityIdentityKey)).toEqual(['5550100100', 'tom@example.com']);
  });
});
