import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { entityTypeFor, naturalKeyFor } from '../../push/entities';
import {
  contactIdentifiers,
  entityIdentityKey,
  FAX_ATTRIBUTE_NAME,
  legacyEntityIdentityKey,
  resolveEntityType,
} from '../../staging/identity';
import type { Entity, EntityAttribute, ImportParams } from '../timeline';
import {
  VCardFileImporter,
  buildContact,
  decodeQuotedPrintable,
  faxNumbersOf,
  parseContentLine,
  unfoldContentLines,
  type ContentLine,
} from '../vcard';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Build a fresh drop-counting pipeline, matching the gmail_drops.test.ts pattern. */
function makeDropPipeline(): {
  pipeline: EmittedGraph[];
  drops: Record<string, number>;
  params: ImportParams;
} {
  const pipeline: EmittedGraph[] = [];
  const drops: Record<string, number> = {};
  const params = {
    pipeline: {
      push: (g: EmittedGraph) => pipeline.push(g),
      drop: (reason: string) => {
        drops[reason] = (drops[reason] ?? 0) + 1;
      },
    },
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams;

  return { pipeline, drops, params };
}

async function importRaw(raw: string, filename = 'card.vcf') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vcf-'));
  const fpath = path.join(dir, filename);
  fs.writeFileSync(fpath, raw);
  const { pipeline, drops, params } = makeDropPipeline();
  try {
    await new VCardFileImporter().fileImport({}, { filename, fullPath: fpath }, params);

    return { pipeline, drops };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Parse a fixture's unfolded lines into ContentLine[], skipping BEGIN/END/blank. */
function contentLines(raw: string): ContentLine[] {
  const out: ContentLine[] = [];
  for (const line of unfoldContentLines(raw)) {
    const trimmed = line.trim();
    if (!trimmed || /^(BEGIN|END):VCARD$/i.test(trimmed)) {
      continue;
    }

    const parsed = parseContentLine(line);
    if (parsed) {
      out.push(parsed);
    }
  }

  return out;
}

/**
 * A contact is emitted as an ITEM carrying a `contact` edge to its entity, not
 * as a bare entity. That is the shape the upstream rewrite settled on and it is
 * load-bearing: the item is what gives a card a stable id to dedup a re-import
 * against, and the edge is what lets a contact resolve to a person. The old
 * entity-only emission is precisely what made 5,250 contacts import as zero
 * items.
 */
function contactEntities(emitted: EmittedGraph[]) {
  return emitted.flatMap((graph) =>
    (graph.edges ?? [])
      .filter((edge) => edge.relation === 'contact')
      .map((edge) => edge.to?.entity)
      .filter(Boolean),
  );
}

describe('vCard datasource', () => {
  it('recognizes .vcf file', async () => {
    const vcfPath = path.join(FIXTURES_DIR, 'sample.vcf');
    const fi = new VCardFileImporter();
    const rec = await fi.recognize({}, { filename: 'sample.vcf', fullPath: vcfPath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports vCard contacts', async () => {
    const vcfPath = path.join(FIXTURES_DIR, 'sample.vcf');
    const fi = new VCardFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'sample.vcf', fullPath: vcfPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const entities = contactEntities(pipeline);
    expect(entities.length).toBe(2);
    expect(entities[0]!.name).toBe('John Doe');
    expect(entities[0]!.metadata?.Source).toBe('vCard');
    expect(entities[0]!.attributes).toBeDefined();

    // Every card is now an item too — the half that was missing before.
    expect(pipeline.filter((p) => p.item).length).toBe(2);
  });

  it('unescapes RFC 6350 TEXT backslash sequences in NOTE (and other TEXT fields)', async () => {
    // Real Apple Contacts export: 2271/2285 (99.4%) of NOTE attributes
    // carried literal \, / \; / \n sequences that were never decoded to
    // real punctuation/newlines before being stored.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vcf-unescape-'));
    const vcfPath = path.join(dir, 'escaped.vcf');
    fs.writeFileSync(
      vcfPath,
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Jane\\, Q. Public',
        'N:Public;Jane;Q.;;',
        'TEL;TYPE=HOME:+1-555-123-4567',
        'EMAIL;TYPE=INTERNET:jane@example.com',
        'NICKNAME:J.Q.\\; The Second',
        'NOTE:Met at conf\\, Chicago\\; follow up\\nSent contract\\\\draft',
        'END:VCARD',
      ].join('\r\n'),
    );
    try {
      const fi = new VCardFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'escaped.vcf', fullPath: vcfPath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      const [entity] = contactEntities(pipeline);
      expect(entity!.name).toBe('Jane, Q. Public');
      const nickname = entity!.attributes!.find((a: EntityAttribute) => a.name === 'nickname');
      expect(nickname!.value).toBe('J.Q.; The Second');
      const note = entity!.attributes!.find((a: EntityAttribute) => a.name === 'note');
      expect(note!.value).toBe('Met at conf, Chicago; follow up\nSent contract\\draft');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Attribute shape with the vCard-specific `label`/`pref` extras that ride
 * alongside the base `EntityAttribute` (see ContactAttribute in ../vcard).
 * Not exported from the production module, so mirrored here for assertions.
 */
interface LabelledAttribute extends EntityAttribute {
  label?: string;
  pref?: boolean;
}

describe('unfoldContentLines (RFC 6350 §3.2 unfolding)', () => {
  it('reconstructs the original content byte-for-byte across a standard CRLF+SPACE fold', () => {
    // Fold at an arbitrary interior position: real exporters wrap at a byte
    // count, not a word boundary, mid-word included.
    const original =
      'NOTE:Line one of a very long note that must be fold' +
      'ed across the wire to stay under a line-length limit.';
    const at = original.indexOf('fold') + 'fold'.length; // mid-word, right after "fold"
    const folded = original.slice(0, at) + '\r\n ' + original.slice(at);

    expect(unfoldContentLines(folded)).toEqual([original]);
  });

  it('does not lose the fold when it lands on an existing word boundary', () => {
    const original = 'NOTE:first segment second segment third segment';
    const at = original.indexOf(' second'); // fold right before a real space
    const folded = original.slice(0, at) + '\r\n ' + original.slice(at);

    expect(unfoldContentLines(folded)).toEqual([original]);
  });

  it('joins a vCard 2.1 QUOTED-PRINTABLE soft break (trailing "=", no leading whitespace)', () => {
    const raw = ['NOTE;ENCODING=QUOTED-PRINTABLE:one=', 'two'].join('\r\n');
    expect(unfoldContentLines(raw)).toEqual(['NOTE;ENCODING=QUOTED-PRINTABLE:onetwo']);
  });

  it('does not treat a trailing "=" as a QP soft break unless ENCODING=QUOTED-PRINTABLE is present', () => {
    // A URL that happens to end in an unrelated "=" (e.g. a query string) must
    // not swallow the next, unrelated property line.
    const raw = ['URL:https://example.com/x=', 'TEL:+15551234567'].join('\r\n');
    expect(unfoldContentLines(raw)).toEqual(['URL:https://example.com/x=', 'TEL:+15551234567']);
  });

  it('discards rather than joins the folded continuation of a binary (base64) property', () => {
    // PHOTO is most of an Apple export's bytes; a folded continuation must be
    // dropped, never appended, or a large address book is held twice in memory.
    const raw = ['PHOTO;ENCODING=b;TYPE=JPEG:AAAA', ' BBBB', ' CCCC', 'FN:Next Person'].join('\r\n');
    const lines = unfoldContentLines(raw);
    expect(lines).toEqual(['PHOTO;ENCODING=b;TYPE=JPEG:AAAA', 'FN:Next Person']);
    expect(lines.join('')).not.toContain('BBBB');
  });
});

describe('parseContentLine (grouped [group.]NAME[;params]:value tokenizer)', () => {
  it('splits an itemN. property group from the property name', () => {
    const parsed = parseContentLine('item1.EMAIL;type=INTERNET:someone@example.com');
    expect(parsed).toEqual({
      group: 'ITEM1',
      name: 'EMAIL',
      params: { TYPE: ['INTERNET'] },
      value: 'someone@example.com',
      binary: false,
    });
  });

  it('rejects a fold-leftover text fragment instead of treating it as a bogus property', () => {
    // This is the exact old-regex failure: a NOTE's folded continuation that
    // never got joined ("Connected On: 09 May 2014") was accepted as its own
    // property because the old regex didn't validate the name token.
    expect(parseContentLine('Connected On: 09 May 2014')).toBeNull();
  });

  it('ignores a parameter-value separator inside double quotes', () => {
    const parsed = parseContentLine('NOTE;X-INFO="a;b":Hello');
    expect(parsed?.params['X-INFO']).toEqual(['a;b']);
    expect(parsed?.value).toBe('Hello');
  });

  it('returns null for a line with no unquoted colon', () => {
    expect(parseContentLine('not a content line at all')).toBeNull();
  });
});

describe('grouped X-ABLabel resolution (labelFor, exercised via buildContact)', () => {
  it('attaches the group label whether X-ABLabel appears before or after the labelled property', () => {
    const raw = [
      'FN:Test Person',
      // item1: label AFTER the property it describes.
      'item1.EMAIL;type=INTERNET:school@example.com',
      'item1.X-ABLabel:_$!<School>!$_',
      // item2: label BEFORE the property it describes.
      'item2.X-ABLabel:_$!<Assistant>!$_',
      'item2.TEL;type=CELL:+15550001111',
      // Ungrouped property: no label to inherit.
      'EMAIL;type=INTERNET:plain@example.com',
    ].join('\r\n');

    const built = buildContact(contentLines(raw), 'labels.vcf');
    expect(built).not.toBeNull();
    const attrs = (built!.entity.attributes ?? []) as LabelledAttribute[];

    const schoolEmail = attrs.find((a) => a.name === 'email' && a.value === 'school@example.com');
    expect(schoolEmail?.label).toBe('School');

    const assistantPhone = attrs.find((a) => a.name === 'phone' && a.value === '+15550001111');
    expect(assistantPhone?.label).toBe('Assistant');

    // Ungrouped EMAIL;type=INTERNET must not fall back to "INTERNET" as a
    // label — INTERNET is a transport marker, not a human label.
    const plainEmail = attrs.find((a) => a.name === 'email' && a.value === 'plain@example.com');
    expect(plainEmail?.label).toBeUndefined();
  });
});

describe('decodeQuotedPrintable (RFC 2045 §6.7 + CHARSET)', () => {
  it('decodes a single-byte CHARSET (ISO-8859-1) hex escape to the right character', () => {
    expect(decodeQuotedPrintable('caf=E9', 'iso-8859-1')).toBe('café');
  });

  it('decodes a UTF-8 multi-byte hex escape', () => {
    expect(decodeQuotedPrintable('caf=C3=A9', 'utf-8')).toBe('café');
  });

  it('falls back to utf-8 for an unrecognized charset name rather than throwing', () => {
    expect(decodeQuotedPrintable('caf=C3=A9', 'x-mystery-charset')).toBe('café');
  });

  it('decodes CHARSET/QUOTED-PRINTABLE end-to-end through parseContentLine', () => {
    const parsed = parseContentLine('NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:caf=E9 au coin');
    expect(parsed?.binary).toBe(false);
    expect(parsed?.value).toBe('café au coin');
  });

  it('marks an ENCODING=b/BASE64 value binary and empty, never retaining the blob', () => {
    const parsed = parseContentLine('PHOTO;ENCODING=b;TYPE=JPEG:AAAABBBBCCCC==');
    expect(parsed?.binary).toBe(true);
    expect(parsed?.value).toBe('');
  });
});

describe('contactId (UID-vs-hash dedup stability)', () => {
  const line = (s: string) => parseContentLine(s)!;

  it('is idempotent for the same content on re-import (no UID)', () => {
    const lines = [line('FN:Bob NoUid'), line('TEL:+15551110000')];
    const first = buildContact(lines, 'contacts.vcf')!;
    const second = buildContact(lines, 'contacts.vcf')!;
    expect(first.item.id).toBe(second.item.id);
  });

  it('changes id when card content changes and there is no UID', () => {
    const v1 = buildContact([line('FN:Bob NoUid'), line('TEL:+15551110000')], 'contacts.vcf')!;
    const v2 = buildContact([line('FN:Bob NoUid'), line('TEL:+15559998888')], 'contacts.vcf')!;
    expect(v1.item.id).not.toBe(v2.item.id);
  });

  it('keeps the id stable across a content edit when the card carries a UID', () => {
    // A card with a UID identifies itself by UID+file, not by content — so
    // editing a field between two exports of the same file still dedups to
    // one row instead of filing a duplicate contact.
    const v1 = buildContact(
      [line('FN:Alice'), line('UID:abc-123'), line('TEL:+15551110000')],
      'contacts.vcf',
    )!;
    const v2 = buildContact(
      [line('FN:Alice'), line('UID:abc-123'), line('TEL:+15559998888')],
      'contacts.vcf',
    )!;
    expect(v1.item.id).toBe(v2.item.id);
  });

  it('still separates the same UID seen in two different export files', () => {
    // Google Takeout's per-label exports legitimately repeat one person's UID
    // across several files as several distinct cards.
    const inFileA = buildContact([line('FN:Alice'), line('UID:abc-123')], 'contacts-a.vcf')!;
    const inFileB = buildContact([line('FN:Alice'), line('UID:abc-123')], 'contacts-b.vcf')!;
    expect(inFileA.item.id).not.toBe(inFileB.item.id);
  });
});

describe('drop ledger accounting', () => {
  it('drops a card truncated at end-of-file with no END:VCARD', async () => {
    const { pipeline, drops } = await importRaw('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Truncated Person\r\n');
    expect(drops).toEqual({ no_end_marker: 1 });
    expect(pipeline.length).toBe(0);
  });

  it('drops a card truncated by a second BEGIN:VCARD, then imports the one that follows', async () => {
    const raw = ['BEGIN:VCARD', 'FN:First (truncated)', 'BEGIN:VCARD', 'FN:Second', 'END:VCARD', ''].join(
      '\r\n',
    );
    const { pipeline, drops } = await importRaw(raw);
    expect(drops).toEqual({ no_end_marker: 1 });
    const entities = contactEntities(pipeline);
    expect(entities.length).toBe(1);
    expect(entities[0]!.name).toBe('Second');
  });

  it('drops a card with neither a name nor any usable attribute', async () => {
    const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Test//EN', 'END:VCARD', ''].join('\r\n');
    const { pipeline, drops } = await importRaw(raw);
    expect(drops).toEqual({ empty_card: 1 });
    expect(pipeline.length).toBe(0);
  });

  it('drops a file it cannot read and records the reason, instead of throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vcf-unreadable-'));
    const fpath = path.join(dir, 'broken.vcf');
    fs.writeFileSync(fpath, 'BEGIN:VCARD\r\nFN:Doesnt Matter\r\nEND:VCARD\r\n');
    const spy = jest
      .spyOn(fs.promises, 'readFile')
      .mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const { pipeline, drops, params } = makeDropPipeline();
    try {
      await new VCardFileImporter().fileImport({}, { filename: 'broken.vcf', fullPath: fpath }, params);
      expect(drops).toEqual({ unreadable_file: 1 });
      expect(pipeline.length).toBe(0);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The Android/LinkedIn merge shape. Verbatim from the developer's Apple export
 * (4,927 cards): the sync wrote the source record into NOTE as free text
 * instead of into properties, so 682 cards carry an email ONLY there, 369 a
 * phone — and one card carries nothing else whatsoever. That card is why every
 * import of this archive finished `partial`: no FN, `N:;;;;`, one NOTE, so no
 * name and no handle for PushStage to resolve by.
 */
describe('handles recovered from a NOTE-embedded export record', () => {
  it('recovers the email from a card whose only content is a note (the `partial` card)', async () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PRODID:-//Apple Inc.//macOS 26.5.1//EN',
      'N:;;;;',
      'NOTE:Source: ANDROID_CALENDAR\\nEmails: inversin@d2.com\\nCreatedAt: 2/10/20\\, 6:40 PM\\n',
      'END:VCARD',
      '',
    ].join('\r\n');

    const { pipeline, drops } = await importRaw(raw, 'android.vcf');

    expect(drops).toEqual({});
    const [entity] = contactEntities(pipeline);
    expect(entity).toBeDefined();
    // The point of the whole exercise: an identity attribute, which is what
    // staging/identity.ts turns into `staged_entities.identity_key` and what
    // PushStage keys the graph entity on. Without it this card is skipped with
    // 'no stable name or handle to resolve by'.
    expect(entity!.attributes).toEqual(
      expect.arrayContaining([{ name: 'email', value: 'inversin@d2.com', identity: true }]),
    );
    expect(entity!.metadata?.Emails).toEqual(['inversin@d2.com']);
  });

  it('recovers a comma-separated email list and a phone from one note', async () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Mary Ahern',
      'NOTE:Source: MOBILE_CONTACTS\\nCompanies: null\\nEmails: GAceti@example.com\\, gaceti@example.com',
      ' \\nPhoneNumbers: 443-808-1500\\nCreatedAt: 9/19/15\\, 8:55 AM\\n',
      'END:VCARD',
      '',
    ].join('\r\n');

    const { pipeline } = await importRaw(raw, 'mary.vcf');
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.Emails).toEqual(['GAceti@example.com', 'gaceti@example.com']);
    expect(entity!.metadata?.Phones).toEqual(['443-808-1500']);
  });

  it('leaves the structured properties alone when the card has them', () => {
    // Fallback, not augmentation: the note is a historical record of another
    // address book, the property list is what this card currently states.
    const contact = buildContact(
      contentLines(
        [
          'BEGIN:VCARD',
          'FN:Teo Acosta',
          'EMAIL;type=INTERNET:teo@current.example',
          'NOTE:Source: MOBILE_CONTACTS\\nEmails: teo@stale.example\\nPhoneNumbers: 518.641.2094\\n',
          'END:VCARD',
        ].join('\r\n'),
      ),
      'teo.vcf',
    );

    expect(contact!.entity.metadata?.Emails).toEqual(['teo@current.example']);
    // Per KIND, though — the card states no TEL, so the note's phone is still
    // the only one there is and is recovered.
    expect(contact!.entity.metadata?.Phones).toEqual(['518.641.2094']);
  });

  it('ignores note values that are not handles', () => {
    // `Companies: null` proves the export writes the literal string for an
    // absent field, and a short number is not a phone the identity layer can
    // normalize (staging/identity.ts stops at seven digits).
    const contact = buildContact(
      contentLines(
        [
          'BEGIN:VCARD',
          'FN:Nobody Useful',
          'NOTE:Source: MOBILE_CONTACTS\\nCompanies: null\\nEmails: null\\nPhoneNumbers: 411\\n',
          'END:VCARD',
        ].join('\r\n'),
      ),
      'nobody.vcf',
    );

    expect(contact!.entity.metadata?.Emails).toBeUndefined();
    expect(contact!.entity.metadata?.Phones).toBeUndefined();
    expect(contact!.entity.attributes?.some((a) => a.identity)).toBe(false);
  });

  it('does not mistake prose that merely mentions email for a handle', () => {
    const contact = buildContact(
      contentLines(
        ['BEGIN:VCARD', 'FN:Chatty Note', 'NOTE:Email me before you call.', 'END:VCARD'].join('\r\n'),
      ),
      'chatty.vcf',
    );

    expect(contact!.entity.metadata?.Emails).toBeUndefined();
    expect(contact!.entity.attributes?.some((a) => a.identity)).toBe(false);
  });
});

describe('fax numbers are filed apart from the person’s lines', () => {
  // Invented: an office in the 212 fiction range — main line 555-0110 (this
  // colleague at extension 229), fax 555-0118. The shape is a real export's:
  // every card from one office lists the office fax, and filed among `Phones`
  // it made two colleagues "the same phone number" to the duplicate detector.
  const office = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Quill;Ada;;;',
    'FN:Ada Quill',
    'TEL;type=pref:(212) 555-0110\\;229',
    'TEL;type=OTHER;type=FAX:(212) 555-0118',
    'END:VCARD',
  ].join('\r\n');

  it('files a TYPE=FAX number under Faxes, not Phones', () => {
    const contact = buildContact(contentLines(office), 'office.vcf');

    expect(contact!.entity.metadata?.Phones).toEqual(['(212) 555-0110;229']);
    expect(contact!.entity.metadata?.Faxes).toEqual(['(212) 555-0118']);
    expect(contact!.item.metadata?.Faxes).toEqual(['(212) 555-0118']);
    expect(contact!.entity.accumulate).toContain('Faxes');
  });

  it('keeps the fax an identity attribute, so no natural key moves', () => {
    // The key is the card's smallest handle, and here that is the FAX: the
    // extension line truncates to 5550110229. Filing the fax apart must not
    // change it — a key that moves on re-import mints a duplicate contact.
    const contact = buildContact(contentLines(office), 'office.vcf');

    expect(contact!.entity.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: FAX_ATTRIBUTE_NAME, value: '(212) 555-0118', identity: true }),
      ]),
    );
    expect(entityIdentityKey(contact!.entity)).toBe('2125550118');
  });

  it('gives staging no line of the colleague’s own to index: the fax is office equipment, the extension no number', () => {
    const contact = buildContact(contentLines(office), 'office.vcf');

    expect(contactIdentifiers(contact!.entity)).toEqual({ emails: [], phones: [] });
  });

  it.each([
    ['an Apple built-in label', ['item1.TEL:(212) 555-0118', 'item1.X-ABLabel:_$!<WorkFAX>!$_']],
    ['a vCard 2.1 bare type', ['TEL;WORK;FAX:(212) 555-0118']],
    ['a comma-joined TYPE', ['TEL;TYPE="work,fax":(212) 555-0118']],
  ])('recognises a fax written with %s', (_label, lines) => {
    const contact = buildContact(
      contentLines(['BEGIN:VCARD', 'FN:Ada Quill', ...lines, 'END:VCARD'].join('\r\n')),
      'fax.vcf',
    );

    expect(contact!.entity.metadata?.Faxes).toEqual(['(212) 555-0118']);
    expect(contact!.entity.metadata?.Phones).toBeUndefined();
  });

  it('does not recover note phones onto a card whose only TEL is a fax', () => {
    // Before faxes were filed apart, the fax sat in `phones` and the note
    // fallback did not run. It still must not: recovered phones are identity
    // attributes, and adding one would move the card's natural key.
    const contact = buildContact(
      contentLines(
        [
          'BEGIN:VCARD',
          'FN:Ada Quill',
          'TEL;type=FAX:(212) 555-0118',
          'NOTE:Source: MOBILE_CONTACTS\\nPhoneNumbers: 202-555-0142\\n',
          'END:VCARD',
        ].join('\r\n'),
      ),
      'fax-only.vcf',
    );

    expect(contact!.entity.metadata?.Phones).toBeUndefined();
    expect(contact!.entity.metadata?.Faxes).toEqual(['(212) 555-0118']);
    expect(entityIdentityKey(contact!.entity)).toBe('2125550118');
  });
});

describe('full pipeline: grouped labels + folded NOTE + QUOTED-PRINTABLE ORG together', () => {
  it('imports a realistic Apple-style card intact end to end', async () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Dupont;Marie;;;',
      'FN:Marie Dupont',
      'item1.EMAIL;type=INTERNET:marie@example.com',
      'item1.X-ABLabel:_$!<School>!$_',
      'item2.URL;type=pref:https://example.com/marie',
      'item2.X-ABLabel:_$!<Homepage>!$_',
      'ORG;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:Caf=E9 Cr=E9atif',
      'NOTE:Line one of a very long note that must be fold',
      ' ed across the wire to stay under a line-length limit.',
      'END:VCARD',
      '',
    ].join('\r\n');

    const { pipeline, drops } = await importRaw(raw, 'marie.vcf');

    expect(drops).toEqual({});
    const entities = contactEntities(pipeline);
    expect(entities.length).toBe(1);
    const [entity] = entities;
    expect(entity!.name).toBe('Marie Dupont');

    const attrs = (entity!.attributes ?? []) as LabelledAttribute[];
    const email = attrs.find((a) => a.name === 'email');
    expect(email?.value).toBe('marie@example.com');
    expect(email?.label).toBe('School'); // not "ITEM1.EMAIL" and not lost

    const url = attrs.find((a) => a.name === 'url');
    expect(url?.value).toBe('https://example.com/marie');
    expect(url?.label).toBe('Homepage');

    const org = attrs.find((a) => a.name === 'organization');
    expect(org?.value).toBe('Café Créatif'); // QUOTED-PRINTABLE/ISO-8859-1 decoded

    const note = attrs.find((a) => a.name === 'note');
    expect(note?.value).toBe(
      'Line one of a very long note that must be folded across the wire to stay under a line-length limit.',
    );
  });
});

describe('a card with no phone or email is still a contact', () => {
  /**
   * Models the real chain: `StagedWriter` stores `resolveEntityType(entity)` as
   * the staged type, and push's `entityTypeFor` maps that to
   * `ci.entities.entity_type`.
   */
  const stagedEntityType = (entity: Parameters<typeof resolveEntityType>[0]): string =>
    entityTypeFor({ type: resolveEntityType(entity) } as never);

  /**
   * The regression this pins: `resolveEntityType` only infers 'contact' from a
   * phone/email ATTRIBUTE, so a card carrying just a name (and maybe a URL)
   * resolved to a null type and `entityTypeFor` filed it under the
   * `DEFAULT_ENTITY_TYPE`, `Concept`. A real Google Takeout `.vcf` of 4,926
   * cards produced 1,777 such pseudo-concepts, each duplicating a Person of the
   * same name. Declaring the type at the parser is what fixes it.
   */
  it('types a name-only card as a Person, not a Concept', () => {
    const built = buildContact(
      contentLines('BEGIN:VCARD\nFN:Nadia Whitlock\nURL:https://example.invalid/in/nadia\nEND:VCARD\n'),
      'contacts.vcf',
    )!;

    // The card genuinely has nothing for `hasContactIdentity` to find -- that is
    // the whole point, and without it this test would pass for the wrong reason.
    expect(built.entity.attributes?.some((a: EntityAttribute) => /phone|email|tel/i.test(a.name))).toBe(
      false,
    );
    expect(stagedEntityType(built.entity)).toBe('Person');
  });

  /**
   * The case that already worked, kept so a future change to the parser's
   * `type` cannot fix the name-only card by breaking this one.
   */
  it('still types a card carrying a phone as a Person', () => {
    const built = buildContact(
      contentLines('BEGIN:VCARD\nFN:Bob Reachable\nTEL:+15551110000\nEND:VCARD\n'),
      'contacts.vcf',
    )!;

    expect(stagedEntityType(built.entity)).toBe('Person');
  });

  /**
   * The other half of declaring the type, and the half a repair migration depends
   * on: `naturalKeyFor` folds the staged type INTO the natural key, and
   * `GraphIngestService` derives `linked_id = uuidv5(key)` from it. So fixing the
   * type MOVES the row's upsert coordinate — which is why the cards written before
   * the fix are not healed by re-importing, and why
   * `20260819092314_retype_contact_sourced_concepts_as_people.sql` has to re-key as
   * well as re-type.
   *
   * These two pin both key spaces because that migration hard-codes both strings,
   * as does `20260819145716_propose_contact_card_person_name_merge_candidates.sql`
   * when it selects the rows the re-type moved. If either derivation drifted, those
   * migrations would silently stop matching the importer -- re-keying rows onto a
   * coordinate nothing computes, and proposing nothing at all.
   */
  const stagedNaturalKey = (entity: Parameters<typeof resolveEntityType>[0]): string | null =>
    naturalKeyFor({
      type: resolveEntityType(entity),
      identityKey: entityIdentityKey(entity),
      name: entity.name,
    } as never);

  it('keys a handle-less card as contact:<lowercased name>', () => {
    const built = buildContact(
      contentLines('BEGIN:VCARD\nFN:Nadia Whitlock\nURL:https://example.invalid/in/nadia\nEND:VCARD\n'),
      'contacts.vcf',
    )!;

    // Before the type was declared this same card keyed as
    // `entity:nadia whitlock` — the `entity:` prefix being `type ?? 'entity'`
    // with a NULL type, which is the coordinate the migration reads FROM.
    expect(stagedNaturalKey(built.entity)).toBe('contact:nadia whitlock');
  });

  it('keys a handle-bearing card on its handle, not its name', () => {
    const built = buildContact(
      contentLines('BEGIN:VCARD\nFN:Bob Reachable\nTEL:+15551110000\nEND:VCARD\n'),
      'contacts.vcf',
    )!;

    // Why the migration cannot collide: a correctly-typed card has always keyed on
    // its handle, so re-keying the handle-less rows onto `contact:<name>` lands in
    // a disjoint key space. Verified as 0 collisions on the live corpus too.
    expect(stagedNaturalKey(built.entity)).toBe('contact:5551110000');
  });

  /**
   * The Apple Contacts export writes an office line's extension after an
   * ESCAPED semicolon. The parser unescapes it into the typed value, and the
   * old join key then kept the last ten digits of line + extension —
   * `contact:5550147229`, a stranger's number, as the card's natural key, its
   * `properties.phones` and its identifier. Rows that shipped keep that key
   * until their next import, where `legacyEntityIdentityKey` still computes the
   * truncation and the push moves them onto exactly the keys these two tests
   * pin; migration `20260930020117_refuse_phone_extension_join_keys.sql` removes
   * everything else the fake reached in the meantime.
   */
  it('keys an office-line card with an email on the email, keeping the typed line', () => {
    const built = buildContact(
      contentLines(
        'BEGIN:VCARD\nFN:Dana Quill\nTEL;type=pref:(212) 555-0147\\;229\nEMAIL:dana.quill@example.com\nEND:VCARD\n',
      ),
      'contacts.vcf',
    )!;

    expect(built.entity.metadata?.Phones).toEqual(['(212) 555-0147;229']);
    expect(stagedNaturalKey(built.entity)).toBe('contact:dana.quill@example.com');
  });

  it('keys an office-line card with nothing else on its name', () => {
    const built = buildContact(
      contentLines('BEGIN:VCARD\nFN:Rae Holt\nTEL;TYPE=WORK:212-555-0148 x31\nEND:VCARD\n'),
      'contacts.vcf',
    )!;

    expect(stagedNaturalKey(built.entity)).toBe('contact:rae holt');
  });
});

describe('avatar_url from PHOTO', () => {
  // A real, minimal, decodable PNG (a 1x1 transparent pixel) — not a real
  // contact's face, but real image bytes, so the base64-join/decode path is
  // exercised against something an <img> would actually render, not an opaque
  // string. Folded across two lines to also exercise unfoldContentLines'
  // continuation handling for the general (non-PHOTO) case this suite already
  // covers, and extractCardPhotos' matching fold for PHOTO specifically.
  const PNG_B64_LINE1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk';
  const PNG_B64_LINE2 = '+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const PNG_B64 = PNG_B64_LINE1 + PNG_B64_LINE2;

  it('decodes a folded base64 PHOTO into a data: URI on properties.avatar_url', async () => {
    const raw =
      'BEGIN:VCARD\n' +
      'FN:Priya Kapoor\n' +
      'TEL:+15559990000\n' +
      `PHOTO;ENCODING=b;TYPE=JPEG:${PNG_B64_LINE1}\n` +
      ` ${PNG_B64_LINE2}\n` +
      'END:VCARD\n';

    const { pipeline } = await importRaw(raw);
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.avatar_url).toBe(`data:image/jpeg;base64,${PNG_B64}`);
  });

  it('maps TYPE=PNG to image/png rather than defaulting to jpeg', async () => {
    const raw = `BEGIN:VCARD\nFN:Owen Cho\nTEL:+15559990001\nPHOTO;ENCODING=b;TYPE=PNG:${PNG_B64}\nEND:VCARD\n`;

    const { pipeline } = await importRaw(raw);
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.avatar_url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('defaults to image/jpeg when PHOTO carries no TYPE param', async () => {
    const raw = `BEGIN:VCARD\nFN:Dana Fitch\nTEL:+15559990002\nPHOTO;ENCODING=b:${PNG_B64}\nEND:VCARD\n`;

    const { pipeline } = await importRaw(raw);
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.avatar_url).toBe(`data:image/jpeg;base64,${PNG_B64}`);
  });

  it('keeps a PHOTO;VALUE=URI as a plain URL, never inventing a data: URI for it', async () => {
    const raw =
      'BEGIN:VCARD\nFN:Marco Ruiz\nTEL:+15559990003\nPHOTO;VALUE=URI:https://example.invalid/marco.jpg\nEND:VCARD\n';

    const { pipeline } = await importRaw(raw);
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.avatar_url).toBe('https://example.invalid/marco.jpg');
  });

  it('a card with no PHOTO carries no avatar_url, and does not crash', async () => {
    const raw = 'BEGIN:VCARD\nFN:No Photo Here\nTEL:+15559990004\nEND:VCARD\n';

    const { pipeline } = await importRaw(raw);
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.avatar_url).toBeUndefined();
  });

  it('drops a photo larger than the size cap rather than storing a huge data: URI', async () => {
    // Past MAX_PHOTO_BASE64_CHARS (2,000,000) — one absurdly long folded value.
    const hugeB64 = 'A'.repeat(2_000_100);
    const foldedLines = hugeB64.match(/.{1,72}/g)!.map((chunk) => ` ${chunk}`);
    const raw = `BEGIN:VCARD\nFN:Huge Photo\nTEL:+15559990005\nPHOTO;ENCODING=b:\n${foldedLines.join('\n')}\nEND:VCARD\n`;

    const { pipeline } = await importRaw(raw);
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.avatar_url).toBeUndefined();
  });

  it('drops a photo past the tsvector-safe cap even when it is well under MAX_PHOTO_BASE64_CHARS', async () => {
    // ci.entities maintains a functional index over to_tsvector('english', ...
    // || properties::text) (20251203202414_update_search_vector_logic.sql),
    // and Postgres's tsvector representation has a hard 1,048,575-BYTE ceiling
    // — independent of MAX_PHOTO_BASE64_CHARS, which only bounds the
    // accumulator this parser uses while READING a PHOTO property. A photo
    // comfortably under 2,000,000 chars (so it reads and accumulates fine)
    // can still exceed 1,048,575 once embedded as a data: URI, and previously
    // sailed straight through into avatar_url — confirmed against a real
    // 9,911-contact export, where the resulting oversized row failed its
    // INSERT/UPDATE outright with "string is too long for tsvector", taking
    // the rest of that upsert BATCH down with it (a shared error attributed
    // to every entity in the batch, not just the one with the bad photo), and
    // degraded push throughput roughly 10x while other batches kept retrying.
    //
    // 900,000 chars sits between the two thresholds: past the 700,000-char
    // embed cap, comfortably under the 2,000,000-char accumulator cap — the
    // exact gap the old code left uncovered.
    const bigB64 = 'A'.repeat(900_000);
    const foldedLines = bigB64.match(/.{1,72}/g)!.map((chunk) => ` ${chunk}`);
    const raw = `BEGIN:VCARD\nFN:Big Photo\nTEL:+15559990006\nPHOTO;ENCODING=b:\n${foldedLines.join('\n')}\nEND:VCARD\n`;

    const { pipeline } = await importRaw(raw);
    const [entity] = contactEntities(pipeline);

    expect(entity!.metadata?.avatar_url).toBeUndefined();
    // The rest of the card still imports — a dropped photo degrades to the
    // same "no avatar" shape as a card that never had one, not a lost contact.
    expect(entity!.name).toBe('Big Photo');
  });

  it('keeps a photo right at the safe cap, and drops one character past it', async () => {
    const atCapB64 = 'A'.repeat(700_000 - 'data:image/jpeg;base64,'.length);
    const overCapB64 = atCapB64 + 'A';

    const cardWith = (name: string, b64: string) => {
      const folded = b64.match(/.{1,72}/g)!.map((chunk) => ` ${chunk}`);

      return `BEGIN:VCARD\nFN:${name}\nPHOTO;ENCODING=b:\n${folded.join('\n')}\nEND:VCARD\n`;
    };

    const { pipeline } = await importRaw(cardWith('At Cap', atCapB64) + cardWith('Over Cap', overCapB64));
    const entities = contactEntities(pipeline);
    const byName = new Map(entities.map((e) => [e!.name, e]));

    expect(byName.get('At Cap')?.metadata?.avatar_url).toBe(`data:image/jpeg;base64,${atCapB64}`);
    expect(byName.get('Over Cap')?.metadata?.avatar_url).toBeUndefined();
  });

  it('aligns each card to its OWN photo across a multi-card file, not an off-by-one neighbor', async () => {
    // The regression this guards: extractCardPhotos and the main BEGIN/END loop
    // walk the file independently and must agree on where card N starts and
    // ends, including for a card with no PHOTO at all in between two that have
    // one — the exact shape that would surface an index drifting by one.
    const raw =
      `BEGIN:VCARD\nFN:First Card\nTEL:+15551000001\nPHOTO;ENCODING=b:${PNG_B64}\nEND:VCARD\n` +
      'BEGIN:VCARD\nFN:Second Card No Photo\nTEL:+15551000002\nEND:VCARD\n' +
      `BEGIN:VCARD\nFN:Third Card\nTEL:+15551000003\nPHOTO;ENCODING=b;TYPE=PNG:${PNG_B64}\nEND:VCARD\n`;

    const { pipeline } = await importRaw(raw);
    const entities = contactEntities(pipeline);
    const byName = new Map(entities.map((e) => [e!.name, e]));

    expect(byName.get('First Card')?.metadata?.avatar_url).toBe(`data:image/jpeg;base64,${PNG_B64}`);
    expect(byName.get('Second Card No Photo')?.metadata?.avatar_url).toBeUndefined();
    expect(byName.get('Third Card')?.metadata?.avatar_url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('a truncated card (second BEGIN before an END) does not shift a later photo onto the wrong card', async () => {
    const raw =
      // Truncated: BEGIN with no END before the next BEGIN.
      'BEGIN:VCARD\nFN:Truncated Card\nTEL:+15551000004\n' +
      `BEGIN:VCARD\nFN:Real Card\nTEL:+15551000005\nPHOTO;ENCODING=b:${PNG_B64}\nEND:VCARD\n`;

    const { pipeline, drops } = await importRaw(raw);
    const entities = contactEntities(pipeline);

    expect(drops.no_end_marker).toBe(1);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.name).toBe('Real Card');
    expect(entities[0]!.metadata?.avatar_url).toBe(`data:image/jpeg;base64,${PNG_B64}`);
  });
});

describe('colleagues on one office line are keyed apart', () => {
  /*
   * The shape that made three people one Person: every card from one firm lists
   * the switchboard (555-0100) and the fax (555-0101) beside the person's own
   * address, the smallest handle keyed the card, and digits sort before letters
   * — so all three keyed on the switchboard, staged as one entity, and pushed as
   * one Person whose accumulated `Names` listed them all. Invented data; the
   * real export's quirks are kept: the switchboard typed CELL on one card, and
   * the fax typed FAX on one card and left bare on the next.
   */
  const OFFICE = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Priya Natarajan',
    'EMAIL;TYPE=INTERNET;TYPE=pref:priya@example.com',
    'TEL;TYPE=WORK;TYPE=VOICE:(555) 010-0100',
    'TEL;TYPE=WORK;TYPE=FAX:(555) 010-0101',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Tom Becker',
    'EMAIL;TYPE=INTERNET:tom@example.com',
    'TEL;TYPE=CELL;TYPE=pref:(555) 010-0100',
    'TEL:(555) 010-0101',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Lena Ortiz',
    'item1.EMAIL;TYPE=INTERNET:lena@example.com',
    'item1.X-ABLabel:_$!<Work>!$_',
    'TEL;TYPE=WORK:(555) 010-0100',
    'TEL;TYPE=CELL:(555) 010-0142',
    'END:VCARD',
    '',
  ].join('\r\n');

  const natural = (entity: Entity) =>
    naturalKeyFor({
      type: resolveEntityType(entity),
      identityKey: entityIdentityKey(entity),
      name: entity.name,
    } as never);

  it('keys each colleague on a handle of their own', async () => {
    const { pipeline } = await importRaw(OFFICE);
    const entities = contactEntities(pipeline) as Entity[];

    expect(entities.map((e) => e.name)).toEqual(['Priya Natarajan', 'Tom Becker', 'Lena Ortiz']);
    expect(entities.map(natural)).toEqual([
      'contact:priya@example.com',
      'contact:tom@example.com',
      'contact:5550100142',
    ]);
  });

  it('still reports the key they USED to share, which is how the old Person is found', async () => {
    const { pipeline } = await importRaw(OFFICE);
    const entities = contactEntities(pipeline) as Entity[];

    expect(entities.map(legacyEntityIdentityKey)).toEqual(['5550100100', '5550100100', '5550100100']);
  });

  it('keeps the shared numbers on each card — they are still how to reach these people', async () => {
    const { pipeline } = await importRaw(OFFICE);
    const [priya, tom] = contactEntities(pipeline) as Entity[];

    // The fax stays on the card, filed as a fax — Tom's copy too, which is
    // untyped: the export types it FAX on Priya's card.
    expect(priya.metadata?.Phones).toEqual(['(555) 010-0100']);
    expect(priya.metadata?.Faxes).toEqual(['(555) 010-0101']);
    expect(tom.metadata?.Phones).toEqual(['(555) 010-0100']);
    expect(tom.metadata?.Faxes).toEqual(['(555) 010-0101']);
    expect(priya.attributes?.filter((a) => a.shared).map((a) => a.value)).toEqual([
      '(555) 010-0100',
      '(555) 010-0101',
    ]);
  });

  it("indexes each colleague under their own handles only — never the office's lines", async () => {
    const { pipeline } = await importRaw(OFFICE);
    const entities = contactEntities(pipeline) as Entity[];

    // The switchboard and the fax are shared: indexed under whichever colleague
    // arrived first, they would claim every call the office makes.
    expect(entities.map(contactIdentifiers)).toEqual([
      { emails: ['priya@example.com'], phones: [] },
      { emails: ['tom@example.com'], phones: [] },
      { emails: ['lena@example.com'], phones: ['5550100142'] },
    ]);
  });

  it('treats a number typed FAX on one copy of a card as a fax on the other copy too', async () => {
    // One person, two copies: a per-card rule keyed the typed copy on the direct
    // line and the untyped copy on the fax, and split one person in two.
    const raw =
      'BEGIN:VCARD\nFN:Omar Haddad\nTEL;TYPE=WORK;TYPE=FAX:555-010-0150\nTEL:555-010-0177\nEND:VCARD\n' +
      'BEGIN:VCARD\nFN:Omar Haddad\nTEL:555-010-0150\nTEL:555-010-0177\nEND:VCARD\n';

    const { pipeline } = await importRaw(raw);
    const entities = contactEntities(pipeline) as Entity[];

    expect(entities.map(entityIdentityKey)).toEqual(['5550100177', '5550100177']);
  });

  it('leaves one person filed twice under two spellings collapsing on their shared line', async () => {
    const raw =
      'BEGIN:VCARD\nFN:Matt Okafor\nTEL:555-010-0160\nEMAIL:matt@example.com\nEND:VCARD\n' +
      'BEGIN:VCARD\nFN:Matthew Okafor\nTEL:555-010-0160\nEND:VCARD\n';

    const { pipeline } = await importRaw(raw);
    const entities = contactEntities(pipeline) as Entity[];

    expect(entities.map(entityIdentityKey)).toEqual(['5550100160', '5550100160']);
    expect(entities.flatMap((e) => e.attributes ?? []).some((a) => a.shared)).toBe(false);
  });

  it('still counts an empty card as a drop in the two-pass flow', async () => {
    const raw = 'BEGIN:VCARD\nVERSION:3.0\nEND:VCARD\nBEGIN:VCARD\nFN:Grace Whitaker\nEND:VCARD\n';

    const { pipeline, drops } = await importRaw(raw);

    expect(drops.empty_card).toBe(1);
    expect(contactEntities(pipeline).map((e) => e!.name)).toEqual(['Grace Whitaker']);
  });
});

describe('faxNumbersOf', () => {
  const faxes = (card: string) => faxNumbersOf(contentLines(`BEGIN:VCARD\n${card}\nEND:VCARD\n`));

  it('reads TYPE=FAX in any case, alone or in a list', () => {
    expect(faxes('TEL;TYPE=WORK;TYPE=FAX:555-010-0101')).toEqual(['555-010-0101']);
    expect(faxes('TEL;type=work,fax:555-010-0101')).toEqual(['555-010-0101']);
  });

  it("reads vCard 2.1's bare ;FAX", () => {
    expect(faxes('TEL;WORK;FAX:555-010-0101')).toEqual(['555-010-0101']);
  });

  it("reads Apple's fax label and a custom one", () => {
    expect(faxes('item2.TEL:555-010-0101\nitem2.X-ABLabel:_$!<WorkFAX>!$_')).toEqual(['555-010-0101']);
    expect(faxes('item3.X-ABLabel:Office fax\nitem3.TEL:555-010-0102')).toEqual(['555-010-0102']);
  });

  it('ignores every other line', () => {
    expect(faxes('TEL;TYPE=CELL:555-010-0142\nTEL;TYPE=WORK:555-010-0100\nNOTE:fax me')).toEqual([]);
  });
});
