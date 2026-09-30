/* Contact List datasource (TypeScript port) */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { markSharedContactHandles } from '../staging/identity';

import { parseCSVRows } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { Entity, EntityAttribute, ImportParams } from './timeline';

type ContactListOptions = Record<string, never>;

// Canonical field keys
const CANON = {
  FULL: 'full_name',
  PREFIX: 'name_prefix',
  FIRST: 'first_name',
  MIDDLE: 'middle_name',
  LAST: 'last_name',
  SUFFIX: 'name_suffix',
  ORGANIZATION: 'organization',
  BIRTH: 'birthdate',
  PICTURE: 'picture',
  EMAIL: 'email',
  PHONE: 'phone',
  GENDER: 'gender',
} as const;

interface FormatDef {
  name: string;
  columns: Record<string, RegExp[]>;
}

/**
 * Outlook's phone columns that hold a number of the contact's own and that this
 * parser did not read before 2026-09: the second business and home lines, and
 * the car and radio phones. A number in one of them was dropped, and a contact
 * with no other handle imported without one, or not at all.
 *
 * Reading them can MOVE a contact's key. A contact keys on its smallest handle,
 * and digits sort before letters, so a contact keyed on its email moves onto
 * any of these numbers, and one keyed on a phone moves when the new number sorts
 * below it. Their attributes are therefore marked `newSinceLegacyKey`: the key
 * the contact's existing row was minted under stays its legacy key, and the
 * push moves that row onto the new key instead of minting a second Person (see
 * `staging/identity.ts legacyEntityIdentityKey`). Only the Outlook dialect reads
 * columns by these names.
 *
 * Left out, deliberately:
 *  - `Assistant's Phone` reaches the assistant, not the contact.
 *  - `Business Fax`, `Home Fax` and `Other Fax` are office equipment, which
 *    must never key a contact.
 *  - `Pager` and `TTY/TDD Phone` often hold a number shared by many people: a
 *    paging service with the contact's PIN written beside it, a relay service.
 *    `ISDN` is a data line more often than a voice one.
 *  - `Callback` is an ordinary word. As an Outlook pattern it would score for
 *    the Outlook dialect on any CSV with a column of that name, such as a sales
 *    list's callback date, and a date has enough digits to read as a phone.
 *  - `Telex` is not a phone number.
 */
const OUTLOOK_PHONES_READ_SINCE_2026_09 = /^((business|home) phone 2|(car|radio) phone)$/i;

// Mirroring Go formats (simplified)
const formats: FormatDef[] = [
  {
    // Google's current export (2023+) has no `Name` column. Its name parts —
    // `First Name`, `Middle Name`, `Last Name`, `Name Prefix`, `Name Suffix`,
    // and `Organization Name` for a business — are borrowed after the dialect
    // is chosen (see NAME_PARTS), not listed here, because listing them here
    // lets this dialect win Outlook exports.
    name: 'Google Contacts',
    columns: {
      [CANON.FULL]: [/^name$/i],
      [CANON.BIRTH]: [/^birthday$/i],
      [CANON.PICTURE]: [/^photo$/i],
      [CANON.GENDER]: [/^gender$/i],
      [CANON.EMAIL]: [/^E-mail \d+ - Value$/i],
      [CANON.PHONE]: [/^Phone \d+ - Value$/i],
    },
  },
  {
    name: 'Outlook / Microsoft Contacts',
    columns: {
      [CANON.FIRST]: [/^first name$/i],
      [CANON.LAST]: [/^last name$/i],
      [CANON.BIRTH]: [/^birthday$/i],
      [CANON.EMAIL]: [/^e-?mail( \d+)? address$/i],
      [CANON.PHONE]: [
        /^(mobile|home|business|other|primary|company main) phone$/i,
        OUTLOOK_PHONES_READ_SINCE_2026_09,
      ],
    },
  },
  {
    name: 'Generic',
    columns: {
      [CANON.FULL]: [/^(name|full name)$/i],
      [CANON.FIRST]: [/^(first name|given name)$/i],
      [CANON.LAST]: [/^(last name|surname|family name|second name)$/i],
      [CANON.BIRTH]: [/^(birthday|birthdate|birth date|date of birth|dob)$/i],
      [CANON.PHONE]: [/^(phone|phone number|phone no|telephone|telephone number|telephone no)$/i],
      [CANON.EMAIL]: [/^(email|email address|electronic mail)$/i],
      [CANON.GENDER]: [/^(gender|sex)$/i],
      [CANON.PICTURE]: [/^(photo|picture|photograph|profile picture|profile photo|avatar)$/i],
    },
  },
];

/**
 * The columns a contact's name is assembled from when the dialect that won the
 * header maps no name column at all.
 *
 * Google's current export (2023+) is why this exists. It has no `Name` column,
 * so the Google dialect, which reads the older export's `Name`, mapped no name,
 * and every row imported nameless. Worse, a nameless row needs two attributes
 * to pass the usefulness filter, so a contact with one email or one phone and
 * nothing else — most of an address book — was dropped outright.
 *
 * The dialects compete on how many fields they map, and a tie goes to the one
 * listed first: Google. An Outlook desktop export has `First Name`, `Middle
 * Name`, `Last Name`, `Birthday` and `Gender`, so a Google dialect carrying
 * these patterns would map five of its fields, tie the Outlook dialect's five,
 * win, and read none of its email or phone columns. Borrowed after the dialect
 * is chosen, they cannot change which one that is.
 *
 * Only a mapping with NO name borrows, so a header whose dialect already reads
 * one — Outlook's `First Name` / `Last Name`, the older Google export's `Name`,
 * any Generic spelling — names its contacts exactly as before. That is about
 * more than display: a contact with no handle of its own is keyed on its name.
 * The older Google spellings (`Given Name`, `Additional Name`, `Family Name`,
 * `Organization 1 - Name`) are here for its variants that omit `Name`.
 *
 * A card with no personal name at all, a business's, is named after its
 * organization, which is what Google shows for it and what the older export's
 * `Name` and a vCard's `FN` hold for it.
 */
const NAME_PARTS: Record<string, RegExp[]> = {
  [CANON.PREFIX]: [/^name prefix$/i],
  [CANON.FIRST]: [/^(first name|given name)$/i],
  [CANON.MIDDLE]: [/^(middle name|additional name)$/i],
  [CANON.LAST]: [/^(last name|family name)$/i],
  [CANON.SUFFIX]: [/^name suffix$/i],
  [CANON.ORGANIZATION]: [/^organization (1 - )?name$/i],
};

/** The fields that make a mapping one that already reads a name. */
const NAME_FIELDS: string[] = [CANON.FULL, CANON.FIRST, CANON.LAST];

/** The parts of a name in reading order, as vcard.ts `nameFromN` joins them. */
const NAME_ORDER: string[] = [CANON.PREFIX, CANON.FIRST, CANON.MIDDLE, CANON.LAST, CANON.SUFFIX];

/**
 * The header's columns under each field `columns` has a pattern for. A column
 * goes to the first field that matches it.
 */
function matchColumns(
  header: readonly string[],
  columns: Record<string, RegExp[]>,
): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  header.forEach((col, idx) => {
    for (const [canon, regexes] of Object.entries(columns)) {
      if (regexes.some((r) => r.test(col))) {
        (result[canon] ||= []).push(idx);
        break;
      }
    }
  });

  return result;
}

function bestColumnMapping(header: string[]): Record<string, number[]> {
  let best: Record<string, number[]> = {};
  for (const fmt of formats) {
    const result = matchColumns(header, fmt.columns);
    if (Object.keys(result).length > Object.keys(best).length) {
      best = result;
    }
  }

  return best;
}

/** `mapping`, plus the header's NAME_PARTS columns when it maps no name. */
function withNameParts(
  header: readonly string[],
  mapping: Record<string, number[]>,
): Record<string, number[]> {
  if (NAME_FIELDS.some((field) => mapping[field])) {
    return mapping;
  }

  return { ...mapping, ...matchColumns(header, NAME_PARTS) };
}

export class ContactListFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    try {
      if ((await stat(full)).isDirectory()) {
        return { confidence: 0 };
      }
    } catch {
      return { confidence: 0 };
    }

    const ext = path.extname(full).toLowerCase();
    if (!['.csv', '.tsv', '.txt'].includes(ext)) {
      return { confidence: 0 };
    }

    // peek first lines to validate structure
    try {
      const raw = await fs.promises.readFile(full, 'utf8');
      const firstLine = raw.split(/\r?\n/)[0];
      const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';
      const header = (parseCSVRows(firstLine, { delimiter: delim })[0] ?? []).map((s) => s.trim());
      if (header.length < 2) {
        return { confidence: 0 };
      }

      const mapping = bestColumnMapping(header);
      if (Object.keys(mapping).length >= 2) {
        return { confidence: 1 };
      }
    } catch {
      /* ignore */
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(full, 'utf8');
    } catch {
      return;
    }

    const firstLine = raw.split(/\r?\n/)[0] ?? '';
    const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';
    const rows = parseCSVRows(raw, { delimiter: delim }).filter((r) => r.some((v) => v.trim() !== ''));
    if (rows.length === 0) {
      return;
    }

    const header = rows[0].map((s) => s.trim());
    const mapping = bestColumnMapping(header);
    if (Object.keys(mapping).length < 2) {
      return;
    } // insufficient mapping

    const columns = withNameParts(header, mapping);

    // Emitted together after the last row: an Outlook export's "Company Main
    // Phone" column puts one switchboard on every colleague's row, and only the
    // whole file shows that — see markSharedContactHandles.
    const contacts: Entity[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length !== header.length) {
        params.pipeline.drop?.('malformed_row', `row ${i}`);
        continue;
      } // skip malformed

      const vals: Record<string, string[]> = {};
      for (const [canon, idxs] of Object.entries(columns)) {
        for (const idx of idxs) {
          const v = row[idx]?.trim();
          if (v) {
            (vals[canon] ||= []).push(v);
          }
        }
      }

      // build entity. A dialect that maps a name maps only FULL, FIRST and
      // LAST, so its contacts are named "First Last" exactly as before; the
      // other parts are only ever borrowed (see NAME_PARTS).
      let name = vals[CANON.FULL]?.[0] || '';
      if (!name) {
        name = NAME_ORDER.map((part) => vals[part]?.[0])
          .filter(Boolean)
          .join(' ');
      }

      if (!name) {
        name = vals[CANON.ORGANIZATION]?.[0] || '';
      }

      const attributes: EntityAttribute[] = [];
      (vals[CANON.EMAIL] || []).forEach((v) => attributes.push({ name: 'email', value: v, identity: true }));
      // Per column rather than from `vals`: which column a number came from
      // decides whether it is new since the legacy key.
      for (const idx of columns[CANON.PHONE] ?? []) {
        const v = row[idx]?.trim();
        if (v) {
          attributes.push({
            name: 'phone',
            value: v,
            identity: true,
            ...(OUTLOOK_PHONES_READ_SINCE_2026_09.test(header[idx]) ? { newSinceLegacyKey: true } : {}),
          });
        }
      }

      if (vals[CANON.BIRTH]?.[0]) {
        attributes.push({ name: 'birth_date', value: vals[CANON.BIRTH][0] });
      }

      if (vals[CANON.GENDER]?.[0]) {
        attributes.push({ name: 'gender', value: vals[CANON.GENDER][0] });
      }

      // A Google/Outlook contact's Photo column is a hosted URL (contacts.google.com
      // or similar), not embedded bytes, so — unlike vcard.ts's base64 PHOTO — this
      // needs no decode/upload step: just a sanity check that it is actually an
      // http(s) URL before handing it to <img src>.
      const pictureUrl = vals[CANON.PICTURE]?.[0];
      const avatarUrl = pictureUrl && /^https?:\/\//i.test(pictureUrl) ? pictureUrl : undefined;

      // minimal usefulness filter: at least 2 attributes or one attribute + name
      if (attributes.length < 2 && !(name && attributes.length === 1)) {
        params.pipeline.drop?.('insufficient_attributes', `row ${i}`);
        continue;
      }

      contacts.push({
        name,
        // `type` is declared for the same reason as in vcard.ts: a contact-list row
        // is a contact even when it carries no phone or email for
        // `hasContactIdentity` to find.
        type: 'contact',
        attributes,
        metadata: {
          Source: 'ContactList',
          File: path.basename(full),
          // Lowercase, unlike the other keys here: this exact key is the contract
          // `push/entities.ts` spreads straight into `ci.entities.properties`, and
          // `PersonType.avatarUrl` (backend/.../types/PersonType.ts) reads it back
          // as `properties.avatar_url`.
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        },
      });
    }

    for (const entity of markSharedContactHandles(contacts)) {
      params.pipeline.push({ entity });
    }
  }
}

registerDataSource({
  name: 'contact_list',
  title: 'Contact List',
  icon: 'contact_list.svg',
  description: 'CSV/TSV contact lists (Google Contacts & generic)',
  newOptions: () => ({}) as ContactListOptions,
  newFileImporter: () => new ContactListFileImporter(),
});
