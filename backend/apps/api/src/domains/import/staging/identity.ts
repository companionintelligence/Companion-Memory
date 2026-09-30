/**
 * Identity and content hashing for staged rows.
 *
 * Ported from CI-Import-Tools' `persistence.ts` and separated out because all of
 * it is pure: these functions decide what collapses into what, which is the part
 * of staging worth testing directly rather than through a database.
 */
import { createHash } from 'node:crypto';

import { hasPhoneExtension, normalizeEmail } from '@ci/domains/graph';
import { tokenizePersonName } from '@ci/domains/memory';

import type { Entity, EntityAttribute, Item, Metadata } from '../datasources/timeline';

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
 * True for an attribute that carries a handle: one named like a phone or email
 * field, or one a source tagged `identity` without a recognisable name
 * (apple_contacts emits `{ name: '', value: '+1…', identity: true }`) — and in
 * either case holding a value that looks like a handle.
 *
 * The single definition behind both {@link identityHandles} and
 * {@link hasContactIdentity}, so an entity typed 'contact' because of a handle
 * is always an entity with that handle to key on.
 */
function isHandleAttribute(attribute: EntityAttribute | null | undefined): attribute is EntityAttribute {
  const name = (attribute?.name ?? '').toLowerCase();
  const named =
    PHONE_ATTR_NAMES.has(name) ||
    EMAIL_ATTR_NAMES.has(name) ||
    name.includes('phone') ||
    name.includes('email') ||
    name.includes('tel');

  return (named || Boolean(attribute?.identity)) && looksLikeHandle(attribute?.value);
}

/**
 * The normalized identity handles an entity carries, in attribute order — every
 * one of them, or only the entity's OWN when `withShared` is false (see
 * {@link EntityAttribute.shared}). When `withNew` is false it also leaves out
 * the ones its parser has read only since the legacy key (see
 * {@link EntityAttribute.newSinceLegacyKey}).
 */
function identityHandles(
  entity: Entity,
  { withShared, withNew = true }: { withShared: boolean; withNew?: boolean },
): string[] {
  const out: string[] = [];

  for (const attribute of entity.attributes ?? []) {
    if (
      !isHandleAttribute(attribute) ||
      (attribute.shared === true && !withShared) ||
      (attribute.newSinceLegacyKey === true && !withNew)
    ) {
      continue;
    }

    const handle = normalizeHandle(attribute.value);

    if (handle) {
      out.push(handle);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Contact identifiers — every method a contact states, for the identity index
// ---------------------------------------------------------------------------

/**
 * The attribute name a parser gives a number the CARD itself files as a FAX
 * line — the vCard parser's `TEL;TYPE=FAX`. Never a person's own contact
 * method: one office's fax is on every card from that office. Still an
 * identity handle (flagged `identity`), so {@link legacyEntityIdentityKey}
 * finds the row an older import keyed on it; the file-level pass marks it
 * {@link EntityAttribute.shared}, so it never keys the card now.
 */
export const FAX_ATTRIBUTE_NAME = 'fax';

/**
 * The staged-metadata keys {@link contactIdentifiers} are recorded under —
 * the same keys `GraphIngestService` indexes into `ci.entity_identifiers` and
 * `enrich.person_self_claim` turns into claims once they reach
 * `ci.entities.properties`. Always accumulated across sightings.
 */
export const CONTACT_IDENTIFIER_KEYS = ['emails', 'phones'] as const;

/**
 * The staged-metadata key that records the display name of EVERY sighting of a
 * contact, accumulated like {@link CONTACT_IDENTIFIER_KEYS}. Staging-only: the
 * push reads it and strips it (`push/entities.ts`).
 *
 * Needed because staging collapses sightings on their identity key, and not
 * every collapse is one person. #2795 deliberately keeps a household together
 * ("Ana Ruiz" and "Luis Ruiz" on one home line: a shared surname cannot be told
 * from a nickname or a typo), so both cards stage as ONE row and its
 * accumulated `emails` hold both people's. The row's own `name` is only the
 * first sighting's, so this is the only record that the row is several people,
 * and the push indexes nothing but its handle for such a row.
 */
export const CONTACT_NAMES_KEY = 'contactNames';

/**
 * Google's contacts CSV joins every value of one label into one cell
 * ("a@example.com ::: b@example.org"); read whole, it is neither an address nor
 * a number.
 */
const JOINED_VALUES = /\s*:::\s*/;

/** Staged types that become a `Person` at push — the only ones given contact identifiers. */
const PERSON_STAGED_TYPES: ReadonlySet<string> = new Set([CONTACT_STAGED_TYPE, 'person']);

/** Whether the entity will be a `Person` — `push/entities.ts` lower-cases the staged type the same way. */
function becomesPerson(entity: Entity): boolean {
  const type = resolveEntityType(entity);

  return type != null && PERSON_STAGED_TYPES.has(type.trim().toLowerCase());
}

/** What a phone value is written with, once a `tel:` URI scheme is stripped. */
const PHONE_VALUE_SHAPE = /^\+?[\d\s().\-/]+$/;

/** A mailbox, once normalized: something@domain.tld with no spaces. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every email and phone a contact states as its OWN, normalized the way the
 * identity index keys them (a mailbox lower-cased, a phone's last ten digits).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A staged entity used to keep exactly one handle — {@link entityIdentityKey},
 * the lexicographically smallest — and `push/entities.ts` indexed only that.
 * Digits sort before letters, so a card with any phone number NEVER had its
 * email indexed: 600 of the 1,018 cards with an email in one real 4,927-card
 * export. Mail from those addresses could not resolve to the contact (it
 * minted a stub Person instead), the email tier of the duplicate detector
 * never saw them, and their other numbers were invisible too. The attributes
 * that carried them are gone after staging, so this is the one place they can
 * be kept.
 *
 * ── What is NOT a contact method ───────────────────────────────────────────
 *
 *  - a SHARED handle ({@link EntityAttribute.shared}): a fax anywhere in the
 *    export, or a line another card lists under a name that describes someone
 *    else ({@link markSharedContactHandles}). Indexed under the first
 *    colleague to arrive, the office switchboard would claim every call the
 *    office makes — the reason it no longer keys anyone either;
 *  - a FAX ({@link FAX_ATTRIBUTE_NAME}): office equipment;
 *  - a number with an EXTENSION: its last ten digits are not a number at all —
 *    "(310) 447-8675;229" keys as 4478675229;
 *  - anything not written like a phone number (letters, notes);
 *  - an organizational mailbox ({@link isOrganizationalAddress}): `info@` on a
 *    colleague's card is the office's, and indexed under the first colleague it
 *    would claim every message the office sends.
 *
 * This is only what the contact is indexed under. The natural key is
 * {@link entityIdentityKey}'s, which passes over shared handles too but still
 * reads the rest — an extension, an organizational mailbox — exactly as before.
 *
 * Only for entities that become a Person; empty otherwise.
 */
export function contactIdentifiers(entity: Entity): { emails: string[]; phones: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();

  if (!becomesPerson(entity)) {
    return { emails: [], phones: [] };
  }

  for (const attribute of entity.attributes ?? []) {
    if (
      !isHandleAttribute(attribute) ||
      attribute.shared === true ||
      (attribute.name ?? '').toLowerCase() === FAX_ATTRIBUTE_NAME
    ) {
      continue;
    }

    for (const part of String(attribute.value).split(JOINED_VALUES)) {
      const raw = part.trim();

      if (raw.includes('@')) {
        const email = normalizeEmail(raw.replace(/^mailto:/i, ''));

        if (email != null && EMAIL_SHAPE.test(email) && !isOrganizationalAddress(email)) {
          emails.add(email);
        }

        continue;
      }

      const value = raw.replace(/^tel:/i, '').trim();

      if (hasPhoneExtension(value) || !PHONE_VALUE_SHAPE.test(value)) {
        continue;
      }

      const digits = normalizeHandle(value);

      if (digits) {
        phones.add(digits);
      }
    }
  }

  return { emails: [...emails], phones: [...phones] };
}

/**
 * The entity as staging should store it: its metadata carrying
 * {@link contactIdentifiers} under {@link CONTACT_IDENTIFIER_KEYS} — BOTH keys,
 * empty arrays included, for an entity that becomes a Person, so the push can
 * tell "this contact states no phone of its own" (its handle is a fax or an
 * extension, and must not be indexed) from a row staged before the keys
 * existed — and this sighting's display name under {@link CONTACT_NAMES_KEY},
 * all three accumulating across sightings, whatever the parser declared. Any
 * other entity is returned unchanged.
 */
export function withContactIdentifiers(entity: Entity): Entity {
  if (!becomesPerson(entity)) {
    return entity;
  }

  const { emails, phones } = contactIdentifiers(entity);
  const name = entity.name?.trim();

  return {
    ...entity,
    metadata: {
      ...(entity.metadata ?? {}),
      emails,
      phones,
      [CONTACT_NAMES_KEY]: name ? [name] : [],
    } as Metadata,
    accumulate: [...new Set([...(entity.accumulate ?? []), ...CONTACT_IDENTIFIER_KEYS, CONTACT_NAMES_KEY])],
  };
}

/** The lexicographically-smallest handle, or null for none. */
function smallestHandle(handles: string[]): string | null {
  return handles.length > 0 ? [...handles].sort()[0] : null;
}

/**
 * A stable identity key for an entity: the lexicographically-smallest of the
 * normalized handles that are its OWN, or null when it has none.
 *
 * Sorting makes the key independent of attribute order, so one real person
 * always keys the same way regardless of which message field (from/to/cc) or
 * which source surfaced them. This — not the mutable display name — is what
 * contacts dedup on.
 *
 * ## A shared handle is never the key
 *
 * Handles a parser marked {@link EntityAttribute.shared} — a fax, or a line
 * another person's card in the same export also lists — are passed over. Until
 * they were, the smallest handle won whatever it was, and digits sort before
 * letters, so an office's main line beat every colleague's own address: three
 * cards from one firm, each listing the switchboard and a personal email, all
 * keyed on the switchboard, staged as ONE entity, and pushed as one Person whose
 * accumulated `Names` listed all three of them. A fax sorting below someone's
 * direct line keyed them on office equipment.
 *
 * An entity with no handle of its own keys on nothing here, and therefore on
 * its NAME (see {@link stagedNaturalKey}): two different people cannot collide
 * there without sharing a name as well. Only a NAMELESS one falls back to its
 * smallest shared handle — a key it may share still beats no key, which is
 * what `PushStage` drops an entity for.
 *
 * {@link legacyEntityIdentityKey} is the rule this replaced. It stays, because
 * every row already in `ci.entities` was minted under it.
 */
export function entityIdentityKey(entity: Entity): string | null {
  const own = smallestHandle(identityHandles(entity, { withShared: false }));

  if (own != null) {
    return own;
  }

  if (entity.name?.trim()) {
    return null;
  }

  return smallestHandle(identityHandles(entity, { withShared: true }));
}

/**
 * The key {@link entityIdentityKey} gave this entity before shared handles were
 * passed over: the smallest of ALL its handles — all of them that its parser
 * read then, which leaves out the ones marked
 * {@link EntityAttribute.newSinceLegacyKey}.
 *
 * Kept for exactly one job. Changing which handle keys a contact MOVES its
 * natural key, and `GraphIngestService` resolves an existing row by nothing
 * else — so without help, the next import of the same export mints a second
 * Person beside every contact whose key moved. The row cannot be re-keyed by a
 * migration either: the choice depends on TEL types and on the other cards in
 * the export, and neither is stored anywhere after staging. The parser, though,
 * still has both keys in hand, so `StagedWriter` records this one beside the
 * new one and `PushStage` moves the old row onto the new key in place. See
 * `push/legacyKeys.ts`.
 *
 * A parser that starts reading a field it used to skip moves keys the same way
 * — a contact keyed on its email moves onto a newly-read phone, since digits
 * sort first — and rides the same re-key by marking what it newly reads. What
 * that cannot reach is a contact that had no handle at all: it was keyed on its
 * name, and a legacy key is a handle.
 */
export function legacyEntityIdentityKey(entity: Entity): string | null {
  return smallestHandle(identityHandles(entity, { withShared: true, withNew: false }));
}

/**
 * Words that join a name rather than being one. Two cards sharing "de" or
 * "and" share no name.
 */
const NAME_CONNECTIVES = new Set([
  'and',
  'at',
  'da',
  'de',
  'del',
  'della',
  'der',
  'di',
  'du',
  'for',
  'from',
  'la',
  'le',
  'of',
  'the',
  'van',
  'von',
]);

/**
 * The elements of a display name worth comparing across cards, or null when the
 * name can say nothing about who someone is: missing, only honorifics, a
 * relation rather than a name ("Priya's brother" may well be the card beside
 * it), or a handle written into the name field.
 */
function nameElements(name: string | null | undefined): string[] | null {
  if (!name || name.includes('@')) {
    return null;
  }

  const tokens = tokenizePersonName(name);

  if (tokens == null || tokens.isRelational) {
    return null;
  }

  const elements = tokens.values.filter(
    (value) => value.length >= 2 && /[a-z]/.test(value) && !NAME_CONNECTIVES.has(value),
  );

  return elements.length > 0 ? elements : null;
}

/** Equal, or one a 3+ letter prefix of the other — "matt" / "matthew", "alex" / "alexander". */
function sameNameElement(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];

  return shorter.length >= 3 && longer.startsWith(shorter);
}

function elementsDescribeDifferentPeople(left: string[] | null, right: string[] | null): boolean {
  if (left == null || right == null) {
    return false;
  }

  return !left.some((element) => right.some((other) => sameNameElement(element, other)));
}

/**
 * True when two display names are EVIDENCE that their cards describe different
 * people: both are real names, and they have no name element in common.
 *
 * Deliberately the narrowest reading of "different". A name is a poor identity
 * — one person is filed as "Matt Okafor" and "Matthew Okafor", as "Dana Reyes"
 * and (married) "Dana Whitfield", as "Sam Tulley" and "Sam Tully" — so ANY
 * shared element, a nickname prefix included, reads as possibly the same
 * person. What is left is the case this exists for: colleagues on one office
 * line, whose names share nothing at all.
 *
 * Family members on one home line ("Ana Ruiz" and "Luis Ruiz") are NOT told
 * apart, and stay one entity as they always were: a shared surname cannot be
 * separated from the nickname-and-typo population above by the name alone.
 *
 * Measured on a real 4,922-card address book: 37 keys moved, and all five
 * groups of cards that had shared a key under names with nothing in common came
 * apart — a three-person office among them, and one pair that is really one
 * person with a typo in BOTH names: a duplicate the merge flow can offer back,
 * where the collapse had no way back at all.
 *
 * Never evidence either way — so never "different" — for a missing name, a
 * relational description, or a handle written into the name field.
 */
export function namesDescribeDifferentPeople(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return elementsDescribeDifferentPeople(nameElements(left), nameElements(right));
}

/**
 * The contacts of ONE export, each with the handles that are not its own
 * marked {@link EntityAttribute.shared}: any number the export types as a fax
 * anywhere in it, and any handle another contact in the export also lists under
 * a name that {@link namesDescribeDifferentPeople | describes someone else}.
 *
 * A contact parser calls this once per export, after reading every card and
 * before emitting any, because that is the only point where anything can see
 * that two cards share a line: staging collapses entities on their key and
 * never compares what else the cards said.
 *
 * Both marks are decided for the export, not the card, because one person's
 * duplicate cards disagree. A real export files the same firm number as
 * `TEL;TYPE=FAX` on one copy of a card and as an untyped `TEL` on the other; a
 * per-card rule gave those two copies different keys and split one person. Seen
 * from the whole export they agree.
 *
 * Per export, not per run: a run spans every file it was handed, and each file
 * is parsed by a fresh importer. Colleagues filed into two different Google
 * Takeout label files are not seen together, and can still collapse.
 *
 * Contacts with nothing to mark are returned as the same objects.
 */
export function markSharedContactHandles<T extends Entity>(
  contacts: readonly T[],
  faxHandles: Iterable<string> = [],
): T[] {
  const fax = new Set<string>();

  for (const value of faxHandles) {
    const handle = normalizeHandle(value);

    if (handle) {
      fax.add(handle);
    }
  }

  const handlesOf = contacts.map((contact) => new Set(identityHandles(contact, { withShared: true })));
  const namesOf = contacts.map((contact) => nameElements(contact.name));
  const holders = new Map<string, number[]>();

  handlesOf.forEach((handles, index) => {
    for (const handle of handles) {
      const list = holders.get(handle);

      if (list) {
        list.push(index);
      } else {
        holders.set(handle, [index]);
      }
    }
  });

  return contacts.map((contact, index) => {
    const shared = new Set<string>();

    for (const handle of handlesOf[index]) {
      const heldByAnother = (holders.get(handle) ?? []).some(
        (other) => other !== index && elementsDescribeDifferentPeople(namesOf[index], namesOf[other]),
      );

      if (fax.has(handle) || heldByAnother) {
        shared.add(handle);
      }
    }

    if (shared.size === 0) {
      return contact;
    }

    return {
      ...contact,
      attributes: (contact.attributes ?? []).map((attribute) =>
        isHandleAttribute(attribute) && shared.has(normalizeHandle(attribute.value))
          ? { ...attribute, shared: true }
          : attribute,
      ),
    };
  });
}

/**
 * True when an entity carries a phone/email identity — i.e. it is really a
 * person even when the datasource forgot to set `type`. A shared handle counts:
 * the office line is still how to reach them.
 */
export function hasContactIdentity(entity: Entity): boolean {
  return (entity.attributes ?? []).some(isHandleAttribute);
}

/**
 * True when every identity handle this entity carries (see
 * {@link identityHandles}) is an organizational email — {@link
 * isOrganizationalAddress} — with no phone and no personal-looking email
 * alongside it. A mixed entity (a role mailbox found next to a real phone) is
 * left alone: the other identity is still a real way to reach a person.
 */
function hasOnlyOrganizationalIdentity(entity: Entity): boolean {
  const handles = identityHandles(entity, { withShared: true });

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
