import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import Database from 'better-sqlite3';

import { AppleContactsFileImporter } from '../applecontacts';
import type { EntityAttribute, ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Apple Contacts datasource', () => {
  it('recognizes AddressBook-v22.abcddb file', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'AddressBook-v22.abcddb');
    const fi = new AppleContactsFileImporter();
    const rec = await fi.recognize({}, { filename: 'AddressBook-v22.abcddb', fullPath: dbPath });
    expect(rec.confidence).toBe(1.0);
  });

  it('imports Apple contacts', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'AddressBook-v22.abcddb');
    const fi = new AppleContactsFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'AddressBook-v22.abcddb', fullPath: dbPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // The fixture also carries Bob/Carol/an-empty-contact (see the row-boundary
    // accumulation test below); this test only asserts Alice's own shape.
    const alice = pipeline.find((p) => p.entity?.name === 'Alice Anderson');
    expect(alice).toBeDefined();
    expect(alice!.entity!.metadata?.Source).toBe('AppleContacts');
    expect(alice!.entity!.attributes).toBeDefined();
    const phoneAttr = alice!.entity!.attributes?.find((a: EntityAttribute) => a.name === 'phone');
    expect(phoneAttr?.value).toBe('+1-555-111-2222');
  });

  /**
   * The query LEFT JOINs phone/email/url onto ZABCDRECORD, so a contact with
   * more than one phone (or email) number produces multiple result rows that
   * share one Z_PK. processDB's accumulation loop (applecontacts.ts:143-170)
   * has to notice the Z_PK repeats and fold every row into the SAME
   * ContactAccumulator instead of flushing a fresh (and wrong) entity per
   * row — while still flushing a genuinely new entity the moment Z_PK
   * changes. The single-phone/single-email fixture used above never
   * exercises that fold-vs-flush branch at all.
   *
   * The fixture also carries a birth_date (Apple epoch: seconds since
   * 2001-01-01T00:00:00Z) on Alice and a fourth contact with no name and no
   * phone/email/url rows at all, covering the two other unexercised
   * branches: the epoch conversion (applecontacts.ts:206-210) and the
   * "nothing to emit" skip guard (applecontacts.ts:212).
   */
  it('accumulates multi-row contacts by Z_PK, converts birth_date, and skips empty contacts', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'AddressBook-v22.abcddb');
    const fi = new AppleContactsFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'AddressBook-v22.abcddb', fullPath: dbPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const entities = pipeline.filter((p) => p.entity).map((p) => p.entity!);
    const byName = (name: string) => entities.find((e) => e.name === name);

    // The fixture's 4th ZABCDRECORD row (Z_PK=4) has null name parts and no
    // joined phone/email/url rows — the guard at line 212 must drop it, not
    // emit a nameless, attribute-less entity.
    expect(entities.length).toBe(3);

    // Alice's ZBIRTHDAY of 607737600 is 607737600 seconds after the Apple
    // epoch (2001-01-01T00:00:00Z), i.e. a known, fixed calendar date.
    const alice = byName('Alice Anderson');
    const birthAttr = alice!.attributes?.find((a: EntityAttribute) => a.name === 'birth_date');
    expect(birthAttr?.value).toBe('2020-04-05T00:00:00.000Z');

    // Bob Baker (Z_PK=2) has two ZABCDPHONENUMBER rows and nothing else, so
    // the JOIN emits two result rows sharing Z_PK=2 — both must fold into
    // one Bob entity carrying both numbers, not two separate Bob entities
    // and not a single number.
    const bob = byName('Bob Baker');
    expect(bob).toBeDefined();
    const bobPhones = bob!.attributes?.filter((a: EntityAttribute) => a.name === 'phone').map((a) => a.value);
    expect(bobPhones).toEqual(expect.arrayContaining(['+1-555-333-4444', '+1-555-333-5555']));
    expect(bobPhones).toHaveLength(2);
    expect(bob!.attributes?.some((a: EntityAttribute) => a.name === 'email')).toBe(false);

    // Carol Chen (Z_PK=3) is the same shape on the email side: two
    // ZABCDEMAILADDRESS rows folded into one entity with both addresses.
    const carol = byName('Carol Chen');
    expect(carol).toBeDefined();
    const carolEmails = carol!.attributes
      ?.filter((a: EntityAttribute) => a.name === 'email')
      .map((a) => a.value);
    expect(carolEmails).toEqual(expect.arrayContaining(['carol@example.com', 'carol.chen@example.org']));
    expect(carolEmails).toHaveLength(2);
    expect(carol!.attributes?.some((a: EntityAttribute) => a.name === 'phone')).toBe(false);
  });

  /**
   * A synced macOS profile keeps one AddressBook-v22.abcddb per connected
   * account under Sources/<account-id>/, with the top-level db (if any)
   * holding only unassigned contacts. fileImport() used to look ONLY at the
   * top-level db, so a profile like this one imported 1 of 3 contacts.
   */
  describe('Sources/ per-account databases', () => {
    function makeAddressBookDb(
      dbPath: string,
      contacts: Array<{ pk: number; name: string; phone?: string }>,
    ) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT);
        CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
        CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
        CREATE TABLE ZABCDURLADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZURL TEXT);
      `);
      const rec = db.prepare('INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME) VALUES (?, ?, ?)');
      const phone = db.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)');
      for (const c of contacts) {
        const [first, ...rest] = c.name.split(' ');
        rec.run(c.pk, first, rest.join(' ') || null);
        if (c.phone) {
          phone.run(c.pk, c.phone);
        }
      }

      db.close();
    }

    function makeProfile(root: string): void {
      // Top-level db: one unassigned contact.
      makeAddressBookDb(path.join(root, 'AddressBook-v22.abcddb'), [{ pk: 1, name: 'Unassigned Contact' }]);
      // Two synced accounts, each with their own db.
      makeAddressBookDb(path.join(root, 'Sources', 'ACCOUNT-AAA', 'AddressBook-v22.abcddb'), [
        { pk: 1, name: 'Alice Icloud', phone: '+1-555-100-0001' },
      ]);
      makeAddressBookDb(path.join(root, 'Sources', 'ACCOUNT-BBB', 'AddressBook-v22.abcddb'), [
        { pk: 1, name: 'Bob Exchange', phone: '+1-555-100-0002' },
      ]);
    }

    async function importAll(root: string): Promise<EmittedGraph[]> {
      const fi = new AppleContactsFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline;
    }

    it('recognizes a directory containing only Sources/ (no top-level db)', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sources-only-'));
      makeAddressBookDb(path.join(tmp, 'Sources', 'ACCOUNT-AAA', 'AddressBook-v22.abcddb'), [
        { pk: 1, name: 'Alice Icloud' },
      ]);

      const fi = new AppleContactsFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(tmp), fullPath: tmp });
      expect(rec.confidence).toBeGreaterThan(0);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('imports every account under Sources/ in addition to the top-level db', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sources-'));
      makeProfile(tmp);

      const entities = (await importAll(tmp)).filter((p) => p.entity).map((p) => p.entity!);
      const names = entities.map((e) => e.name).sort();
      expect(names).toEqual(['Alice Icloud', 'Bob Exchange', 'Unassigned Contact']);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('tags each contact with the account it came from, and none for the top-level db', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sources-account-'));
      makeProfile(tmp);

      const entities = (await importAll(tmp)).filter((p) => p.entity).map((p) => p.entity!);
      const byName = (name: string) => entities.find((e) => e.name === name)!;

      expect(byName('Alice Icloud').metadata?.AccountID).toBe('ACCOUNT-AAA');
      expect(byName('Bob Exchange').metadata?.AccountID).toBe('ACCOUNT-BBB');
      expect(byName('Unassigned Contact').metadata?.AccountID).toBeUndefined();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('records the real per-contact DB filename instead of a constant', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sources-dbname-'));
      makeProfile(tmp);

      const entities = (await importAll(tmp)).filter((p) => p.entity).map((p) => p.entity!);
      // Every contact's DB is literally named AddressBook-v22.abcddb, so this
      // mainly proves the field is populated per-contact rather than a
      // hardcoded module-level constant that happened to already match.
      expect(entities.every((e) => e.metadata?.DB === 'AddressBook-v22.abcddb')).toBe(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("does not fail the other accounts when one account's db is corrupt", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sources-corrupt-'));
      makeProfile(tmp);
      fs.mkdirSync(path.join(tmp, 'Sources', 'ACCOUNT-CCC'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'Sources', 'ACCOUNT-CCC', 'AddressBook-v22.abcddb'),
        'not a sqlite file',
      );

      const entities = (await importAll(tmp)).filter((p) => p.entity).map((p) => p.entity!);
      const names = entities.map((e) => e.name).sort();
      expect(names).toEqual(['Alice Icloud', 'Bob Exchange', 'Unassigned Contact']);
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });
});
