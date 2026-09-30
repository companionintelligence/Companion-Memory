import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { naturalKeyFor } from '../../push/entities';
import { typedHandlesOf } from '../../push/truncatedPhoneKeys';
import {
  entityIdentityKey,
  normalizeHandle,
  resolveEntityType,
  stagedNaturalKey,
} from '../../staging/identity';
import { AppleContactsFileImporter } from '../applecontacts';
import { ContactListFileImporter } from '../contactlist';
import type { Entity, Graph, ImportParams } from '../timeline';
import { VCardFileImporter } from '../vcard';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CONTACT CARD'S KEY MUST BE RECOMPUTABLE FROM WHAT THE ROW KEEPS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The identity attributes a parser emits decide the natural key
 * (`contact:<smallest handle>`, else `contact:<name>`, hashed into `linked_id`)
 * and are then thrown away: staging persists `identity_key` and `metadata`,
 * and the staged run is retention-swept. What survives is `metadata`, spread
 * into `ci.entities.properties`. So a key rule change — the phone extension
 * fix, which moved `(212) 555-0147;229` off the truncation `5550147229` — can
 * only be repaired in SQL for rows whose metadata still holds every handle the
 * key was chosen from. Migration 20260930020117 could do it for vCard rows and
 * for no Apple Contacts or contact-list row, because only vcard.ts kept them.
 *
 * This pins the contract for all three: the key recomputed from the entity's
 * own `Phones` / `Emails` / `Names` equals the key the importer actually
 * resolves under. A parser that keys on a handle it does not keep fails here.
 *
 * It holds for a card none of whose handles the export marked shared, which is
 * every card in these fixtures. A shared mark (`markSharedContactHandles`: a
 * fax, or a line another person's card lists) is a fact about the export's
 * OTHER cards, so a key that moves because of one is not recomputable from the
 * card alone — which is why staging records the old key beside the new one
 * (`legacy_identity_key`) and the push moves the row (`push/legacyKeys.ts`).
 *
 * One more stated exception, left out of the fixtures on purpose: a Google CSV cell
 * joining two values (`a@example.com ::: b@example.org`) still keys on the
 * joined string, because the attributes keep it whole so that no stored key
 * moves, while the lists hold its values split. That key is stated on the row
 * (`properties.email` / `.phone`); `contactlist.test.ts` pins both halves.
 *
 * Every number is invented (555-01XX).
 */

function entitiesOf(graphs: Graph[]): Entity[] {
  return graphs.flatMap((graph) => [
    ...(graph.entity ? [graph.entity] : []),
    ...(graph.edges ?? []).flatMap((edge) => (edge.to.entity ? [edge.to.entity] : [])),
  ]);
}

function paramsFor(graphs: Graph[]): ImportParams {
  return {
    pipeline: { push: (graph: Graph) => graphs.push(graph), drop: () => undefined },
    timeframe: {},
    log: () => undefined,
  } as unknown as ImportParams;
}

/** The key the push resolves this entity under. */
function stagedKey(entity: Entity): string | null {
  return naturalKeyFor({
    type: resolveEntityType(entity),
    identityKey: entityIdentityKey(entity),
    name: entity.name,
  } as never);
}

/** The same key, rebuilt from nothing but what `ci.entities.properties` will hold. */
function keyFromProperties(entity: Entity): string | null {
  const properties = (entity.metadata ?? {}) as Record<string, unknown>;
  const names = properties.Names;

  return stagedNaturalKey(
    'contact',
    // `entityIdentityKey` over the typed values: the smallest handle the current
    // rule keys (an extension line keys nothing).
    typedHandlesOf(properties).map(normalizeHandle).filter(Boolean).sort()[0] ?? null,
    Array.isArray(names) && typeof names[0] === 'string' ? names[0] : null,
  );
}

function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

async function vcardEntities(): Promise<Entity[]> {
  const raw = [
    // An office line with an extension — Apple escapes the `;` — and an email.
    'BEGIN:VCARD\nVERSION:3.0\nFN:Dana Quill\nTEL;type=WORK:(212) 555-0147\\;229\nEMAIL:dana.quill@example.com\nEND:VCARD',
    // An office line and nothing else: keys on the name.
    'BEGIN:VCARD\nVERSION:3.0\nFN:Rae Holt\nTEL:212-555-0148 x31\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nFN:Sam Ivers\nTEL:+1 (212) 555-0199\nTEL:(202) 555-0142\nEND:VCARD',
    // Handles recovered from the NOTE count: they are identity attributes too.
    'BEGIN:VCARD\nVERSION:3.0\nFN:Noel Park\nNOTE:Emails: noel.park@example.com\\nPhoneNumbers: 202.555.0143\\n\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nEMAIL:nameless@example.com\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nFN:Only A Name\nURL:https://example.invalid/only\nEND:VCARD',
  ].join('\n');

  return withTempDir('ci-recompute-vcf-', async (dir) => {
    const file = path.join(dir, 'contacts.vcf');
    fs.writeFileSync(file, raw);
    const graphs: Graph[] = [];
    await new VCardFileImporter().fileImport(
      {},
      { filename: 'contacts.vcf', fullPath: file },
      paramsFor(graphs),
    );

    return entitiesOf(graphs);
  });
}

async function appleContactsEntities(): Promise<Entity[]> {
  return withTempDir('ci-recompute-abcddb-', async (dir) => {
    const dbPath = path.join(dir, 'AddressBook-v22.abcddb');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT);
      CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
      CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
      CREATE TABLE ZABCDURLADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZURL TEXT);
    `);
    const contacts: Array<[number, string | null, string | null, string[], string[]]> = [
      [1, 'Dana', 'Quill', ['(212) 555-0147;229', '+1 (212) 555-0199'], ['dana.quill@example.com']],
      [2, 'Rae', 'Holt', ['212-555-0148;31'], []],
      [3, 'Sam', 'Ivers', ['(212) 555-0147;229'], ['sam.ivers@example.com', 'sam@example.org']],
      [4, null, null, [], ['nameless@example.com']],
    ];
    for (const [pk, first, last, phones, emails] of contacts) {
      db.prepare('INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME) VALUES (?, ?, ?)').run(
        pk,
        first,
        last,
      );
      for (const phone of phones) {
        db.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)').run(pk, phone);
      }

      for (const email of emails) {
        db.prepare('INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)').run(pk, email);
      }
    }

    db.close();
    const graphs: Graph[] = [];
    await new AppleContactsFileImporter().fileImport(
      {},
      { filename: 'AddressBook-v22.abcddb', fullPath: dbPath },
      paramsFor(graphs),
    );

    return entitiesOf(graphs);
  });
}

async function contactListEntities(): Promise<Entity[]> {
  return withTempDir('ci-recompute-csv-', async (dir) => {
    const file = path.join(dir, 'contacts.csv');
    fs.writeFileSync(
      file,
      [
        'Name,E-mail 1 - Value,E-mail 2 - Value,Phone 1 - Value,Phone 2 - Value',
        'Dana Quill,dana.quill@example.com,,(212) 555-0147 ext. 229,+1 (212) 555-0199',
        'Rae Holt,,,212-555-0148 x31,',
        'Sam Ivers,sam.ivers@example.com,sam@example.org,(212) 555-0147 ext. 229,',
        ',nameless@example.com,,(202) 555-0142,',
      ].join('\n'),
    );
    const graphs: Graph[] = [];
    await new ContactListFileImporter().fileImport({}, { fullPath: file } as never, paramsFor(graphs));

    return entitiesOf(graphs);
  });
}

describe.each([
  ['vcard', vcardEntities],
  ['applecontacts', appleContactsEntities],
  ['contactlist', contactListEntities],
])('%s: the natural key is recomputable from the row’s own properties', (_parser, load) => {
  let entities: Entity[];

  beforeAll(async () => {
    entities = await load();
  });

  it('holds for every card, extension lines included', () => {
    // Not vacuous: the fixture carries cards whose key a truncation used to be.
    expect(entities.length).toBeGreaterThanOrEqual(4);
    expect(
      entities.some((entity) => typedHandlesOf(entity.metadata).some((value) => /;|x\d|ext/.test(value))),
    ).toBe(true);

    for (const entity of entities) {
      expect({ name: entity.name, key: keyFromProperties(entity) }).toEqual({
        name: entity.name,
        key: stagedKey(entity),
      });
    }
  });

  it('declares the typed handles as accumulating, so a second sighting grows them', () => {
    for (const entity of entities) {
      expect(entity.accumulate).toEqual(expect.arrayContaining(['Names', 'Emails', 'Phones']));
    }
  });
});
