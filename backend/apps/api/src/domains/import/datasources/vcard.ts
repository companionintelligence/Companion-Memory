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
 * And it reads the NOTE as a record rather than as prose: an export that
 * merged another address book leaves that book's `Emails:`/`PhoneNumbers:`
 * there instead of in properties, so a handle-less card is recovered from its
 * own note before it reaches entity resolution. See handlesFromNote.
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
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { markSharedContactHandles } from '../staging/identity';

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
    if (!full) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(full);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
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
          if (head.startsWith('BEGIN:VCARD')) {
            return { confidence: 1.0 };
          }
        } catch {
          /* ignore */
        }

        return { confidence: 0.8 };
      }
    }

    if (st.isDirectory()) {
      return { confidence: 0, dir_threshold: 0.9 };
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
      for await (const f of this.walkDir(start)) {
        if (this.isVcf(f)) {
          await this.processFile(f, params);
        }
      }
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
        if (e.name.startsWith('.')) {
          continue;
        }

        yield* this.walkDir(full);
      } else if (e.isFile()) {
        yield full;
      }
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
    // One entry per END:VCARD in file order — see extractCardPhotos for why this
    // is a companion pass over `raw` rather than something unfoldContentLines
    // itself hands back. `cardIndex` below advances on every END:VCARD, exactly
    // when this array gained its next entry, so the two stay in lockstep even
    // through a truncated card or a stray END with no matching BEGIN.
    const photos = extractCardPhotos(raw);
    let cardIndex = 0;
    const cards: { lines: ContentLine[]; photo?: CardPhoto }[] = [];

    for (const line of unfoldContentLines(raw)) {
      const trimmed = line.trim();
      if (/^BEGIN:VCARD$/i.test(trimmed)) {
        // A second BEGIN before an END means the previous card was truncated.
        if (card) {
          params.pipeline.drop?.('no_end_marker', file);
        }

        card = [];
        continue;
      }

      if (/^END:VCARD$/i.test(trimmed)) {
        const photo = photos[cardIndex];
        cardIndex += 1;

        if (card) {
          cards.push({ lines: card, photo });
        }

        card = null;
        continue;
      }

      if (!card) {
        continue;
      }

      const parsed = parseContentLine(line);
      if (parsed) {
        card.push(parsed);
      }
    }

    if (card) {
      params.pipeline.drop?.('no_end_marker', file);
    }

    this.emitCards(cards, file, params);
  }

  /**
   * Build every card of one file, then emit them in file order.
   *
   * Two passes, because a card cannot tell on its own which of its numbers are
   * its own. Colleagues' cards all list the office switchboard and the office
   * fax; each card alone just lists some numbers. Only the file shows that the
   * same line sits on three people's cards, and so must not be the one handle
   * that keys any of them — see `markSharedContactHandles`. The file is already
   * read whole (and every photo already extracted), so waiting for the last
   * card costs no extra read and little extra memory.
   */
  private emitCards(
    cards: { lines: ContentLine[]; photo?: CardPhoto }[],
    file: string,
    params: ImportParams,
  ): void {
    const built: BuiltContact[] = [];
    const faxes: string[] = [];

    for (const { lines, photo } of cards) {
      const contact = buildContact(lines, file, photo);
      if (!contact) {
        // A card with neither a name nor one usable attribute. Rare, but it is a
        // record we chose not to keep — never a silent `continue`.
        params.pipeline.drop?.('empty_card', file);
        continue;
      }

      built.push(contact);
      faxes.push(...faxNumbersOf(lines));
    }

    const entities = markSharedContactHandles(
      built.map((contact) => contact.entity),
      faxes,
    );

    built.forEach((contact, index) => {
      params.pipeline.push({
        item: contact.item,
        edges: [{ relation: 'contact', to: { entity: entities[index] } }],
      });
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
 * Apple export's bytes) are discarded rather than joined here: joining them
 * into `out` would hold every card's photo in this one shared buffer for the
 * life of the whole file (a 78 MB address book held twice in memory). A card's
 * PHOTO, when kept, is extracted by the separate {@link extractCardPhotos}
 * pass below instead, which holds at most one card's photo at a time.
 */
export function unfoldContentLines(raw: string): string[] {
  const physical = stripBom(raw).split(/\r\n|\r|\n/);
  const out: string[] = [];
  let tailIsBinary = false;
  for (const line of physical) {
    if (out.length && (line.startsWith(' ') || line.startsWith('\t'))) {
      if (!tailIsBinary) {
        out[out.length - 1] += line.slice(1);
      }

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

/** A card's embedded PHOTO, decoded just enough to build a `data:` URI. */
export interface CardPhoto {
  /** e.g. `image/jpeg` — from the property's TYPE param, defaulting to JPEG (the
   *  overwhelming majority of real exports; vCard's own default per RFC 2426). */
  mimeType: string;
  base64: string;
}

/** A PHOTO payload too large to be worth keeping as a `properties` value. */
const MAX_PHOTO_BASE64_CHARS = 2_000_000; // ~1.5MB decoded

/**
 * The largest `data:` URI this parser will embed directly into
 * `properties.avatar_url`, in characters.
 *
 * `ci.entities` maintains a functional search index over
 * `to_tsvector('english', ... || properties::text)` (migration
 * 20251203202414_update_search_vector_logic.sql), and Postgres's tsvector
 * representation has a hard 1,048,575-BYTE ceiling — INDEPENDENT of
 * MAX_PHOTO_BASE64_CHARS above, which only bounds the accumulator this parser
 * uses while READING a PHOTO property, not what gets embedded here. A card
 * whose photo falls between the two thresholds passed accumulation fine and
 * then failed the INSERT/UPDATE itself with "string is too long for
 * tsvector", taking the whole upsert BATCH down with it — confirmed against a
 * real 9,911-contact export, where it also cratered push throughput roughly
 * 10x (many-minute retries on the failing batches) for every contact sharing
 * that batch, not just the one with the oversized photo.
 *
 * 700,000 leaves comfortable headroom under the limit for the OTHER fields
 * the same trigger concatenates (name, description, search_content, and the
 * rest of properties), while still embedding the vast majority of real
 * contact photos — a phone-camera headshot's base64 is typically well under
 * 200KB. A photo past this cap is dropped from `avatar_url` entirely rather
 * than truncated: half a base64 image decodes to nothing, so keeping a
 * fragment would be strictly worse than the "no photo" case this already
 * degrades to when a card has none.
 */
const MAX_AVATAR_DATA_URI_CHARS = 700_000;

const PHOTO_TYPE_PARAM = /(?:^|;)TYPE=([A-Za-z0-9.+-]+)/i;
const PHOTO_MIME_BY_TYPE: Record<string, string> = {
  JPEG: 'image/jpeg',
  JPG: 'image/jpeg',
  PNG: 'image/png',
  GIF: 'image/gif',
  WEBP: 'image/webp',
};

/**
 * Each card's base64 PHOTO payload, in file order — a companion pass to
 * {@link unfoldContentLines}, which deliberately discards these same bytes
 * (see its docstring) rather than joining them into its own shared buffer.
 *
 * This pass holds at most ONE card's photo at a time: `BEGIN:VCARD` resets the
 * accumulator, and whatever the matching `END:VCARD` finds becomes the return
 * array's next entry (`undefined` when that card had no PHOTO, the payload was
 * implausibly large, or the card was truncated). It applies the identical
 * BEGIN/END bookkeeping `parseVCards`'s main loop does — a second BEGIN before
 * an END drops the card in progress without emitting, a file that ends mid-card
 * emits nothing for it — so the result lines up 1:1 with the cards
 * {@link unfoldContentLines}'s consumer actually hands to `emitCards`.
 *
 * Line folding only, deliberately not the full tokenizer above: a PHOTO's
 * value is opaque base64, so unlike TEXT properties it needs no CHARSET/
 * QUOTED-PRINTABLE decode or `\;`-unescaping — string concatenation of the
 * folded continuation lines IS the decode.
 */
export function extractCardPhotos(raw: string): (CardPhoto | undefined)[] {
  const photos: (CardPhoto | undefined)[] = [];
  const physical = stripBom(raw).split(/\r\n|\r|\n/);

  let chunks: string[] | null = null;
  let mimeType = '';
  let tooLarge = false;

  const finishCard = () => {
    if (chunks && chunks.length && !tooLarge) {
      const base64 = chunks.join('');

      photos.push(base64 ? { mimeType, base64 } : undefined);
    } else {
      photos.push(undefined);
    }

    chunks = null;
    mimeType = '';
    tooLarge = false;
  };

  for (const line of physical) {
    const trimmed = line.trim();
    if (/^BEGIN:VCARD$/i.test(trimmed)) {
      // A second BEGIN before an END means the previous card was truncated —
      // parseVCards drops it without keeping it for emitCards, so this pass must not
      // push an entry for it either.
      chunks = null;
      mimeType = '';
      tooLarge = false;
      continue;
    }

    if (/^END:VCARD$/i.test(trimmed)) {
      finishCard();
      continue;
    }

    if (chunks !== null && (line.startsWith(' ') || line.startsWith('\t'))) {
      if (!tooLarge) {
        chunks.push(line.slice(1));
        if (chunks.reduce((n, c) => n + c.length, 0) > MAX_PHOTO_BASE64_CHARS) {
          tooLarge = true;
          chunks = [];
        }
      }

      continue;
    }

    // A new (non-continuation) line ends whatever PHOTO was being accumulated,
    // same as unfoldContentLines's tailIsBinary reset.
    chunks = null;

    if (!/^PHOTO;/i.test(line) || !BINARY_PROPERTY_HEAD.test(line)) {
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }

    const head = line.slice(0, colonIdx);
    const typeMatch = PHOTO_TYPE_PARAM.exec(head);
    mimeType = (typeMatch && PHOTO_MIME_BY_TYPE[typeMatch[1].toUpperCase()]) || 'image/jpeg';
    chunks = [line.slice(colonIdx + 1)];
    tooLarge = false;
  }

  // An unterminated final card (no closing END:VCARD) — parseVCards drops it
  // too, via the `if (card) drop('no_end_marker')` after its own loop, and
  // never keeps it for emitCards, so this pass must not push a trailing entry.

  return photos;
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

  if (colon < 0) {
    return null;
  }

  const segments = splitUnquoted(line.slice(0, colon), ';');
  let nameToken = segments[0].trim();
  if (!nameToken) {
    return null;
  }

  let group = '';
  const dot = nameToken.indexOf('.');
  if (dot > 0) {
    group = nameToken.slice(0, dot).trim().toUpperCase();
    nameToken = nameToken.slice(dot + 1).trim();
  }

  const name = nameToken.toUpperCase();
  if (!/^[A-Za-z0-9-]+$/.test(name)) {
    return null;
  }

  const params: Record<string, string[]> = {};
  const addParam = (key: string, value: string) => {
    (params[key] ??= []).push(value);
  };

  for (const segment of segments.slice(1)) {
    const seg = segment.trim();
    if (!seg) {
      continue;
    }

    const eq = seg.indexOf('=');
    if (eq === -1) {
      // vCard 2.1 shorthand: `TEL;CELL;VOICE:` (bare TYPE values) and a bare
      // `;QUOTED-PRINTABLE` transport marker.
      const bare = stripQuotes(seg);
      if (BARE_ENCODINGS.has(bare.toUpperCase())) {
        addParam('ENCODING', bare);
      } else if (bare) {
        addParam('TYPE', bare);
      }

      continue;
    }

    const key = seg.slice(0, eq).trim().toUpperCase();
    for (const v of splitUnquoted(seg.slice(eq + 1), ',')) {
      const value = stripQuotes(v);
      if (value) {
        addParam(key, value);
      }
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
  if (encoding === 'B' || encoding === 'BASE64') {
    return { text: '', binary: true };
  }

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

    for (const b of Buffer.from(ch, 'utf8')) {
      bytes.push(b);
    }
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

/**
 * Each property group's `X-ABLabel`: `item1.X-ABLabel:_$!<School>!$_` names
 * what `item1.EMAIL` is FOR. Both orders occur in real files, so the map is
 * built from the whole card before anything reads it.
 */
function groupLabelsOf(lines: ContentLine[]): Map<string, string> {
  const groupLabels = new Map<string, string>();
  for (const line of lines) {
    if (!line.group || line.binary || line.name !== 'X-ABLABEL') {
      continue;
    }

    const label = cleanLabel(line.value);
    if (label) {
      groupLabels.set(line.group, label);
    }
  }

  return groupLabels;
}

/**
 * The numbers a card files as a FAX, as written: a TEL typed `FAX` in any case,
 * alone or beside WORK/HOME (vCard 2.1's bare `;FAX` lands in TYPE too), or one
 * whose group label says fax — Apple's own `_$!<WorkFAX>!$_` and a custom
 * `X-ABLabel:Office fax` alike.
 *
 * Read by the file-level pass, not by `buildContact`: a fax is office
 * equipment, so every card from one office lists it, and whether a number is a
 * fax is a fact about the NUMBER — true on every card that lists it once any
 * card says so. Real exports type the same number FAX on one copy of a card
 * and leave it untyped on the next.
 */
export function faxNumbersOf(lines: ContentLine[]): string[] {
  const groupLabels = groupLabelsOf(lines);
  const faxes: string[] = [];

  for (const line of lines) {
    if (line.name !== 'TEL' || line.binary) {
      continue;
    }

    const label = line.group ? groupLabels.get(line.group) : undefined;
    const typed = (line.params.TYPE ?? []).some((t) => t.toUpperCase() === 'FAX');

    if (typed || (label != null && /fax/i.test(label))) {
      const value = unescapeVCardText(line.value).trim();
      if (value) {
        faxes.push(value);
      }
    }
  }

  return faxes;
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
  if (grouped) {
    return grouped;
  }

  for (const t of line.params.TYPE ?? []) {
    if (!NON_LABEL_TYPES.has(t.toUpperCase())) {
      return t;
    }
  }

  return undefined;
}

function isPreferred(line: ContentLine): boolean {
  if (line.params.PREF?.length) {
    return true;
  }

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
 * `Emails:` / `PhoneNumbers:` inside a NOTE — the shape the Android and
 * LinkedIn syncs leave behind in an Apple Contacts export.
 *
 * A card that was merged from another address book keeps the source record as
 * free text rather than as properties:
 *
 *     NOTE:Source: MOBILE_CONTACTS\nCompanies: null\nEmails: teo@example.com
 *      \nPhoneNumbers: 518.641.2094\nCreatedAt: 12/16/13\, 2:15 PM\n
 *
 * Those really are the contact's own handles — the export just wrote them in
 * the wrong place. In the developer's 4,927-card archive 682 cards carry an
 * email ONLY there and 369 a phone, and one card carries nothing else at all:
 * no FN, `N:;;;;`, and a NOTE reading `Emails: inversin@d2.com`. That card had
 * neither a name nor a handle to key on, so `PushStage` skipped it with
 * `no stable name or handle to resolve by` and downgraded every single import
 * of that archive to `partial` — one row in 4,040.
 *
 * Recovered per KIND and only as a FALLBACK: a card with structured EMAIL
 * properties keeps exactly those, because a note is a historical record and the
 * property list is the current one. This adds what would otherwise be lost; it
 * never augments what the card already states.
 */
const NOTE_EMAIL_KEY = /^\s*e-?mails?\s*:\s*(.*)$/i;
const NOTE_PHONE_KEY = /^\s*(?:phone\s?numbers?|phones?|tels?)\s*:\s*(.*)$/i;

/**
 * A value worth promoting to an `identity: true` attribute.
 *
 * `Companies: null` shows the export writes the literal string `null` for an
 * absent field, so the shape has to be checked rather than the emptiness. The
 * phone floor is seven digits because that is where `normalizeHandle`
 * (staging/identity.ts) stops producing a key — anything shorter would become
 * an attribute that looks like an identity and resolves to nothing.
 */
const NOTE_EMAIL_VALUE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const MIN_PHONE_DIGITS = 7;

/**
 * Handles recovered from a card's note text. Values are returned as written —
 * normalization is `staging/identity.ts`'s job, and the same rules have to
 * apply to a recovered handle as to a structured one.
 */
export function handlesFromNote(note: string): { emails: string[]; phones: string[] } {
  const emails: string[] = [];
  const phones: string[] = [];

  for (const line of note.split('\n')) {
    const email = NOTE_EMAIL_KEY.exec(line);

    if (email) {
      for (const value of email[1].split(',')) {
        const trimmed = value.trim();
        if (NOTE_EMAIL_VALUE.test(trimmed)) {
          emails.push(trimmed);
        }
      }

      continue;
    }

    const phone = NOTE_PHONE_KEY.exec(line);

    if (phone) {
      for (const value of phone[1].split(',')) {
        const trimmed = value.trim();
        if (trimmed.replace(/\D/g, '').length >= MIN_PHONE_DIGITS) {
          phones.push(trimmed);
        }
      }
    }
  }

  return { emails: uniq(emails), phones: uniq(phones) };
}

/**
 * X-SOCIALPROFILE services whose profile URLs have a known shape: the domain a
 * real profile lives on, and the URL Apple itself writes for an `x-user` handle
 * (`X-SOCIALPROFILE;type=linkedin;x-user=jdoe:https\://www.linkedin.com/in/jdoe`).
 * Keyed on the lowercased TYPE / X-SERVICE-TYPE / X-ABLabel.
 */
const SOCIAL_PROFILE_SERVICES: Record<string, { domain: string; profileUrl: (user: string) => string }> = {
  linkedin: { domain: 'linkedin.com', profileUrl: (user) => `https://www.linkedin.com/in/${user}` },
  twitter: { domain: 'twitter.com', profileUrl: (user) => `https://twitter.com/${user}` },
  facebook: { domain: 'facebook.com', profileUrl: (user) => `https://www.facebook.com/${user}` },
};

/**
 * A character that continues a host label or a path segment. A URL that extends
 * a value with one of these means the value was cut mid-token; one that extends
 * it with `/` is a different, longer page on a value that was already whole.
 */
const URL_TOKEN_CHAR = /[A-Za-z0-9_%-]/;

/** The http(s) URLs written inside free text, trailing sentence punctuation removed. */
function urlsInText(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"]+/gi)].map((m) => m[0].replace(/[.,;:!?)\]]+$/, ''));
}

/**
 * The comparable form of a URL: lowercased, scheme removed. A value that is
 * nothing but a (possibly partial) scheme — `https:`, `https:/` — keys as ''.
 */
function urlKey(url: string): string {
  const lower = url.trim().toLowerCase();
  if ('https://'.startsWith(lower) || 'http://'.startsWith(lower)) {
    return '';
  }

  return lower.replace(/^https?:\/\//, '');
}

function isOnDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase();

    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * True when `value` stops before a profile could begin: it is a prefix of the
 * service's own profile URL with no handle (`https://www.linkedin.com/in/`), so
 * it names the service and nothing else. Covers a cut anywhere in the scheme,
 * the host or the fixed path.
 */
function isTruncatedProfileUrl(value: string, service: { profileUrl: (user: string) => string }): boolean {
  const key = urlKey(value);
  const base = urlKey(service.profileUrl(''));

  return base.startsWith(key) || base.replace(/^www\./, '').startsWith(key);
}

/**
 * The profile an IMPP / X-SOCIALPROFILE line names, or '' when it names none.
 *
 * The developer's real 78 MB Contacts export holds 576 X-SOCIALPROFILE lines.
 * 552 are `type=linkedin`, written by a LinkedIn sync, and NOT ONE of those
 * holds a complete URL. The physical line stops, almost always at exactly
 * 74 bytes, and the next line is an ordinary property (529 times the card's
 * NOTE), never a ` `-prefixed continuation. So the rest of the URL is not in the
 * file at all, and no unfold rule can recover it: an RFC 6350 fold of the same
 * line unfolds fine (see the tests). An `x-displayname=<name>` parameter sits
 * ahead of the value, so the cut lands at a different point on every card:
 * `https://www.lin`, `https://www.linked`, `https://www.`. Every one of them was
 * stored as a profile.
 *
 * So for a service whose URLs have a known shape, a value that is cut short is
 * repaired, in order:
 *   1. from the line's own `x-user` handle, which Apple writes beside the URL;
 *   2. from the one URL on the same card, in a URL property or in the NOTE (the
 *      LinkedIn sync's `URL: …\nPosition: …` record, see the header), that is
 *      on the service's domain and that the value is a prefix of.
 * A value still unresolved after that is dropped, not stored: a fragment that
 * looks like a link but resolves nowhere is worse than no link.
 *
 * "Cut short" means either the value carries no handle at all (see
 * isTruncatedProfileUrl), or a longer URL from 1/2 continues it mid-token: a
 * value that ends inside a slug (`/in/some-inv`) looks whole on its own.
 *
 * An unknown service, and every IMPP line (`xmpp:` / `aim:` handles, not
 * pages), keeps its value exactly as written. When that value is empty, the
 * `x-user` handle stands in for it.
 */
function resolveSocialProfile(line: ContentLine, service: string | undefined, cardUrls: string[]): string {
  const value = unescapeVCardText(line.value).trim();
  const user = line.params['X-USER']?.[0]?.trim() ?? '';
  const known =
    line.name === 'X-SOCIALPROFILE'
      ? [service, ...(line.params.TYPE ?? []), ...(line.params['X-SERVICE-TYPE'] ?? [])]
          .map((key) => (key ? SOCIAL_PROFILE_SERVICES[key.toLowerCase()] : undefined))
          .find(Boolean)
      : undefined;

  if (!known) {
    return value || user;
  }

  const truncated = isTruncatedProfileUrl(value, known);
  const key = urlKey(value);
  const continues = (url: string): boolean => {
    const k = urlKey(url);

    return (
      k.length > key.length &&
      k.startsWith(key) &&
      (truncated || URL_TOKEN_CHAR.test(k[key.length])) &&
      isOnDomain(url, known.domain) &&
      !isTruncatedProfileUrl(url, known)
    );
  };

  const own = user ? known.profileUrl(user) : '';
  if (own && continues(own)) {
    return own;
  }

  // Keyed on urlKey so `http://` and `https://` spellings of one page count
  // once; the first spelling wins, and URL properties come before the NOTE's.
  const onCard = new Map<string, string>();
  for (const url of cardUrls.filter(continues)) {
    if (!onCard.has(urlKey(url))) {
      onCard.set(urlKey(url), url);
    }
  }

  if (onCard.size === 1) {
    return [...onCard.values()][0];
  }

  return truncated ? '' : value;
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
export function buildContact(lines: ContentLine[], file: string, photo?: CardPhoto): BuiltContact | null {
  // Labels first: `item1.X-ABLabel` names what `item1.EMAIL` is FOR, and both
  // orders occur in real files, so the map must be complete before it is read.
  const groupLabels = groupLabelsOf(lines);

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
  const pendingSocials: { line: ContentLine; service?: string }[] = [];
  let fn = '';
  let structuredName = '';
  let birthday = '';
  let uid = '';
  let avatarUrl = '';

  for (const line of lines) {
    if (line.binary) {
      continue;
    }

    const label = labelFor(line, groupLabels);
    const labelled = label ? { label } : {};
    const preferred = isPreferred(line) ? { pref: true } : {};
    const text = () => unescapeVCardText(line.value).trim();

    switch (line.name) {
      case 'FN':
        if (!fn) {
          fn = text();
        }

        break;
      case 'N':
        if (!structuredName) {
          structuredName = nameFromN(line.value);
        }

        break;
      case 'TEL': {
        const v = text();
        if (!v) {
          break;
        }

        phones.push(v);
        attributes.push({ name: 'phone', value: v, identity: true, ...labelled, ...preferred });
        break;
      }

      case 'EMAIL': {
        const v = text();
        if (!v) {
          break;
        }

        emails.push(v);
        attributes.push({ name: 'email', value: v, identity: true, ...labelled, ...preferred });
        break;
      }

      case 'URL': {
        const v = text();
        if (!v) {
          break;
        }

        urls.push(v);
        attributes.push({ name: 'url', value: v, ...labelled });
        break;
      }

      case 'PHOTO': {
        // Reaching the switch at all means `decodeTransport` already found no
        // ENCODING=B/BASE64 param (those lines are `line.binary` and skipped
        // above, at `unfoldContentLines`'s cost of discarding the base64 rather
        // than holding a whole address book's photos in memory twice — see its
        // docstring). What's left is `PHOTO;VALUE=URI:https://…`, which some
        // exports (Exchange/Outlook, some CRMs) use instead of embedding bytes —
        // a plain URL, exactly as cheap to carry as EMAIL/URL above.
        const v = text();
        if (!avatarUrl && /^https?:\/\//i.test(v)) {
          avatarUrl = v;
        }

        break;
      }

      case 'ORG': {
        // ORG is structured (org;unit;unit…) and Apple writes the trailing `;`.
        const v = splitStructured(line.value, ';').filter(Boolean).join(' — ');
        if (!v) {
          break;
        }

        orgs.push(v);
        attributes.push({ name: 'organization', value: v });
        break;
      }

      case 'TITLE':
      case 'ROLE': {
        const v = text();
        if (!v) {
          break;
        }

        titles.push(v);
        attributes.push({ name: 'job_title', value: v });
        break;
      }

      case 'ADR': {
        const v = formatAddress(line.value);
        if (!v) {
          break;
        }

        addresses.push(v);
        attributes.push({ name: 'address', value: v, ...labelled });
        break;
      }

      case 'NOTE': {
        const v = text();
        if (!v) {
          break;
        }

        notes.push(v);
        attributes.push({ name: 'note', value: v });
        break;
      }

      case 'NICKNAME': {
        const v = text();
        if (!v) {
          break;
        }

        nicknames.push(v);
        attributes.push({ name: 'nickname', value: v });
        break;
      }

      case 'BDAY':
        // BDAY is a DATE(-TIME) value, not TEXT — no backslash escaping applies.
        if (!birthday) {
          birthday = line.value.trim();
        }

        break;
      case 'CATEGORIES':
        // Google Takeout writes one .vcf per label and repeats the label set
        // here; it is the only record of which groups a contact belongs to.
        for (const c of splitStructured(line.value, ',')) {
          if (c) {
            categories.push(c);
          }
        }

        break;
      case 'IMPP':
      case 'X-SOCIALPROFILE':
        // Resolved after the loop, not here: repairing a truncated profile URL
        // reads the card's URL and NOTE values, and a real export writes the
        // NOTE after this line. See resolveSocialProfile.
        pendingSocials.push({ line, service: line.params['X-SERVICE-TYPE']?.[0] ?? label });
        break;
      case 'UID':
        if (!uid) {
          uid = text();
        }

        break;
      default:
        break;
    }
  }

  const cardUrls = [...urls, ...notes.flatMap(urlsInText)];
  for (const { line, service } of pendingSocials) {
    const v = resolveSocialProfile(line, service, cardUrls);
    if (!v) {
      continue;
    }

    socials.push(service ? `${service}: ${v}` : v);
    attributes.push({ name: 'social_profile', value: v, ...(service ? { label: service } : {}) });
  }

  if (birthday) {
    attributes.push({ name: 'birth_date', value: birthday });
  }

  // The card's own note, read as the record it is. See handlesFromNote: an
  // export that merged another address book writes that address book's emails
  // and phones into NOTE instead of into properties, and a card whose ONLY
  // content is such a note has nothing for entity resolution to key on at all.
  // Per kind and fallback-only — structured properties always win.
  if (notes.length > 0 && (emails.length === 0 || phones.length === 0)) {
    const recovered = handlesFromNote(notes.join('\n'));

    if (emails.length === 0) {
      for (const value of recovered.emails) {
        emails.push(value);
        attributes.push({ name: 'email', value, identity: true });
      }
    }

    if (phones.length === 0) {
      for (const value of recovered.phones) {
        phones.push(value);
        attributes.push({ name: 'phone', value, identity: true });
      }
    }
  }

  const name = fn || structuredName;
  if (!name && attributes.length === 0) {
    return null;
  }

  // The URI form (PHOTO case above) wins when a card somehow carries both — it
  // costs nothing to fetch until something actually renders it, where a data:
  // URI is bytes the moment this row is written. Most real exports (Apple/
  // Google/Android Contacts) only ever embed base64, so this is the common case.
  if (!avatarUrl && photo && /^[A-Za-z0-9+/=\s]+$/.test(photo.base64)) {
    const dataUri = `data:${photo.mimeType};base64,${photo.base64.replace(/\s+/g, '')}`;

    if (dataUri.length <= MAX_AVATAR_DATA_URI_CHARS) {
      avatarUrl = dataUri;
    }
  }

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
    // A vCard IS a contact card, so say so here rather than leaving it to
    // `resolveEntityType`, whose `hasContactIdentity` fallback only infers
    // 'contact' from a phone/email ATTRIBUTE. Most cards in a real export
    // carry neither -- 4,926 of them in one Google Takeout `.vcf` listed a
    // name and a LinkedIn URL and nothing else -- so they resolved to a null
    // type and `entityTypeFor` filed them as `Concept`: 1,777 pseudo-concepts
    // duplicating a Person of the same name. The type is a fact about the
    // FORMAT, not about which optional properties a given card happens to fill.
    type: 'contact',
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
      // Lowercase, unlike every other key here: this exact key is the contract
      // `push/entities.ts` spreads straight into `ci.entities.properties`, and
      // `PersonType.avatarUrl` (backend/.../types/PersonType.ts) reads it back
      // as `properties.avatar_url`.
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
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
      if (line.binary) {
        continue;
      }

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
