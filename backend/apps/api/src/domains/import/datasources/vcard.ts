/*
 * vCard datasource — .vcf / .vcard contact files (vCard 2.1, 3.0 and 4.0).
 *
 * Real exports are nothing like the toy `FN:…/TEL:…/END:VCARD` shape. A macOS
 * Contacts export and a Google Takeout Contacts export both fold long lines,
 * both attach their custom labels through `itemN.` property GROUPS, and both
 * put a contact's only email or phone inside one of those groups:
 *
 *     item1.EMAIL;type=INTERNET:someone@example.com
 *     item1.X-ABLabel:_$!<School>!$_
 *     NOTE:URL\: https\://example.com/x\nPosition\: Engineer\nConnected On\: 09
 *      May 2014\n
 *
 * The previous per-physical-line regex (`^([^:;]+)(?:;[^:]*)?:(.*)$`) keyed the
 * first of those as `ITEM1.EMAIL` — a name nothing ever reads — and read the
 * folded second line of that NOTE as a property of its own. On the developer's
 * real archive (4,927 Apple + 340 Google cards) that lost 606 of 610 URLs, 69
 * emails and 15 phones outright, silently dropped the 17 cards whose ONLY
 * content is a grouped email, and left three quarters of the imported contacts
 * with no email and no phone — i.e. with no `entities.identity_key`, which is
 * the only thing person resolution can match on.
 *
 * So this parser tokenises properly: unfold first (RFC 6350 §3.2, plus vCard
 * 2.1 QUOTED-PRINTABLE soft breaks), then split each content line into
 * `[group.]NAME[;params]:value` with a scanner that respects quoted parameter
 * values, then decode the transport encoding (QUOTED-PRINTABLE/CHARSET) before
 * the RFC 6350 §3.4 TEXT unescaping.
 *
 * It also emits an ITEM per card, not an entity alone. A contact is a RECORD
 * the archive holds, and every reporting surface here is keyed on `items`:
 * `stats`' by-data-source table, `query --ds`, the ingest job's new/dup
 * counters, and — the one that actually loses data — graph-sync's `knownSources`
 * gate, which only stamps a contact's `data_source` when that source has landed
 * an item. Emitting entities alone is why importing 5,250 contacts reported
 * "5250 items, 0 new, 0 dup" and why `vcard` appeared nowhere in `stats`. The
 * entity hangs off the item as an edge, so the person still dedups globally on
 * their handle while the card itself stays a durable, attributable, dedupable
 * row — and the item↔entity relationship the graph needs finally exists.
 *
 * And because a contact that resolves to an entity an earlier source already
 * created (the same address seen in a mail header) would otherwise be discarded
 * whole by upsertEntity, the entity declares `accumulate` keys: the emails,
 * phones, URLs, organizations and addresses a card carries GROW the existing
 * row instead of vanishing into it. See persistence.ts mergeAccumulatedMetadata.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { unescapeIcsText as unescapeVCardText } from './calendar';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Entity, EntityAttribute, Item, Metadata } from './timeline';
// RFC 6350 §3.4 vCard TEXT values use the same backslash escaping
// (\\ \; \, \n) as RFC 5545 §3.3.11 iCalendar TEXT values, so the two
// datasources share one implementation rather than duplicating the regex.

// Record<string, never> rather than an empty interface: the repo's lint rule
// rejects `interface X {}` because it admits any non-nullish value.
type VCardOptions = Record<string, never>;

/** Classification stamped on the per-contact item. */
const CONTACT_CLASSIFICATION = 'contact';

/**
 * A contact attribute plus the label the export attached to it. `EntityAttribute`
 * carries only name/value/identity — which is what persistence's identity
 * derivation reads — so the vCard-specific `label`/`pref` ride alongside as
 * extra keys. They are stored verbatim in `entities.metadata.attributes` and
 * ignored by every consumer that only knows the base shape.
 */
type ContactAttribute = EntityAttribute & { label?: string; pref?: boolean };

/** One parsed content line: `[group.]NAME[;params]:value`. */
export interface ContentLine {
  /** Property group (`ITEM1`), upper-cased; '' when ungrouped. */
  group: string;
  /** Upper-cased property name. */
  name: string;
  /** Upper-cased parameter names → their values, in file order. */
  params: Record<string, string[]>;
  /** Value with its transport encoding decoded; still TEXT-escaped. */
  value: string;
  /** ENCODING=b/BASE64 — the value was a binary blob and was NOT retained. */
  binary: boolean;
}

export class VCardFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {return { confidence: 0 };}

    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full).toLowerCase();
      if (ext === '.vcf' || ext === '.vcard') {
        try {
          const fd = await fs.promises.open(full, 'r');
          // 14 bytes, not 11: a real export may open with a UTF-8 BOM, and an
          // exact match on 'BEGIN:VCARD' then failed and downgraded a perfectly
          // good file to the 0.8 extension-only guess.
          const buf = Buffer.alloc(14);
          await fd.read(buf, 0, 14, 0);
          await fd.close();
          const head = stripBom(buf.toString('utf8')).toUpperCase();
          if (head.startsWith('BEGIN:VCARD')) {return { confidence: 1.0 };}
        } catch {
          /* ignore */
        }

        return { confidence: 0.8 };
      }
    }

    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {return { confidence: 0, dir_threshold: 0.9 };}

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const start = entry.fullPath || entry.fsRoot || entry.filename;
    if (!start) {return;}

    const stat = fs.statSync(start);
    if (stat.isDirectory()) {
      for await (const f of this.walkDir(start)) {if (this.isVcf(f)) {await this.processFile(f, params);}}
    } else if (this.isVcf(start)) {
      await this.processFile(start, params);
    }
  }

  private isVcf(f: string): boolean {
    const e = path.extname(f).toLowerCase();

    return e === '.vcf' || e === '.vcard';
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const ents = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) {continue;}

        yield* this.walkDir(full);
      } else if (e.isFile()) {yield full;}
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'read vcard failed', { file: path.basename(fpath), error: (e as Error).message });
      // A file we cannot read is a whole export lost; the ledger has to say so.
      params.pipeline.drop?.('unreadable_file', path.basename(fpath));

      return;
    }

    const file = path.basename(fpath);
    let card: ContentLine[] | null = null;

    for (const line of unfoldContentLines(raw)) {
      const trimmed = line.trim();
      if (/^BEGIN:VCARD$/i.test(trimmed)) {
        // A second BEGIN before an END means the previous card was truncated.
        if (card) {params.pipeline.drop?.('no_end_marker', file);}

        card = [];
        continue;
      }

      if (/^END:VCARD$/i.test(trimmed)) {
        if (card) {this.emitCard(card, file, params);}

        card = null;
        continue;
      }

      if (!card) {continue;}

      const parsed = parseContentLine(line);
      if (parsed) {card.push(parsed);}
    }

    if (card) {params.pipeline.drop?.('no_end_marker', file);}
  }

  private emitCard(lines: ContentLine[], file: string, params: ImportParams): void {
    const contact = buildContact(lines, file);
    if (!contact) {
      // A card with neither a name nor one usable attribute. Rare, but it is a
      // record we chose not to keep — never a silent `continue`.
      params.pipeline.drop?.('empty_card', file);

      return;
    }

    params.pipeline.push({
      item: contact.item,
      edges: [{ relation: 'contact', to: { entity: contact.entity } }],
    });
  }
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** A property whose value is a base64 blob we deliberately do not retain. */
const BINARY_PROPERTY_HEAD = /^[A-Za-z0-9.-]+;[^:]*ENCODING=(?:b|base64)(?:[;:])/i;

/**
 * Physical lines → logical content lines.
 *
 * RFC 6350 §3.2 folds a long line by inserting CRLF + a single SPACE/TAB, so
 * unfolding removes the break and exactly one whitespace character. vCard 2.1
 * QUOTED-PRINTABLE instead ends a continued line with `=` and no leading
 * whitespace on the next — Android and older Outlook exports both do this, and
 * without the second rule every such N/FN/TEL is truncated at the fold.
 *
 * Continuations of a base64 property (a contact PHOTO, which is most of an
 * Apple export's bytes) are discarded rather than joined: the blob is never
 * used, and a 78 MB address book would otherwise be held twice in memory.
 */
export function unfoldContentLines(raw: string): string[] {
  const physical = stripBom(raw).split(/\r\n|\r|\n/);
  const out: string[] = [];
  let tailIsBinary = false;
  for (const line of physical) {
    if (out.length && (line.startsWith(' ') || line.startsWith('\t'))) {
      if (!tailIsBinary) {out[out.length - 1] += line.slice(1);}

      continue;
    }

    const prev = out.length ? out[out.length - 1] : undefined;
    if (prev !== undefined && prev.endsWith('=') && /ENCODING=QUOTED-PRINTABLE/i.test(prev)) {
      out[out.length - 1] = prev.slice(0, -1) + line;
      continue;
    }

    tailIsBinary = BINARY_PROPERTY_HEAD.test(line);
    out.push(line);
  }

  return out;
}

/** Split on `sep` at the top level, ignoring separators inside double quotes. */
function splitUnquoted(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }

    if (ch === sep && !inQuotes) {
      parts.push(cur);
      cur = '';
      continue;
    }

    cur += ch;
  }

  parts.push(cur);

  return parts;
}

function stripQuotes(v: string): string {
  const t = v.trim();

  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Transport encodings that may appear as a bare vCard 2.1 parameter token. */
const BARE_ENCODINGS = new Set(['QUOTED-PRINTABLE', 'BASE64', '8BIT', '7BIT', 'B']);

/**
 * Parse one unfolded line into `[group.]NAME[;params]:value`, or null when the
 * line is not a content line at all.
 *
 * The name is validated against the RFC's `[A-Za-z0-9-]+` production. That
 * guard is what stops the old failure mode where a stray text fragment
 * containing a colon ("Connected On: 09 May 2014", left over from a fold that
 * was never joined) was accepted as a property and vanished from the note it
 * belonged to.
 */
export function parseContentLine(line: string): ContentLine | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }

  if (colon < 0) {return null;}

  const segments = splitUnquoted(line.slice(0, colon), ';');
  let nameToken = segments[0].trim();
  if (!nameToken) {return null;}

  let group = '';
  const dot = nameToken.indexOf('.');
  if (dot > 0) {
    group = nameToken.slice(0, dot).trim().toUpperCase();
    nameToken = nameToken.slice(dot + 1).trim();
  }

  const name = nameToken.toUpperCase();
  if (!/^[A-Za-z0-9-]+$/.test(name)) {return null;}

  const params: Record<string, string[]> = {};
  const addParam = (key: string, value: string) => {
    (params[key] ??= []).push(value);
  };

  for (const segment of segments.slice(1)) {
    const seg = segment.trim();
    if (!seg) {continue;}

    const eq = seg.indexOf('=');
    if (eq === -1) {
      // vCard 2.1 shorthand: `TEL;CELL;VOICE:` (bare TYPE values) and a bare
      // `;QUOTED-PRINTABLE` transport marker.
      const bare = stripQuotes(seg);
      if (BARE_ENCODINGS.has(bare.toUpperCase())) {addParam('ENCODING', bare);}
      else if (bare) {addParam('TYPE', bare);}

      continue;
    }

    const key = seg.slice(0, eq).trim().toUpperCase();
    for (const v of splitUnquoted(seg.slice(eq + 1), ',')) {
      const value = stripQuotes(v);
      if (value) {addParam(key, value);}
    }
  }

  const decoded = decodeTransport(line.slice(colon + 1), params);

  return { group, name, params, value: decoded.text, binary: decoded.binary };
}

/** Charset names we can hand straight to Buffer#toString. */
const NODE_ENCODINGS: Record<string, BufferEncoding> = {
  'utf-8': 'utf8',
  utf8: 'utf8',
  'us-ascii': 'ascii',
  ascii: 'ascii',
  'iso-8859-1': 'latin1',
  'iso8859-1': 'latin1',
  latin1: 'latin1',
  'windows-1252': 'latin1',
  'utf-16le': 'utf16le',
  'utf-16': 'utf16le',
};

function decodeTransport(value: string, params: Record<string, string[]>): { text: string; binary: boolean } {
  const encoding = (params.ENCODING?.[0] ?? '').toUpperCase();
  if (encoding === 'B' || encoding === 'BASE64') {return { text: '', binary: true };}

  if (encoding === 'QUOTED-PRINTABLE') {
    const charset = (params.CHARSET?.[0] ?? 'utf-8').toLowerCase();

    return { text: decodeQuotedPrintable(value, charset), binary: false };
  }

  return { text: value, binary: false };
}

/**
 * Decode a QUOTED-PRINTABLE value (RFC 2045 §6.7) into text.
 *
 * The file was read as UTF-8, so any character that survived that read is
 * re-encoded to its bytes before the buffer is decoded under the declared
 * CHARSET — otherwise a `=C3=A9` (é) and the literal `é` next to it in the same
 * value would decode under two different rules.
 */
export function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }

    for (const b of Buffer.from(ch, 'utf8')) {bytes.push(b);}
  }

  return Buffer.from(bytes).toString(NODE_ENCODINGS[charset] ?? 'utf8');
}

/**
 * Split a structured value (N, ADR, CATEGORIES, ORG) on its delimiter, honouring
 * the backslash escaping: an escaped `\;` inside a street address is part of the
 * text, not a component break. Each component is unescaped on its own, so a
 * component whose escape decodes TO the delimiter cannot re-split it.
 */
export function splitStructured(value: string, sep: ';' | ','): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i += 1;
      continue;
    }

    if (ch === sep) {
      parts.push(cur);
      cur = '';
      continue;
    }

    cur += ch;
  }

  parts.push(cur);

  return parts.map((p) => unescapeVCardText(p).trim());
}

// ── Card → contact ───────────────────────────────────────────────────────────

/** Apple wraps its label vocabulary as `_$!<Home>!$_`; unwrap to `Home`. */
function cleanLabel(value: string): string {
  return unescapeVCardText(value)
    .replace(/^_\$!<(.*)>!\$_$/, '$1')
    .trim();
}

/** Parameter values that describe the transport, not the human's label. */
const NON_LABEL_TYPES = new Set(['INTERNET', 'VOICE', 'PREF', 'X-INTERNET', 'OTHER']);

/**
 * The label a human would read off this property: the group's `X-ABLabel` when
 * the export attached one (`item1.EMAIL` + `item1.X-ABLabel:_$!<School>!$_`),
 * otherwise the first TYPE parameter that names a place rather than a wire
 * format. This is the `TYPE=CELL` / `PREF` information the old regex threw away.
 */
function labelFor(line: ContentLine, groupLabels: Map<string, string>): string | undefined {
  const grouped = line.group ? groupLabels.get(line.group) : undefined;
  if (grouped) {return grouped;}

  for (const t of line.params.TYPE ?? []) {
    if (!NON_LABEL_TYPES.has(t.toUpperCase())) {return t;}
  }

  return undefined;
}

function isPreferred(line: ContentLine): boolean {
  if (line.params.PREF?.length) {return true;}

  return (line.params.TYPE ?? []).some((t) => t.toUpperCase() === 'PREF');
}

/**
 * Display name from the structured N property (family;given;additional;prefix;
 * suffix). The components are stored family-first, so joining them in file
 * order produced "Broza Liam" for every card whose export omitted FN (152 of
 * one real 4,927-card export). Rebuild them in reading order instead.
 */
export function nameFromN(value: string): string {
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] = splitStructured(value, ';');

  return [prefix, given, additional, family, suffix].filter(Boolean).join(' ').trim();
}

/** ADR components → one human line (po;ext;street;locality;region;postal;country). */
function formatAddress(value: string): string {
  const [po = '', ext = '', street = '', locality = '', region = '', postal = '', country = ''] =
    splitStructured(value, ';');
  const streetLine = [po, ext, street].filter(Boolean).join(' ');

  return [streetLine, locality, region, postal, country].filter(Boolean).join(', ').trim();
}

/** Unique, order-preserving, empties removed. */
function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * The accumulating entity-metadata keys. A contact that resolves to an entity
 * some earlier source already created must be able to ADD to it — an email the
 * mail headers never showed, the person's employer, their address — rather than
 * being swallowed whole by the upsert. Plural names, list values, first-write-
 * wins nowhere. See Entity.accumulate.
 */
const ACCUMULATED_KEYS = [
  'Names',
  'Emails',
  'Phones',
  'URLs',
  'Organizations',
  'JobTitles',
  'Addresses',
  'Notes',
  'Nicknames',
  'Categories',
  'SocialProfiles',
  'Files',
];

export interface BuiltContact {
  item: Item;
  entity: Entity;
}

/**
 * One parsed card → the item that records it and the entity it describes.
 * Returns null when the card carries neither a name nor a single usable
 * attribute (an `END:VCARD` with nothing but VERSION/PRODID before it).
 */
export function buildContact(lines: ContentLine[], file: string): BuiltContact | null {
  // Labels first: `item1.X-ABLabel` names what `item1.EMAIL` is FOR, and both
  // orders occur in real files, so the map must be complete before it is read.
  const groupLabels = new Map<string, string>();
  for (const line of lines) {
    if (!line.group || line.binary || line.name !== 'X-ABLABEL') {continue;}

    const label = cleanLabel(line.value);
    if (label) {groupLabels.set(line.group, label);}
  }

  const attributes: ContactAttribute[] = [];
  const emails: string[] = [];
  const phones: string[] = [];
  const urls: string[] = [];
  const orgs: string[] = [];
  const titles: string[] = [];
  const addresses: string[] = [];
  const notes: string[] = [];
  const nicknames: string[] = [];
  const categories: string[] = [];
  const socials: string[] = [];
  let fn = '';
  let structuredName = '';
  let birthday = '';
  let uid = '';

  for (const line of lines) {
    if (line.binary) {continue;}

    const label = labelFor(line, groupLabels);
    const labelled = label ? { label } : {};
    const preferred = isPreferred(line) ? { pref: true } : {};
    const text = () => unescapeVCardText(line.value).trim();

    switch (line.name) {
      case 'FN':
        if (!fn) {fn = text();}

        break;
      case 'N':
        if (!structuredName) {structuredName = nameFromN(line.value);}

        break;
      case 'TEL': {
        const v = text();
        if (!v) {break;}

        phones.push(v);
        attributes.push({ name: 'phone', value: v, identity: true, ...labelled, ...preferred });
        break;
      }

      case 'EMAIL': {
        const v = text();
        if (!v) {break;}

        emails.push(v);
        attributes.push({ name: 'email', value: v, identity: true, ...labelled, ...preferred });
        break;
      }

      case 'URL': {
        const v = text();
        if (!v) {break;}

        urls.push(v);
        attributes.push({ name: 'url', value: v, ...labelled });
        break;
      }

      case 'ORG': {
        // ORG is structured (org;unit;unit…) and Apple writes the trailing `;`.
        const v = splitStructured(line.value, ';').filter(Boolean).join(' — ');
        if (!v) {break;}

        orgs.push(v);
        attributes.push({ name: 'organization', value: v });
        break;
      }

      case 'TITLE':
      case 'ROLE': {
        const v = text();
        if (!v) {break;}

        titles.push(v);
        attributes.push({ name: 'job_title', value: v });
        break;
      }

      case 'ADR': {
        const v = formatAddress(line.value);
        if (!v) {break;}

        addresses.push(v);
        attributes.push({ name: 'address', value: v, ...labelled });
        break;
      }

      case 'NOTE': {
        const v = text();
        if (!v) {break;}

        notes.push(v);
        attributes.push({ name: 'note', value: v });
        break;
      }

      case 'NICKNAME': {
        const v = text();
        if (!v) {break;}

        nicknames.push(v);
        attributes.push({ name: 'nickname', value: v });
        break;
      }

      case 'BDAY':
        // BDAY is a DATE(-TIME) value, not TEXT — no backslash escaping applies.
        if (!birthday) {birthday = line.value.trim();}

        break;
      case 'CATEGORIES':
        // Google Takeout writes one .vcf per label and repeats the label set
        // here; it is the only record of which groups a contact belongs to.
        for (const c of splitStructured(line.value, ',')) {if (c) {categories.push(c);}}

        break;
      case 'IMPP':
      case 'X-SOCIALPROFILE': {
        const v = text();
        if (!v) {break;}

        const service = line.params['X-SERVICE-TYPE']?.[0] ?? label;
        socials.push(service ? `${service}: ${v}` : v);
        attributes.push({ name: 'social_profile', value: v, ...(service ? { label: service } : {}) });
        break;
      }

      case 'UID':
        if (!uid) {uid = text();}

        break;
      default:
        break;
    }
  }

  if (birthday) {attributes.push({ name: 'birth_date', value: birthday });}

  const name = fn || structuredName;
  if (!name && attributes.length === 0) {return null;}

  const item: Item = {
    id: contactId(uid, file, lines),
    classification: CONTACT_CLASSIFICATION,
    // Deliberately undated. A contact card records no occurrence, and a
    // timestamp here would be import time — mapping.ts routes an undated
    // non-event to `content` alone rather than fabricating a timeline entry.
    metadata: {
      Source: 'vCard',
      File: file,
      // `Name` is what mapping.ts titleFor reads, `Note` what descriptionFor
      // reads, so a pushed contact card gets a real title and body instead of
      // a filename and nothing.
      ...(name ? { Name: name } : {}),
      ...(orgs.length ? { Organization: orgs[0] } : {}),
      ...(titles.length ? { JobTitle: titles[0] } : {}),
      ...(emails.length ? { Emails: uniq(emails) } : {}),
      ...(phones.length ? { Phones: uniq(phones) } : {}),
      ...(urls.length ? { URLs: uniq(urls) } : {}),
      ...(addresses.length ? { Addresses: uniq(addresses) } : {}),
      ...(categories.length ? { Categories: uniq(categories) } : {}),
      ...(socials.length ? { SocialProfiles: uniq(socials) } : {}),
      ...(nicknames.length ? { Nicknames: uniq(nicknames) } : {}),
      ...(birthday ? { Birthday: birthday } : {}),
      ...(notes.length ? { Note: notes.join('\n\n') } : {}),
      ...(uid ? { UID: uid } : {}),
    } as Metadata,
  };

  const entity: Entity = {
    name,
    attributes,
    metadata: {
      Source: 'vCard',
      ...(name ? { Names: [name] } : {}),
      ...(emails.length ? { Emails: uniq(emails) } : {}),
      ...(phones.length ? { Phones: uniq(phones) } : {}),
      ...(urls.length ? { URLs: uniq(urls) } : {}),
      ...(orgs.length ? { Organizations: uniq(orgs) } : {}),
      ...(titles.length ? { JobTitles: uniq(titles) } : {}),
      ...(addresses.length ? { Addresses: uniq(addresses) } : {}),
      ...(notes.length ? { Notes: uniq(notes) } : {}),
      ...(nicknames.length ? { Nicknames: uniq(nicknames) } : {}),
      ...(categories.length ? { Categories: uniq(categories) } : {}),
      ...(socials.length ? { SocialProfiles: uniq(socials) } : {}),
      Files: [file],
    } as Metadata,
    accumulate: ACCUMULATED_KEYS,
  };

  return { item, entity };
}

/**
 * Stable per-card id, so re-importing the same export dedups on
 * (data_source, content_hash) instead of filing every contact twice.
 *
 * `UID` when the export supplies one (vCard 4.0, CardDAV dumps); otherwise a
 * digest of the card's own decoded content plus the file it came from. Binary
 * values are excluded so the digest cannot depend on a photo we never keep, and
 * the file name is included because the same person legitimately appears in
 * several of Google Takeout's per-label exports as several distinct cards.
 */
function contactId(uid: string, file: string, lines: ContentLine[]): string {
  const h = crypto.createHash('sha1');
  h.update('vcard\0');
  h.update(file);
  h.update('\0');
  if (uid) {
    h.update('uid\0');
    h.update(uid);
  } else {
    for (const line of lines) {
      if (line.binary) {continue;}

      h.update(`${line.group}.${line.name}:${line.value}\n`);
    }
  }

  return h.digest('hex');
}

registerDataSource({
  name: 'vcard',
  title: 'vCard',
  icon: 'vcard.svg',
  description: 'vCard (.vcf) contact files',
  newOptions: () => ({}) as VCardOptions,
  newFileImporter: () => new VCardFileImporter(),
});
