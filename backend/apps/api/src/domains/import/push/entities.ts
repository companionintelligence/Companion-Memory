import { type GraphEntityInputDto, isNonNameParticipant, isPlaceholderPersonName } from '@ci/domains/graph';
import {
  type GivenNameRelation,
  givenNameRelation,
  isPlaceholderPersonName as isPlaceholderName,
} from '@ci/domains/memory';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import { CONTACT_NAMES_KEY, stagedNaturalKey } from '../staging/identity';

/**
 * The `ci.entities.entity_type` a staged type resolves to.
 *
 * The parsers speak their own vocabulary — `contact`, `person`, `music_genre`,
 * `food`, `email_thread`, and whatever a CSV's type column happens to contain —
 * while `ci.entities` files everything under a much smaller set. Anything with
 * no better home becomes a `Concept`, which is what the graph already uses for
 * "a thing worth having a node for that is neither a person nor a place".
 */
const ENTITY_TYPES: Record<string, string> = {
  contact: 'Person',
  person: 'Person',
  place: 'Location',
  location: 'Location',
  address: 'Location',
  // A catalogued product (a book, a device model) and a concrete object.
  // Without these both fall through to `Concept`, which is where every
  // purchased thing lands in the graph: unqueryable as a product, and
  // indistinguishable from a topic tag — `GraphController` never removes
  // connective types (Concept, Goal, Tag) with the explorer's type filter, so
  // they cannot even be filtered back out.
  product: 'Product',
  object: 'Object',
};

const DEFAULT_ENTITY_TYPE = 'Concept';

/**
 * Staged entity types that are bookkeeping, not things worth a graph node.
 *
 * `email_thread` is the whole list today. `gmail.ts` emits one per message so
 * that a thread's messages can be grouped, and the name it carries is the raw
 * Message-ID — which, falling through to `Concept`, puts a degree-0 node
 * bearing a string like `<CAF=…@mail.gmail.com>` into the graph for every email
 * imported. `GraphController` documents that connective types (Concept, Goal,
 * Tag) are never removed by the explorer's type filter, and node queries order
 * by `created_at DESC`, so right after a Gmail import the Concept slice of the
 * canvas is nothing but Message-IDs, and the entity-type counts are inflated by
 * one row per email. Upstream measured ≈148k such nodes and excluded the type
 * by default for exactly this reason.
 *
 * Excluded at push rather than at parse: the staged row is still an honest
 * record of what the parser saw, and threading may yet want to read it.
 */
const GRAPH_EXCLUDED_TYPES = new Set(['email_thread']);

/** Whether this staged entity should reach the graph at all. */
export function isGraphExcluded(staged: StagedEntity): boolean {
  return GRAPH_EXCLUDED_TYPES.has((staged.type ?? '').trim().toLowerCase());
}

export function entityTypeFor(staged: StagedEntity): string {
  const type = (staged.type ?? '').trim().toLowerCase();

  return ENTITY_TYPES[type] ?? DEFAULT_ENTITY_TYPE;
}

/**
 * The natural key an entity is resolved by, or null if it has no stable one.
 *
 * A handle wins over a name, because the display name drifts across sources —
 * "Alice", "Alice Smith" and the bare address are one person — while the handle
 * is the person. A handle-less entity falls back to its name, which is stable
 * enough for the things that have no handle by nature: an artist, a genre, a
 * dish. Only an entity with NEITHER is unresolvable.
 *
 * The type is part of the key so that a restaurant and the dish it sells cannot
 * collide on a shared name.
 */
export function naturalKeyFor(staged: StagedEntity): string | null {
  return stagedNaturalKey(staged.type, staged.identityKey, staged.name);
}

/** The string entries of a staged metadata list, or null when staging did not record the key at all. */
function statedList(metadata: Record<string, unknown> | null | undefined, key: string): string[] | null {
  const value = metadata?.[key];

  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/** Relations under which two display names can be one person under two spellings. */
const ONE_PERSON: ReadonlySet<GivenNameRelation> = new Set(['same', 'initial', 'prefix']);

/**
 * Whether the display names of a staged row's sightings describe more than one
 * person: two of them disagree on the first given name (not the same, not an
 * initial, not a nickname prefix — `givenNameRelation`), or one is a
 * placeholder (a number or an address standing in for a name says nothing
 * about who it is), among two or more names.
 *
 * Deliberately quick to say yes. A wrong yes costs the row its extra contact
 * methods (it is indexed on its handle, as every row was before); a wrong no
 * indexes one person's address as another's.
 */
export function describesSeveralPeople(names: readonly string[]): boolean {
  const distinct = [...new Set(names.map((name) => name.trim()).filter(Boolean))];

  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      if (
        isPlaceholderName(distinct[i]) ||
        isPlaceholderName(distinct[j]) ||
        !ONE_PERSON.has(givenNameRelation(distinct[i], distinct[j]))
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * The emails and phones a staged entity is indexed under: every one staging
 * recorded as the contact's own (`staging/identity.ts` `contactIdentifiers`,
 * under `emails` / `phones`), with the entity's handle heading its list.
 *
 * Unless the row is several people. Staging collapses sightings on their
 * identity key, and a household on one home line stays together (#2795
 * cannot tell a shared surname from a nickname), so the row's lists hold every
 * member's addresses. Its sightings' names ({@link CONTACT_NAMES_KEY}, or the
 * vCard parser's `Names` for a row staged before that key) say so, and such a
 * row is indexed on its handle alone, as every row was before these lists.
 *
 * The handle is NOT always one of them. A phone handle that staging recorded
 * lists and left out is an extension number ("(310) 447-8675;229" keys as
 * 4478675229) — the smallest of the card's own handles, and so the natural
 * key, but no one's line — and it stays out of the index. (A fax or a shared
 * office line no longer keys anyone: staging passes over shared handles.) A
 * row staged before those lists existed (no `phones` key at all) keeps the
 * old behaviour: its handle is its identifier.
 *
 * An email handle is always kept, as before, even an organizational one
 * staging would not have recorded: it is the only thing such a contact is.
 */
export function contactMethodsFor(
  metadata: Record<string, unknown> | null | undefined,
  handle: string | null | undefined,
): { emails: string[]; phones: string[] } {
  const statedEmails = statedList(metadata, 'emails');
  const statedPhones = statedList(metadata, 'phones');
  const several = describesSeveralPeople(
    statedList(metadata, CONTACT_NAMES_KEY) ?? statedList(metadata, 'Names') ?? [],
  );
  let emails = several ? [] : [...new Set(statedEmails ?? [])];
  let phones = several ? [] : [...new Set(statedPhones ?? [])];
  const key = handle?.trim();

  if (key) {
    if (key.includes('@')) {
      emails = [key, ...emails.filter((email) => email !== key)];
    } else if (statedPhones == null || statedPhones.includes(key)) {
      phones = [key, ...phones.filter((phone) => phone !== key)];
    }
  }

  return { emails, phones };
}

/**
 * Turn a staged entity into the graph entity to resolve-or-create.
 *
 * Returns null only for an entity with no handle AND no name — there is nothing
 * to key it on, so every run would mint another row for it.
 *
 * ## Why this does not go through `PersonService.create`
 *
 * It used to, with the normalized handle passed as `linkedId`. That is a `uuid`
 * column, so every entity that HAD a handle failed on `invalid input syntax for
 * type uuid`, and every entity that did not was skipped for want of a stable
 * key — between them, nothing ever resolved. Because the mapping table stayed
 * empty, `participantsFor` then found no participants for any record, and a real
 * import silently dropped all 613 of its item→entity edges.
 *
 * `GraphIngestService` is the server's answer to this exact problem — it is
 * bulk ingest for the archive importer's own knowledge graph. It derives
 * `linked_id` as `uuidv5(key)`, so a natural key is a legal identity; it files
 * rows under `import:<sourceSystem>`; and it indexes emails and phones into
 * `ci.entity_identifiers`, which is what lets communication participants and
 * duplicate detection find these people later.
 *
 * ## Identifiers are plural
 *
 * `emails` / `phones` / `names` are the arrays `GraphIngestService` reads to
 * populate `ci.entity_identifiers`. They are every contact method staging
 * recorded for the entity ({@link contactMethodsFor}), not just the one
 * handle its natural key was built from: a card keyed on its phone number
 * used to reach the index without its email at all.
 */
export function toGraphEntity(staged: StagedEntity): GraphEntityInputDto | null {
  const key = naturalKeyFor(staged);

  if (key == null) {
    return null;
  }

  const handle = staged.identityKey?.trim();
  const properties: Record<string, unknown> = { ...(staged.metadata ?? {}) };
  const { emails, phones } = contactMethodsFor(staged.metadata, handle);

  // Re-set from the merged lists below, so an empty staged list never reaches
  // the row as `[]`. The sightings' names are staging's own bookkeeping.
  delete properties.emails;
  delete properties.phones;
  delete properties[CONTACT_NAMES_KEY];

  // A parser's `description` is the row's description column, not a property:
  // the vCard parser files a card's NOTE here. Nothing else sends the key.
  const description =
    typeof properties.description === 'string' && properties.description.trim() !== ''
      ? properties.description.trim()
      : undefined;
  delete properties.description;

  // The first of each list is the entity's primary: its handle when that is
  // one of them (the handle is the identity, so it is worth having as a
  // first-class property and not only inside the derived linked id).
  if (emails.length > 0) {
    properties.email = emails[0];
    properties.emails = emails;
  }

  if (phones.length > 0) {
    properties.phone = phones[0];
    properties.phones = phones;
  }

  const entityType = entityTypeFor(staged);
  const stagedName = staged.name?.trim();

  // A Person's display name is the one field a user READS, and a parser that
  // fumbles its label puts that fumble in the address book: 2,353 `Person` rows
  // on a real appliance were named with a Google Voice call-log heading, minted
  // straight through this function from `staged.name`. When the name is
  // structurally not a name, the handle is the honest answer — it is what
  // identifies this contact anyway — and the garbage never reaches
  // `properties.names`, which is the array `GraphIngestService` indexes into
  // `ci.entity_identifiers`.
  //
  // Two doors, deliberately separate modules. `isNonNameParticipant` is the
  // narrow structural one shared with the participant/identifier lanes, where a
  // refusal costs a communication its edge. `isPlaceholderPersonName` is this
  // lane's own, because a placeholder is only a problem for the DISPLAY name and
  // the `name` identifier — 139 `Person` rows on the same appliance carry an
  // empty name from `.vcf` cards with no `FN`, with the address sitting unused
  // in `properties.email`.
  //
  // Person-only, both of them. A `Concept` legitimately named "invoice.pdf" is a
  // thing the export really did contain, and the filename rule would delete it.
  const nameIsUnusable =
    entityType === 'Person' &&
    (isNonNameParticipant(stagedName, 'import.toGraphEntity') ||
      isPlaceholderPersonName(stagedName, 'import.toGraphEntity'));

  // The trimmed name, or undefined when there is none worth showing. `undefined`
  // rather than `''` is load-bearing below: `??` does not catch the empty
  // string, which is how a nameless vCard landed a blank display name on a row
  // whose email was right there to fall back to.
  const usableName = stagedName && !nameIsUnusable ? stagedName : undefined;

  if (usableName) {
    properties.names = [usableName];
  }

  return {
    key,
    entityType,
    // Not the display name as identity — only what this sighting called them.
    // An unusable display name falls back to the handle rather than being shown,
    // and with no handle to fall back to the row is honestly NAMELESS: the
    // column is nullable, `GraphIngestService` writes `input.name ?? null`
    // straight through, and a null name is a People row the merge flow can still
    // repair. Showing "Missed call from" instead would put the parser's fumble
    // in the address book while `properties.names` — suppressed just above —
    // withholds the very string the identifier index would need to find it
    // again. The staged row keeps the parser's honest record either way.
    name: usableName ?? handle ?? null,
    ...(description ? { description } : {}),
    sourceSystem: staged.dataSource ?? 'unknown',
    properties,
    // The parser's own statement of which keys are sets. A re-import unions
    // them into the graph row instead of replacing them — see
    // GraphIngestService's property merge.
    ...(staged.accumulate?.length ? { accumulate: [...staged.accumulate] } : {}),
  };
}

/**
 * The relations a staged edge uses to name WHERE a record happened.
 *
 * The parsers' own vocabulary, mapped to `Location` by {@link ENTITY_TYPES}
 * — a place edge is read the same way `resolveCorrespondents` reads a
 * `from`/`to` edge, through `ci_import.entity_mappings`.
 */
export const PLACE_RELATIONS: readonly string[] = ['place', 'location', 'venue', 'address'];

/** The `ci.entities.entity_type` a place resolves to. Same value {@link ENTITY_TYPES} gives. */
export const PLACE_ENTITY_TYPE = ENTITY_TYPES.place;

/**
 * The natural key a place NAME resolves under — the same string
 * {@link naturalKeyFor} mints for a staged entity of type `place`.
 *
 * Deliberately identical, and that is the whole point: a record that only
 * STATES an address in its metadata and a parser that staged the same place as
 * an entity must land on ONE graph node, not two spellings of one location.
 */
export function placeKeyFor(name: string): string | null {
  const trimmed = name.trim().toLowerCase();

  return trimmed ? `place:${trimmed}` : null;
}
