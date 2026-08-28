import { type GraphEntityInputDto, isNonNameParticipant, isPlaceholderPersonName } from '@ci/domains/graph';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import { stagedNaturalKey } from '../staging/identity';

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
 * populate `ci.entity_identifiers`. A staged entity carries one normalized
 * handle, so at most one of them has an element — but the shape is the batch
 * shape, not a special case for this caller.
 */
export function toGraphEntity(staged: StagedEntity): GraphEntityInputDto | null {
  const key = naturalKeyFor(staged);

  if (key == null) {
    return null;
  }

  const handle = staged.identityKey?.trim();
  const properties: Record<string, unknown> = { ...(staged.metadata ?? {}) };

  if (handle) {
    // The handle is the identity, so it is worth having as a first-class
    // property and not only inside the derived linked id.
    if (handle.includes('@')) {
      properties.email = handle;
      properties.emails = [handle];
    } else {
      properties.phone = handle;
      properties.phones = [handle];
    }
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
    sourceSystem: staged.dataSource ?? 'unknown',
    properties,
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
