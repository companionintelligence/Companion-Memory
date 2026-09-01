/**
 * Identity and content hashing for staged rows.
 *
 * Ported from CI-Import-Tools' `persistence.ts`, unchanged in behaviour and
 * separated out because all of it is pure: these functions decide what collapses
 * into what, which is the part of staging worth testing directly rather than
 * through a database.
 */
import { createHash } from 'node:crypto';

import type { Entity, Item, Metadata } from '../datasources/timeline';

const PHONE_ATTR_NAMES = new Set(['phone', 'tel', 'mobile', 'cell', 'sms']);
const EMAIL_ATTR_NAMES = new Set(['email', 'mail', 'e-mail']);

function looksLikeHandle(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.includes('@')) {
    return true;
  }

  return trimmed.replace(/\D/g, '').length >= 7;
}

/**
 * Normalize a handle to a comparable key: lower-cased email, or the last ten
 * digits of a phone number. Returns '' for anything that is neither an email nor
 * a long-enough phone (a bare name).
 *
 * The last-ten-digits rule is what makes `+1 (555) 010-9999`, `555-010-9999` and
 * `15550109999` one person rather than three.
 */
export function normalizeHandle(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.includes('@')) {
    return trimmed.toLowerCase();
  }

  const digits = trimmed.replace(/\D/g, '');

  return digits.length >= 7 ? digits.slice(-10) : '';
}

/**
 * A value made of nothing but digits and the punctuation phone numbers are
 * written with. Used to tell a phone FIELD from a name that happens to contain
 * a digit, before asking how long the number is.
 */
const PHONE_SHAPED = /^[+()\-./\s\d]+$/;

/**
 * True when a phone-shaped value is an SMS SHORT CODE — the three-to-six digit
 * number a service texts from ("411", "32665", "227898", "+411") rather than a
 * line a person can be reached on.
 *
 * Defined as "phone-shaped, but too short for {@link normalizeHandle} to key
 * on" rather than by a digit count of its own, so there is exactly ONE
 * threshold in the file. If that threshold ever moves, a number stops being a
 * short code on precisely the day it starts being a handle, instead of leaving
 * a band that is neither.
 *
 * A value carrying no digits is a NAME, not a short number, and is not a short
 * code: the distinction drawn here is between two kinds of phone. An email is
 * excluded for the same reason — `normalizeHandle` keys it, so it is a handle.
 */
export function isShortCode(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();

  if (!PHONE_SHAPED.test(trimmed)) {
    return false;
  }

  return trimmed.replace(/\D/g, '').length > 0 && normalizeHandle(trimmed) === '';
}

/**
 * The staged `type` a datasource declares for a handle that IS a reachable
 * line, and the one it declares for a value {@link isShortCode} recognises.
 *
 * Named here rather than repeated as literals because the two of them are the
 * two ends of one decision, and because the pair is now read from outside
 * staging: `EntityTypeAuditCron` re-runs {@link isShortCode} over rows already
 * in `ci.entities` and has to reconstruct the key each type would have produced
 * — see {@link stagedNaturalKey}.
 */
export const CONTACT_STAGED_TYPE = 'contact';
export const SHORT_CODE_STAGED_TYPE = 'short_code';

/**
 * The staged `type` for an entity {@link resolveEntityType} recognises as an
 * organizational mailbox rather than a named person — see
 * {@link isOrganizationalAddress}. Not in `push/entities.ts` `ENTITY_TYPES`,
 * so it falls through to `Concept` there like any other type the map does not
 * know, the same way `email_thread` does for its own (excluded) reason.
 */
export const ORGANIZATIONAL_STAGED_TYPE = 'organization';

/**
 * Local-parts that are never a specific person's mailbox, whatever the
 * domain — a parent company's support desk mails from a different domain
 * than the brand a user actually deals with, so matching on the sender's
 * domain alone would miss it. Mirrors the shape of the same discovery in
 * wslyvh/paperweight's `role-mailboxes.ts`.
 *
 * A missing entry here is a safe miss: the sender still becomes a `Person`,
 * as it always has. A wrong entry misfiles a real 1:1 correspondent as a
 * `Concept` instead — not data loss (the communication itself, and its
 * participant edge, are untouched either way), just a milder cost than the
 * unbounded list this stays deliberately smaller than.
 */
const ORGANIZATIONAL_LOCAL_PARTS = new Set([
  'info',
  'support',
  'service',
  'shop',
  'sales',
  'contact',
  'hello',
  'office',
  'admin',
  'billing',
  'help',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notification',
  'notifications',
  'newsletter',
  'news',
  'press',
  'jobs',
  'privacy',
  'security',
  'marketing',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
]);

// RFC 2606 / RFC 6761 non-routable TLDs, plus the conventional corporate
// ones: mail infrastructure leaks machine addresses at these, so a mailbox
// there is a server, not a person. `.example` is deliberately excluded — RFC
// 2606 reserves it for documentation, which is exactly what this file's own
// synthetic fixtures use, and listing it would misfile every one of them.
const NON_ROUTABLE_TLDS = new Set(['intern', 'internal', 'local', 'lan', 'test', 'invalid', 'localhost']);

/**
 * True for an email address that is never a specific person's own mailbox: a
 * role inbox (`support@`, `noreply@`, …) at any domain, or an address on a
 * non-routable/internal TLD. A plus-suffix never changes the verdict —
 * `support+ticket123@` is still support.
 */
export function isOrganizationalAddress(email: string): boolean {
  const at = email.lastIndexOf('@');

  if (at === -1) {
    return false;
  }

  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  const base = local.split('+')[0] ?? '';

  if (ORGANIZATIONAL_LOCAL_PARTS.has(base)) {
    return true;
  }

  const tld = domain.split('.').pop() ?? '';

  return NON_ROUTABLE_TLDS.has(tld);
}

/**
 * The natural key a staged entity resolves under: its type, then the handle it
 * keys on, or its trimmed lower-cased name when it has none.
 *
 * `push/entities.ts naturalKeyFor` is the caller that has a staged ROW; this is
 * the same string built from the three fields it reads, split out because the
 * type audit has a `ci.entities` row instead and must be able to compute the
 * coordinate a DIFFERENT staged type would have produced without fabricating a
 * staged row to ask with.
 *
 * The type is part of the key, and that is the whole reason retyping is not a
 * one-column UPDATE: change the type and the key moves, so the next import
 * resolves nothing and mints a duplicate.
 */
export function stagedNaturalKey(
  stagedType: string | null | undefined,
  handle: string | null | undefined,
  name: string | null | undefined,
): string | null {
  const trimmedHandle = handle?.trim();

  if (trimmedHandle) {
    return `${stagedType ?? 'entity'}:${trimmedHandle}`;
  }

  const trimmedName = name?.trim().toLowerCase();

  return trimmedName ? `${stagedType ?? 'entity'}:${trimmedName}` : null;
}

/**
 * The normalized identity handles an entity carries — drawn from exactly the
 * attributes {@link hasContactIdentity} treats as a contact signal. Kept in
 * lockstep with it so every entity that resolves to 'contact' via an identity
 * also produces a key.
 */
function identityHandles(entity: Entity): string[] {
  const out: string[] = [];

  for (const attribute of entity.attributes ?? []) {
    const name = (attribute?.name ?? '').toLowerCase();
    const named =
      PHONE_ATTR_NAMES.has(name) ||
      EMAIL_ATTR_NAMES.has(name) ||
      name.includes('phone') ||
      name.includes('email') ||
      name.includes('tel');

    if ((named || attribute?.identity) && looksLikeHandle(attribute.value)) {
      const handle = normalizeHandle(attribute.value);

      if (handle) {
        out.push(handle);
      }
    }
  }

  return out;
}

/**
 * A stable identity key for an entity: its lexicographically-smallest normalized
 * handle, or null when it carries none.
 *
 * Sorting makes the key independent of attribute order, so one real person
 * always keys the same way regardless of which message field (from/to/cc) or
 * which source surfaced them. This — not the mutable display name — is what
 * contacts dedup on.
 */
export function entityIdentityKey(entity: Entity): string | null {
  const handles = identityHandles(entity);

  if (!handles.length) {
    return null;
  }

  handles.sort();

  return handles[0];
}

/**
 * True when an entity carries a phone/email identity — i.e. it is really a
 * person even when the datasource forgot to set `type`.
 */
export function hasContactIdentity(entity: Entity): boolean {
  for (const attribute of entity.attributes ?? []) {
    const name = (attribute?.name ?? '').toLowerCase();

    if (
      PHONE_ATTR_NAMES.has(name) ||
      EMAIL_ATTR_NAMES.has(name) ||
      name.includes('phone') ||
      name.includes('email') ||
      name.includes('tel')
    ) {
      if (looksLikeHandle(attribute.value)) {
        return true;
      }
    }

    // Some sources tag an attribute as an identity without a recognisable name
    // (apple_contacts emits `{ name: '', value: '+1…', identity: true }`).
    if (attribute?.identity && looksLikeHandle(attribute.value)) {
      return true;
    }
  }

  return false;
}

/**
 * True when every identity handle this entity carries (see
 * {@link identityHandles}) is an organizational email — {@link
 * isOrganizationalAddress} — with no phone and no personal-looking email
 * alongside it. A mixed entity (a role mailbox found next to a real phone) is
 * left alone: the other identity is still a real way to reach a person.
 */
function hasOnlyOrganizationalIdentity(entity: Entity): boolean {
  const handles = identityHandles(entity);

  return (
    handles.length > 0 && handles.every((handle) => handle.includes('@') && isOrganizationalAddress(handle))
  );
}

/**
 * Resolve the staged `type` for an entity.
 *
 * Datasources that only know they captured a person's handle (gmail, telegram,
 * …) omit `type`; those default to 'contact' so they do not land as null rows
 * the push then mis-maps — UNLESS the only identity on offer is an
 * organizational mailbox ({@link hasOnlyOrganizationalIdentity}), in which case
 * it defaults to {@link ORGANIZATIONAL_STAGED_TYPE} instead: `noreply@stripe.com`
 * is a real, reachable address, but it is not a named person's address book
 * entry. Entities with no contact identity keep their (possibly null) type
 * untouched.
 *
 * ## This is a handle-based default, NOT a source-based one
 *
 * The distinction matters, and reading it the other way cost one address book.
 * The only person signal here is {@link hasContactIdentity} — an attribute that
 * looks like a phone or an email. It cannot rescue an entity that IS a person but
 * carries no way to reach them: a vCard with just a name, a LinkedIn connection
 * whose export withheld the address. Those fell through to `type = null` and were
 * filed as `Concept` by `entityTypeFor` (push/entities.ts) — 2,247 rows from one
 * `.vcf` on a live appliance, 1,779 of them duplicating a real `Person`.
 *
 * A datasource that knows what it parsed must therefore SET `type` itself rather
 * than rely on this default, as vcard.ts, contactlist.ts, applecontacts.ts and
 * linkedin.ts all now do. An earlier revision of this comment named vcard among
 * the sources this default covered, and that claim is exactly the belief that let
 * the bug sit — the type is a fact about the FORMAT, not about which optional
 * fields a given record happens to fill.
 */
export function resolveEntityType(entity: Entity): string | null {
  if (entity.type && entity.type.trim()) {
    return entity.type;
  }

  // hasOnlyOrganizationalIdentity implies hasContactIdentity (both walk the
  // same qualifying attributes), so it is checked first rather than gated
  // behind a redundant call.
  if (hasOnlyOrganizationalIdentity(entity)) {
    return ORGANIZATIONAL_STAGED_TYPE;
  }

  if (hasContactIdentity(entity)) {
    return 'contact';
  }

  return entity.type ?? null;
}

export function dateToIso(value: Date | undefined): string | null {
  if (!value) {
    return null;
  }

  const time = value.getTime();

  return Number.isFinite(time) ? value.toISOString() : null;
}

/**
 * True when {@link hashItem}'s fallback has nothing but the item's BASENAME to
 * go on — no parser id, no timestamp, no coordinates.
 *
 * The degenerate case, and it is not rare: 99.8% of a real 462k-record run's
 * `generic` rows carried no timestamp, and 24 parsers assign no `item.id` at
 * all. Every such item under one data source whose filename repeats —
 * `note.txt`, `message_1.json`, `IMG_0001.JPG` — hashes identically and all but
 * the first is swallowed by the `ON CONFLICT DO NOTHING` in `StagedWriter`.
 *
 * Exported so the writer knows which items are worth reading off disk to
 * fingerprint: hashing every file in a 12GB export to disambiguate the handful
 * that need it would cost the whole import.
 */
export function needsContentDigest(item: Item): boolean {
  if (item.id) {
    return false;
  }

  if (dateToIso(item.timestamp) != null) {
    return false;
  }

  return !(item.location?.latitude != null && item.location?.longitude != null);
}

/**
 * The discriminator folded into a degenerate item's hash, strongest first.
 *
 * Order is the whole design. A CONTENT digest is preferred over the path
 * because it keeps the album-replication collapse working for items that have
 * no timestamp either: two copies of one photo under `European Vacation/` and
 * `Photos from 2012/` have identical bytes, so they still hash to one row. The
 * path is the fallback for a record whose bytes we could not read, and the
 * metadata digest the fallback for a record that has no bytes at all (a note
 * parsed out of a JSON blob). An item with none of the three is genuinely
 * indistinguishable from its twin and collapses as before.
 */
function degenerateDiscriminator(item: Item, contentDigest: string | null | undefined): string {
  if (contentDigest) {
    return `sha256:${contentDigest}`;
  }

  if (item.intermediateLocation) {
    return `path:${item.intermediateLocation}`;
  }

  if (item.originalLocation) {
    return `origin:${item.originalLocation}`;
  }

  const metadata = item.metadata == null ? '' : JSON.stringify(item.metadata);

  return metadata && metadata !== '{}' ? `meta:${metadata}` : '';
}

/**
 * Stable hash for an item: an explicit parser id when there is one, otherwise a
 * sha1 over fields that describe the CONTENT.
 *
 * `intermediateLocation` is INTENTIONALLY EXCLUDED from the ordinary fallback.
 * Google Photos Takeout replicates the same photo into every album folder it
 * belongs to; with the file path in the hash, `IMAG0262.jpg` under
 * `European Vacation/` and the identical file under `Photos from 2012/` hash
 * differently and stage as two items — and then reach ci.* as two events.
 * Hashing only content-derived fields collapses them on
 * `staged_items_run_source_hash_uniq`, which is the whole reason that index
 * exists.
 *
 * The exception is the degenerate case {@link needsContentDigest} names, where
 * excluding everything positional leaves `sha1(source, classification,
 * basename)` — a key so coarse that two unrelated files called `note.txt` in
 * two different threads collapse and one of them is DELETED with the scratch
 * tree, recorded nowhere but an `itemsDeduped` counter. There the caller's
 * `contentDigest` (or, failing that, the path) is folded in, which separates
 * genuinely different bytes while still collapsing identical ones.
 */
export function hashItem(item: Item, dataSource: string, contentDigest?: string | null): string {
  if (item.id) {
    return item.id;
  }

  const hash = createHash('sha1');

  hash.update(dataSource);
  hash.update('\0');
  hash.update(item.classification ?? '');
  hash.update('\0');
  hash.update(item.content?.filename ?? '');
  hash.update('\0');
  hash.update(dateToIso(item.timestamp) ?? '');
  hash.update('\0');

  if (item.location?.latitude != null && item.location?.longitude != null) {
    hash.update(`${item.location.latitude},${item.location.longitude}`);

    return hash.digest('hex');
  }

  if (needsContentDigest(item)) {
    hash.update('\0');
    hash.update(degenerateDiscriminator(item, contentDigest));
  }

  return hash.digest('hex');
}

/**
 * Stable key for an entity for WITHIN-RUN dedup.
 *
 * Contacts key on their identity handle, so display-name drift inside one run —
 * "Alice", "Alice Smith" and the bare address for one real person — collapses to
 * a single row. Entities without a handle (email threads, places) fall back to
 * the RESOLVED type + name + attributes tuple, so a type-less contact and a
 * freshly-defaulted 'contact' still collapse.
 */
export function entityKey(entity: Entity): string {
  const identity = entityIdentityKey(entity);

  if (identity) {
    return `id:${identity}`;
  }

  return [resolveEntityType(entity) ?? '', entity.name ?? '', JSON.stringify(entity.attributes ?? [])].join(
    '|',
  );
}

// ---------------------------------------------------------------------------
// Accumulating metadata
// ---------------------------------------------------------------------------

function accumulatedValues(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  const out: unknown[] = [];

  for (const entry of Array.isArray(value) ? value : [value]) {
    if (entry === undefined || entry === null || entry === '') {
      continue;
    }

    if (entry instanceof Date) {
      out.push(entry.toISOString());
    } else if (typeof entry === 'object') {
      out.push(entry);
    } else {
      out.push(String(entry));
    }
  }

  return out;
}

/**
 * An entry's identity for the append-only-if-new check. Objects compare by
 * CONTENT with keys in sorted order, so re-importing the same record — where the
 * source may well build the object's keys in a different order — appends
 * nothing. Scalars compare as their string form, which is how they are stored.
 */
function accumulationKey(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value, (_key, entry) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const sorted: Record<string, unknown> = {};

        for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
          sorted[key] = (entry as Record<string, unknown>)[key];
        }

        return sorted;
      }

      return entry;
    });
  }

  return String(value);
}

/**
 * Grow stored metadata with whatever this sighting adds, for the keys the entity
 * declared as accumulating.
 *
 * Values are appended only when new, so the same dish re-imported at the same
 * price is a no-op and the list stays a set in first-seen order. Only the
 * declared keys are touched: a re-import must not let a drifting display name or
 * a source's second-best guess overwrite what is already stored.
 *
 * Returns null when nothing grew, which is the signal not to write — and not to
 * set `graph_dirty`, which exists to make the push revisit a row that changed
 * after it was already sent.
 */
export function mergeAccumulatedMetadata(
  stored: Record<string, unknown>,
  entity: Entity,
): Record<string, unknown> | null {
  if (!entity.accumulate?.length || !entity.metadata) {
    return null;
  }

  const next = { ...stored };
  let grew = false;

  for (const key of entity.accumulate) {
    const incoming = accumulatedValues((entity.metadata as Metadata)[key]);

    if (!incoming.length) {
      continue;
    }

    const merged = accumulatedValues(next[key]);
    const seen = new Set(merged.map(accumulationKey));
    let added = false;

    for (const value of incoming) {
      const key_ = accumulationKey(value);

      if (seen.has(key_)) {
        continue;
      }

      seen.add(key_);
      merged.push(value);
      added = true;
    }

    if (!added) {
      continue;
    }

    next[key] = merged;
    grew = true;
  }

  return grew ? next : null;
}
