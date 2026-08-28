/* Apple Contacts datasource (simplified TypeScript port) */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { EntityAttribute, ImportParams } from './timeline';

type AppleContactsOptions = Record<string, never>;

const ADDRESS_BOOK_DB = 'AddressBook-v22.abcddb';

/**
 * A synced macOS profile keeps ONE database per connected account (iCloud,
 * Exchange, a Google/CardDAV account, ...) under `Sources/<account-id>/`,
 * alongside a top-level `AddressBook-v22.abcddb` that in practice holds only
 * whatever wasn't assigned to a synced account — 3 contacts in a profile
 * whose real 37,797 contacts sit entirely under `Sources/`. Neither
 * recognize() nor fileImport() looked past the top-level file, so every
 * synced contact was invisible to this importer.
 */
const SOURCES_DIR = 'Sources';

/** `Sources/<account-id>/AddressBook-v22.abcddb` paths under `root`, if any. */
function findSourceDbs(root: string): string[] {
  const sourcesDir = path.join(root, SOURCES_DIR);
  let accountDirs: fs.Dirent[];
  try {
    accountDirs = fs.readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of accountDirs) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dbPath = path.join(sourcesDir, entry.name, ADDRESS_BOOK_DB);
    if (fs.existsSync(dbPath)) {
      out.push(dbPath);
    }
  }

  return out;
}

/**
 * The AddressBook columns this importer reads. Every field is optional: the
 * SELECT list is assembled from PRAGMA table_info at runtime, because the
 * schema differs across macOS releases, and the phone/email/url columns come
 * from LEFT JOINs that are null for a contact lacking them.
 */
interface ContactRow {
  Z_PK?: number;
  ZFIRSTNAME?: string | null;
  ZMIDDLENAME?: string | null;
  ZMAIDENNAME?: string | null;
  ZLASTNAME?: string | null;
  ZBIRTHDAY?: number | null;
  ZBIRTHDAYYEAR?: number | null;
  ZBIRTHDAYYEARLESS?: number | null;
  ZFULLNUMBER?: string | null;
  ZADDRESS?: string | null;
  ZURL?: string | null;
}

/** One row of `PRAGMA table_info(...)`. */
interface PragmaColumnRow {
  name: string;
}

/** One contact accumulated across its joined phone/email/url rows. */
interface ContactAccumulator {
  id?: number;
  phones: string[];
  emails: string[];
  urls: string[];
  nameParts: (string | null | undefined)[];
  bday?: number | null;
  bdayYear?: number | null;
  bdayYearless?: number | null;
}

export class AppleContactsFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    const base = path.basename(full);
    let st: fs.Stats;
    try {
      st = await stat(full);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile() && base === ADDRESS_BOOK_DB) {
      return { confidence: 1.0 };
    }

    if (st.isDirectory()) {
      const dbPath = path.join(full, ADDRESS_BOOK_DB);
      try {
        await stat(dbPath);

        return { confidence: 0.9, dir_threshold: 0.5 };
      } catch {
        /* no top-level AddressBook db - a synced profile may still have one
         * per account under Sources/, checked below. */
      }

      if (findSourceDbs(full).length > 0) {
        return { confidence: 0.9, dir_threshold: 0.5 };
      }
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const start = entry.fullPath || entry.fsRoot || entry.filename;
    if (!start) {
      return;
    }

    const stat = fs.statSync(start);
    if (stat.isDirectory()) {
      const dbPath = path.join(start, ADDRESS_BOOK_DB);
      if (fs.existsSync(dbPath)) {
        await this.processDB(dbPath, params);
      }

      // Each per-account database is independent: one account's corrupt or
      // unreadable db must not stop the others (processDB isolates its own
      // errors per call already).
      for (const sourceDb of findSourceDbs(start)) {
        await this.processDB(sourceDb, params);
      }

      return;
    }

    if (path.basename(start) === ADDRESS_BOOK_DB) {
      await this.processDB(start, params);
    }
  }

  private processDB(dbPath: string, params: ImportParams): void {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch (e) {
      params.log?.('error', 'open contacts db failed', { error: (e as Error).message });

      return;
    }

    // minimal column subset; dynamic detection omitted for simplicity
    const cols: string[] = [];
    try {
      const pragma = db.prepare("PRAGMA table_info('ZABCDRECORD')");
      for (const row of pragma.iterate() as IterableIterator<PragmaColumnRow>) {
        cols.push(row.name);
      }
    } catch {
      /* ignore */
    }

    const sel: string[] = [];
    const want = [
      'Z_PK',
      'ZFIRSTNAME',
      'ZMIDDLENAME',
      'ZMAIDENNAME',
      'ZLASTNAME',
      'ZBIRTHDAY',
      'ZBIRTHDAYYEAR',
      'ZBIRTHDAYYEARLESS',
    ];
    for (const w of want) {
      if (cols.includes(w)) {
        sel.push(w === 'ZBIRTHDAY' ? 'cast(rec.ZBIRTHDAY AS INTEGER) AS ZBIRTHDAY' : `rec.${w}`);
      }
    }

    const query = `SELECT ${sel.join(',')}, phone.ZFULLNUMBER, email.ZADDRESS, web.ZURL FROM ZABCDRECORD rec
      LEFT JOIN ZABCDPHONENUMBER phone ON phone.ZOWNER = rec.Z_PK
      LEFT JOIN ZABCDEMAILADDRESS email ON email.ZOWNER = rec.Z_PK
      LEFT JOIN ZABCDURLADDRESS web ON web.ZOWNER = rec.Z_PK
      ORDER BY rec.Z_PK ASC`;
    try {
      let currentId: number | undefined;
      let current: ContactAccumulator = { phones: [], emails: [], urls: [], nameParts: [] };
      for (const row of db.prepare(query).iterate() as IterableIterator<ContactRow>) {
        if (row.Z_PK !== currentId) {
          this.flushEntity(currentId, current, params, dbPath);
          currentId = row.Z_PK;
          current = {
            id: row.Z_PK,
            phones: [],
            emails: [],
            urls: [],
            nameParts: [row.ZFIRSTNAME, row.ZMIDDLENAME, row.ZMAIDENNAME, row.ZLASTNAME],
            bday: row.ZBIRTHDAY,
            bdayYear: row.ZBIRTHDAYYEAR,
            bdayYearless: row.ZBIRTHDAYYEARLESS,
          };
        }

        if (row.ZFULLNUMBER) {
          current.phones.push(row.ZFULLNUMBER);
        }

        if (row.ZADDRESS) {
          current.emails.push(row.ZADDRESS);
        }

        if (row.ZURL) {
          current.urls.push(row.ZURL);
        }
      }

      this.flushEntity(currentId, current, params, dbPath);
    } catch (e) {
      params.log?.('error', 'contacts query failed', { error: (e as Error).message });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  private flushEntity(id: number | undefined, c: ContactAccumulator, params: ImportParams, dbPath: string) {
    if (!id) {
      return;
    }

    const name = c.nameParts
      ?.filter((p): p is string => !!p)
      .join(' ')
      .trim();
    const attributes: EntityAttribute[] = [];
    for (const p of c.phones) {
      attributes.push({ name: 'phone', value: p, identity: true });
    }

    for (const e of c.emails) {
      attributes.push({ name: 'email', value: e, identity: true });
    }

    for (const u of c.urls) {
      attributes.push({ name: 'url', value: u });
    }

    if (typeof c.bday === 'number' && c.bday > -1e9) {
      const appleEpoch = new Date('2001-01-01T00:00:00Z').getTime();
      const ts = new Date(appleEpoch + c.bday * 1000);
      attributes.push({ name: 'birth_date', value: ts.toISOString() });
    }

    if (!name && attributes.length === 0) {
      return;
    }

    // Which database this contact came from — the top-level AddressBook, or
    // one synced account's own copy under Sources/<account-id>/ — since a
    // profile can hold several and DB used to always report the same
    // constant string regardless of which one was actually read.
    const accountId =
      path.basename(path.dirname(path.dirname(dbPath))) === SOURCES_DIR
        ? path.basename(path.dirname(dbPath))
        : undefined;

    params.pipeline.push({
      // See vcard.ts: an Address Book card is a contact regardless of which
      // optional fields it happens to fill.
      entity: {
        name,
        type: 'contact',
        attributes,
        metadata: {
          Source: 'AppleContacts',
          DB: path.basename(dbPath),
          ...(accountId ? { AccountID: accountId } : {}),
        },
      },
    });
  }
}

registerDataSource({
  name: 'apple_contacts',
  title: 'Apple Contacts',
  icon: 'apple_contacts.png',
  description: 'Apple AddressBook-v22.abcddb contacts database',
  newOptions: () => ({}) as AppleContactsOptions,
  newFileImporter: () => new AppleContactsFileImporter(),
});
