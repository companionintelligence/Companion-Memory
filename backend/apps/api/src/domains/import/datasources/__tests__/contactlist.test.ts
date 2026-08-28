import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ContactListFileImporter } from '../contactlist';
import type { DirEntry } from '../registry';
import type { EntityAttribute, Graph, ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

function makeParams() {
  const collected: EmittedGraph[] = [];

  return {
    params: { timeframe: undefined, pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) } },
    collected,
  };
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
});
