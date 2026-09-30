/**
 * Moving a contact off a TRUNCATED phone key when the fixed parser pushes it
 * again, instead of minting a second row beside it.
 *
 * ## The rows this exists for
 *
 * The shared phone join key used to keep the last ten digits of line AND
 * extension, so an office line `(212) 555-0147;229` keyed as `5550147229` — a
 * well-formed number belonging to nobody on the card. `normalizeHandle` now
 * refuses such a value, and migration 20260930020117 repaired every row it
 * could PROVE held one: vCard Persons, whose `properties.Phones` kept the typed
 * value. Apple Contacts and CSV contact lists kept nothing but the truncation,
 * so their rows were left as they were: still at `contact:5550147229`, still
 * holding the fabricated `ci.entity_identifiers` phone. The fixed parser keys
 * the same card elsewhere (`contact:<its real smallest handle>`, or its name),
 * so the next import found nothing at the new coordinate and minted a
 * duplicate, orphaning the old row with its identifier, edges and history.
 *
 * ## What the push can prove that the migration could not
 *
 * The migration had only the stored row. The push also has the CARD, typed
 * (its `Phones` / `Emails` metadata — every contact parser keeps them now), so
 * the half of the proof the row lost comes back with the card:
 *
 *  1. a typed phone on the card is one line followed by an extension
 *     ({@link isLineWithExtension}), which {@link legacyNormalizeHandle} (the
 *     old rule) truncated;
 *  2. the card's typed values reproduce the key the parser actually staged
 *     under the CURRENT rule — so they are the card's whole handle set, and the
 *     old rule over the same set is exactly what the old parser computed;
 *  3. under the old rule the truncation was the card's key (its smallest
 *     handle), so the old natural key is `contact:<truncation>` and differs
 *     from the new one;
 *  4. a row sits at that coordinate — `linked_id` equality, the same proof the
 *     migration used, now against a key rebuilt from the card rather than from
 *     the row;
 *
 * and, because a coordinate is not a card, what the database must also say
 * before anything moves (see {@link rekeyTruncatedPhoneCoordinates}): the new
 * coordinate is free, nothing in this run still keys onto the old one under
 * the fixed rule (a card whose REAL number is those ten digits), exactly one
 * card claims the row, and the row's own name agrees with the card's.
 *
 * Steps 1–3 are pure and live here, in the shape `EntityTypeAuditService`
 * reconstructs "the key another rule would have produced" in: the key is
 * rebuilt with {@link stagedNaturalKey}, the one function both rules share.
 */
import type { DataSource, EntityManager } from 'typeorm';

import { type GraphEntityInputDto, GraphIngestService, PHONE_EXTENSION_PATTERN } from '@ci/domains/graph';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import { normalizeHandle, stagedNaturalKey } from '../staging/identity';

/**
 * Entity-metadata keys a contact parser keeps its identity handles under, AS
 * TYPED. vcard.ts, applecontacts.ts and contactlist.ts all write them, and
 * every value their identity attributes carry is in one of them — which is what
 * makes a card's key recomputable once the attributes are gone. The SQL twin is
 * migration 20260930020117's `new_key` (`properties -> 'Phones'` + `'Emails'`).
 */
export const TYPED_HANDLE_KEYS = ['Phones', 'Emails'] as const;

/** The typed handle strings a metadata bag (or a row's `properties`) holds, in key order. */
export function typedHandlesOf(bag: Readonly<Record<string, unknown>> | null | undefined): string[] {
  const out: string[] = [];

  for (const key of TYPED_HANDLE_KEYS) {
    const value = bag?.[key];

    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === 'string' && entry.trim() !== '') {
        out.push(entry);
      }
    }
  }

  return out;
}

/** The smallest non-empty handle, in the code-unit order `entityIdentityKey` sorts by. */
function smallestHandle(handles: readonly string[]): string | null {
  return handles.filter((handle) => handle !== '').sort()[0] ?? null;
}

/**
 * `entityIdentityKey` over typed values: the key the CURRENT rule gives a card
 * whose identity attributes are exactly these values.
 *
 * `identityHandles` also requires `looksLikeHandle`, which every value
 * `normalizeHandle` keys already satisfies (an `@`, or seven digits), so the
 * two agree without it.
 */
export function identityKeyFromTypedHandles(values: readonly string[]): string | null {
  return smallestHandle(values.map(normalizeHandle));
}

/**
 * `normalizeHandle` as it was before extensions were refused: an email
 * lower-cased, a phone of seven or more digits keyed by the last ten of ALL its
 * digits — extension included.
 *
 * Kept to RECOGNISE a coordinate the old parser minted, never to write one.
 * The duplicate detector keeps the same truncation for the same reason
 * (`ParsedPhone.l10` in `memory/utils/phoneIdentity.ts`), and the migration as
 * `pg_temp.phone_old_key`.
 */
export function legacyNormalizeHandle(value: string): string {
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
 * The longest extension {@link isLineWithExtension} accepts: libphonenumber's
 * limit for an extension it is not sure of, and past what office extensions
 * run to.
 */
const MAX_EXTENSION_DIGITS = 6;

const PHONE_EXTENSION = new RegExp(PHONE_EXTENSION_PATTERN, 'i');

/**
 * `value` is ONE line (7–15 digits) followed by its extension — the only shape
 * whose last ten digits the old rule turned into a number nobody has.
 *
 * A value holding a second number after the extension is not a truncation at
 * all: Google's CSV joins a label's numbers into one cell, so
 * `(212) 555-0147;229 ::: +1 212-555-0199` keyed as `2125550199` — the card's
 * OWN second number. Moving that row would be right, but dropping its identifier
 * and withdrawing the links it made would unlink real calls. So the digits after
 * the marker must be an extension's worth, and the digits before it one line's.
 */
function isLineWithExtension(value: string): boolean {
  const match = PHONE_EXTENSION.exec(value);

  if (match == null) {
    return false;
  }

  // The `x`/`ext` alternative opens by consuming the character before the
  // marker, and the `p`/`w` one the digit before it; neither belongs to the
  // extension.
  const start = /^[a-z;,#]/i.test(match[0]) ? match.index : match.index + 1;
  const line = value.slice(0, start).replace(/\D/g, '');
  const extension = value.slice(start).replace(/\D/g, '');

  return (
    line.length >= 7 && line.length <= 15 && extension.length >= 1 && extension.length <= MAX_EXTENSION_DIGITS
  );
}

/** Why a staged card's old coordinate is a truncation, and where it moves. */
export interface TruncatedPhoneKey {
  /** The natural key the pre-fix rule minted for this card: `contact:<truncation>`. */
  legacyKey: string;
  /** The natural key the fixed parser resolves the card under. */
  currentKey: string;
  /** The truncation: the last ten digits of line + extension. */
  truncatedHandle: string;
  /** The card's current handle — its staged identity key — or null when it keys on its name. */
  handle: string | null;
  /** The typed values on the card that truncate to {@link truncatedHandle}. */
  typed: string[];
  /** Why, in words, the way `EntityTypeAuditService` files its evidence. */
  evidence: string[];
}

/**
 * Steps 1–3 of the proof (see the module doc) for one staged entity: the old
 * natural key its typed handles yield, when that key is a truncation the fixed
 * parser no longer produces. Null when the card has nothing the fix changed,
 * or when its metadata cannot vouch for its own key.
 */
export function truncatedPhoneKeyFor(
  staged: Pick<StagedEntity, 'type' | 'name' | 'identityKey' | 'metadata'>,
): TruncatedPhoneKey | null {
  const typed = typedHandlesOf(staged.metadata);
  const extensions = typed.filter((value) => !value.includes('@') && isLineWithExtension(value));

  if (extensions.length === 0) {
    return null;
  }

  // Step 2. A parser that kept some handles only in attributes (or a card that
  // gathered handles from somewhere its metadata does not say) would make the
  // old key rebuilt below a guess; this is the check that it is not one.
  const handle = identityKeyFromTypedHandles(typed);

  if (handle !== (staged.identityKey?.trim() || null)) {
    return null;
  }

  // Step 3. The old rule over the same values. It can only differ from the new
  // one by a truncation winning: every other handle keys identically under
  // both rules, and the fixed set is the old set minus the truncations.
  const truncatedHandle = smallestHandle(typed.map(legacyNormalizeHandle));
  const matching = extensions.filter((value) => legacyNormalizeHandle(value) === truncatedHandle);

  if (truncatedHandle == null || truncatedHandle === handle || matching.length === 0) {
    return null;
  }

  const legacyKey = stagedNaturalKey(staged.type, truncatedHandle, staged.name);
  const currentKey = stagedNaturalKey(staged.type, handle, staged.name);

  if (legacyKey == null || currentKey == null || legacyKey === currentKey) {
    return null;
  }

  return {
    legacyKey,
    currentKey,
    truncatedHandle,
    handle,
    typed: matching,
    evidence: [
      `typed phone ${matching.join(', ')} carries an extension; the pre-fix rule keyed it as ${truncatedHandle}`,
      `the card's typed handles reproduce its staged key under the current rule (${handle ?? 'none: it keys on its name'})`,
      `pre-fix natural key ${legacyKey} differs from the current ${currentKey}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

/** One card the fixed parser is about to resolve, with the proof it carries. */
export interface TruncatedPhoneRekeyCandidate {
  /** What the push hands `GraphIngestService` for this card. */
  input: Pick<GraphEntityInputDto, 'key' | 'entityType' | 'sourceSystem' | 'properties'>;
  /** The staged row's `type` and `data_source`, for the still-claimed check. */
  stagedType: string | null;
  dataSource: string | null;
  proof: TruncatedPhoneKey;
}

/** Why a candidate's old row was left where it is. */
export type TruncatedPhoneRekeySkip =
  /** Nothing sits at the old coordinate: a first import, or one already moved. */
  | 'absent'
  /** A row already sits at the new coordinate — joining the two is a merge, not a re-key. */
  | 'destination_occupied'
  /** A staged card in this run still keys onto the old coordinate under the fixed rule. */
  | 'still_claimed'
  /** The row's own name does not match the card's, so it is not provably this card. */
  | 'name_mismatch'
  /** Two cards in this run both prove the same row. */
  | 'ambiguous';

export interface TruncatedPhoneRekeyResult {
  /** Rows whose `linked_id` moved to the fixed parser's coordinate. */
  moved: Array<{
    entityId: string;
    candidate: number;
    standing: 'live' | 'tombstone' | 'survivor' | 'inactive';
  }>;
  skipped: Record<TruncatedPhoneRekeySkip, number>;
  identifiersDeleted: number;
  selfClaimsDeleted: number;
  linksWithdrawn: number;
  edgesDeleted: number;
  freedIdentifiersIndexed: number;
}

/** `ci.entity_identifiers.source` for a number {@link rekeyTruncatedPhoneCoordinates} freed and re-indexed. */
export const TRUNCATED_PHONE_REKEY_SOURCE = 'import:truncated_phone_rekey';

function emptyResult(): TruncatedPhoneRekeyResult {
  return {
    moved: [],
    skipped: { absent: 0, destination_occupied: 0, still_claimed: 0, name_mismatch: 0, ambiguous: 0 },
    identifiersDeleted: 0,
    selfClaimsDeleted: 0,
    linksWithdrawn: 0,
    edgesDeleted: 0,
    freedIdentifiersIndexed: 0,
  };
}

/** Case- and space-insensitive, as the display name is compared everywhere else. */
function comparableName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const folded = value.trim().replace(/\s+/g, ' ').toLowerCase();

  return folded === '' ? null : folded;
}

/**
 * Whether the row at the old coordinate reads as THIS card.
 *
 * The coordinate alone cannot say: it is where the old rule put every card
 * whose key was those ten digits, and that includes a card whose real number
 * they are, imported in some other run. The old parser wrote the card's usable
 * name into `name` and `properties.names` (`toGraphEntity`), exactly as the
 * fixed one does, so an unchanged card agrees with its own row. A card with no
 * usable name was named after its handle — the truncation — and wrote no
 * `names`.
 *
 * Refusing costs the status quo — the card mints a new row, as it did before
 * this existed. Accepting wrongly would move another person's row, history and
 * all, onto this card.
 */
export function rowNameAgrees(
  card: { name: string | null },
  row: { name: string | null; names: unknown },
  truncatedHandle: string,
): boolean {
  const rowNames = (Array.isArray(row.names) ? row.names : [])
    .map(comparableName)
    .filter((name): name is string => name != null);
  const cardName = comparableName(card.name);

  if (cardName == null) {
    const rowName = comparableName(row.name);

    return (rowName == null || rowName === truncatedHandle) && rowNames.length === 0;
  }

  return comparableName(row.name) === cardName || rowNames.includes(cardName);
}

/** The usable display name `toGraphEntity` recorded for this card, or null. */
function cardNameOf(input: TruncatedPhoneRekeyCandidate['input']): string | null {
  const names = input.properties?.names;

  return Array.isArray(names) && typeof names[0] === 'string' ? names[0] : null;
}

interface ProbeRow {
  candidate: number;
  entity_id: string;
  name: string | null;
  names: unknown;
  is_tombstone: boolean;
  is_survivor: boolean;
  is_active: boolean;
  destination_occupied: boolean;
  still_claimed: boolean;
}

/** Rows the pending repair acts on, one per moved entity. Mirrors migration 20260930020117's `_ext_vcard`. */
const CREATE_WORKING_SET = `
  CREATE TEMP TABLE _tpr ON COMMIT DROP AS
  SELECT *
    FROM jsonb_to_recordset($1::jsonb) AS t(
           candidate int, entity_id uuid, owner_user_id uuid, entity_type text, linked_table text,
           old_linked_id uuid, new_linked_id uuid, old_key text, new_key text, new_key_kind text,
           is_tombstone boolean, is_survivor boolean, is_live boolean)`;

/**
 * The repair, in the migration's order and with its statements — every one of
 * them written against `_tpr` where the migration read `_ext_vcard`, and each
 * wrapped so it reports a count rather than TypeORM's `[rows, affected]` pair.
 * A statement the migration made because no import would follow it (indexing
 * the new handle) is left to the ingest this runs in front of.
 */
const REPAIR = {
  // (A1) The coordinate, re-checked under the row lock the probe took.
  move: `
    WITH moved AS (
      UPDATE ci.entities e
         SET linked_id = t.new_linked_id,
             updated_at = now()
        FROM _tpr t
       WHERE e.entity_id = t.entity_id
         AND e.linked_id = t.old_linked_id
         AND NOT EXISTS (
               SELECT 1
                 FROM ci.entities o
                WHERE o.owner_user_id IS NOT DISTINCT FROM t.owner_user_id
                  AND o.entity_type = t.entity_type
                  AND o.linked_table = t.linked_table
                  AND o.linked_id = t.new_linked_id
                  AND o.entity_id <> t.entity_id)
      RETURNING e.entity_id
    )
    SELECT entity_id FROM moved`,

  keepMoved: `DELETE FROM _tpr WHERE NOT (entity_id = ANY($1::uuid[]))`,

  // (A2) What the fixed parser writes, on every row but a merge survivor's —
  // `PersonMergeService` unions `phones`, so a survivor's truncated digits may
  // also be a merged-in record's real number. Remembered: these are the rows
  // whose search index and ledger are reset at the end.
  changedTable: `CREATE TEMP TABLE _tpr_changed (entity_id uuid PRIMARY KEY) ON COMMIT DROP`,

  properties: `
    WITH target AS (
      SELECT t.entity_id,
             CASE WHEN e.name = t.old_key THEN t.new_key ELSE e.name END AS new_name,
             CASE t.new_key_kind
               WHEN 'email' THEN (COALESCE(e.properties, '{}'::jsonb) - 'phone' - 'phones')
                                 || jsonb_build_object('email', t.new_key, 'emails', jsonb_build_array(t.new_key))
               WHEN 'phone' THEN (COALESCE(e.properties, '{}'::jsonb) - 'phone' - 'phones')
                                 || jsonb_build_object('phone', t.new_key, 'phones', jsonb_build_array(t.new_key))
               ELSE COALESCE(e.properties, '{}'::jsonb) - 'phone' - 'phones'
             END AS new_properties
        FROM _tpr t
        JOIN ci.entities e ON e.entity_id = t.entity_id
       WHERE NOT t.is_survivor
    ),
    changed AS (
      UPDATE ci.entities e
         SET properties = g.new_properties,
             name = g.new_name,
             updated_at = now()
        FROM target g
       WHERE e.entity_id = g.entity_id
         AND (e.properties IS DISTINCT FROM g.new_properties OR e.name IS DISTINCT FROM g.new_name)
      RETURNING e.entity_id
    )
    INSERT INTO _tpr_changed SELECT entity_id FROM changed`,

  // (A3) The identifier with teeth, on a live row only: a tombstone's was
  // re-pointed to its survivor at merge time (see the survivor note above).
  identifiers: `
    WITH gone AS (
      DELETE FROM ci.entity_identifiers ei
       USING _tpr t
       WHERE t.is_live
         AND ei.entity_id = t.entity_id
         AND ei.owner_user_id IS NOT DISTINCT FROM t.owner_user_id
         AND ei.kind = 'phone'
         AND ei.value_normalized = t.old_key
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`,

  // `enrich.person_self_claim` upserts and never retracts.
  selfClaims: `
    WITH gone AS (
      DELETE FROM ci.identifier_claims c
       USING _tpr t
       WHERE t.is_live
         AND c.owner_user_id = t.owner_user_id
         AND c.subject_type = 'person'
         AND c.role = 'self'
         AND c.subject_id = t.entity_id
         AND c.kind = 'phone'
         AND c.value_normalized = t.old_key
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`,

  // Links the withdrawn key resolved: one row per (subject, role, person),
  // kept only when no OTHER claim still links that person in that role — a
  // different identifier, or a human's confirmation of this one.
  links: `
    CREATE TEMP TABLE _tpr_links ON COMMIT DROP AS
    SELECT DISTINCT c.owner_user_id, c.subject_type, c.subject_id, c.role, c.entity_id
      FROM ci.identifier_claims c
      JOIN _tpr w
        ON w.is_live
       AND w.owner_user_id = c.owner_user_id
       AND w.entity_id = c.entity_id
       AND w.old_key = c.value_normalized
     WHERE c.kind = 'phone'
       AND c.subject_type IN ('communication', 'event')
       AND c.disposition IS NULL
       AND NOT EXISTS (
             SELECT 1
               FROM ci.identifier_claims o
              WHERE o.owner_user_id = c.owner_user_id
                AND o.subject_type = c.subject_type
                AND o.subject_id = c.subject_id
                AND o.role = c.role
                AND o.entity_id = c.entity_id
                AND o.disposition IS DISTINCT FROM 'rejected'
                AND (o.disposition = 'confirmed'
                     OR NOT (o.kind = 'phone'
                             AND EXISTS (SELECT 1
                                           FROM _tpr w2
                                          WHERE w2.is_live
                                            AND w2.owner_user_id = o.owner_user_id
                                            AND w2.entity_id = o.entity_id
                                            AND w2.old_key = o.value_normalized))))`,

  countLinks: `SELECT count(*)::int AS n FROM _tpr_links`,

  communicationFrom: `
    UPDATE ci.communications c
       SET from_entity_id = NULL
      FROM _tpr_links l
     WHERE l.subject_type = 'communication'
       AND l.role = 'from'
       AND c.id = l.subject_id
       AND c.user_id = l.owner_user_id
       AND c.from_entity_id = l.entity_id`,

  // Per subject, not per link: an UPDATE ... FROM applies one joined row per
  // target, so two withdrawn recipients on one message must arrive together.
  communicationTo: `
    UPDATE ci.communications c
       SET to_entity_ids = ARRAY(SELECT u.id
                                   FROM unnest(c.to_entity_ids) WITH ORDINALITY AS u(id, ord)
                                  WHERE u.id <> ALL (g.ids)
                                  ORDER BY u.ord)
      FROM (
        SELECT owner_user_id, subject_id, array_agg(entity_id) AS ids
          FROM _tpr_links
         WHERE subject_type = 'communication' AND role = 'to'
         GROUP BY owner_user_id, subject_id
      ) g
     WHERE c.id = g.subject_id
       AND c.user_id = g.owner_user_id
       AND c.to_entity_ids && g.ids`,

  eventOrganizer: `
    UPDATE ci.events e
       SET organizer_entity_id = NULL,
           updated_at = now()
      FROM _tpr_links l
     WHERE l.subject_type = 'event'
       AND l.role = 'organizer'
       AND e.event_id = l.subject_id
       AND e.user_id = l.owner_user_id
       AND e.organizer_entity_id = l.entity_id`,

  eventParticipants: `
    UPDATE ci.events e
       SET participant_entity_ids = ARRAY(SELECT u.id
                                            FROM unnest(e.participant_entity_ids) WITH ORDINALITY AS u(id, ord)
                                           WHERE u.id <> ALL (g.ids)
                                           ORDER BY u.ord),
           updated_at = now()
      FROM (
        SELECT owner_user_id, subject_id, array_agg(entity_id) AS ids
          FROM _tpr_links
         WHERE subject_type = 'event' AND role = 'participant'
         GROUP BY owner_user_id, subject_id
      ) g
     WHERE e.event_id = g.subject_id
       AND e.user_id = g.owner_user_id
       AND e.participant_entity_ids && g.ids`,

  // The edges the promote legs projected from those columns, matched on the
  // rule that wrote each one — they only ever insert.
  edges: `
    WITH gone AS (
      DELETE FROM ci.relationships r
       USING _tpr_links l
       WHERE r.owner_user_id = l.owner_user_id
         AND r.from_entity_id = l.entity_id
         AND r.to_entity_id = l.subject_id
         AND r.properties ->> 'rule' = CASE
                                         WHEN l.subject_type = 'communication' AND l.role = 'from' THEN 'communication.sent'
                                         WHEN l.subject_type = 'communication' AND l.role = 'to' THEN 'communication.received'
                                         WHEN l.subject_type = 'event' AND l.role = 'organizer' THEN 'event.organized'
                                         WHEN l.subject_type = 'event' AND l.role = 'participant' THEN 'event.participated'
                                       END
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`,

  // The claims resolve to nobody until `enrich.person_link` says otherwise.
  claims: `
    UPDATE ci.identifier_claims c
       SET entity_id = NULL,
           confidence = NULL,
           method = NULL
      FROM _tpr w
     WHERE w.is_live
       AND c.owner_user_id = w.owner_user_id
       AND c.entity_id = w.entity_id
       AND c.value_normalized = w.old_key
       AND c.kind = 'phone'
       AND c.subject_type IN ('communication', 'event')
       AND c.disposition IS NULL`,

  // The number a withdrawn key freed, indexed for a Person whose own
  // `properties.phones` states it — `EntityIdentifierBackfillService`'s order,
  // oldest first. First writer wins, so the truncation had kept it from them.
  freed: `
    WITH indexed AS (
      INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value, source)
      SELECT DISTINCT ON (h.owner_user_id, h.phone_key)
             h.entity_id, h.owner_user_id, 'phone', h.phone_key, NULLIF(h.typed, h.phone_key), $1::text
        FROM (
          SELECT e.entity_id, e.owner_user_id, e.created_at, t.typed,
                 right(regexp_replace(t.typed, '\\D', '', 'g'), 10) AS phone_key
            FROM ci.entities e
            CROSS JOIN LATERAL jsonb_array_elements_text(
                         CASE jsonb_typeof(COALESCE(e.properties -> 'phones', e.properties -> 'phone'))
                           WHEN 'array'  THEN COALESCE(e.properties -> 'phones', e.properties -> 'phone')
                           WHEN 'string' THEN jsonb_build_array(COALESCE(e.properties -> 'phones', e.properties -> 'phone'))
                           ELSE '[]'::jsonb
                         END) AS t(typed)
           WHERE e.entity_type = 'Person'
             AND COALESCE(e.is_active, true) = true
             AND e.merged_into_entity_id IS NULL
             AND e.owner_user_id = $2::uuid
             AND NOT EXISTS (SELECT 1 FROM _tpr p WHERE p.entity_id = e.entity_id)
        ) h
        JOIN (SELECT DISTINCT owner_user_id, old_key FROM _tpr WHERE is_live) w
          ON w.owner_user_id = h.owner_user_id
         AND w.old_key = h.phone_key
       -- The fixed rule's key only: a typed value with an extension keys nothing.
       WHERE h.typed !~* $3::text
       ORDER BY h.owner_user_id, h.phone_key, h.created_at, h.entity_id
      ON CONFLICT (owner_user_id, kind, value_normalized) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM indexed`,

  // `personSearchDocument` indexes the name and `properties.phone`, so the
  // stored vector answers to the truncation until rewritten — and nothing
  // rewrites a row that has an embedding. The ledger rows go too, re-opening
  // every entity-keyed stage: this row changed underneath them.
  searchEmbeddings: `DELETE FROM ci_search.embeddings em USING _tpr_changed c WHERE em.entity_id = c.entity_id`,
  searchVectors: `DELETE FROM ci_search.vectors vv USING _tpr_changed c WHERE vv.entity_id = c.entity_id`,
  searchSkips: `DELETE FROM ci_search.index_skips sk USING _tpr_changed c WHERE sk.entity_id = c.entity_id`,
  ledger: `DELETE FROM ci.pipeline_state ps USING _tpr_changed c WHERE ps.entity_id = c.entity_id`,
} as const;

async function count(manager: EntityManager, sql: string, params: unknown[] = []): Promise<number> {
  const rows = (await manager.query(sql, params)) as Array<{ n: number }>;

  return Number(rows[0]?.n ?? 0);
}

/**
 * Move every proven row onto the coordinate its card now keys under, and undo
 * what its truncated key reached — the statements migration 20260930020117 ran
 * for vCard rows, for the rows it could not prove. One transaction; the caller
 * runs the ingest right after, which then REFRESHES the moved row instead of
 * minting a new one.
 *
 * Run BEFORE the ingest for the same batch, and idempotent: a moved row no
 * longer sits at its old coordinate, so a retry finds it `absent`.
 */
export async function rekeyTruncatedPhoneCoordinates(
  dataSource: Pick<DataSource, 'transaction'>,
  scope: { userId: string; runId: string },
  candidates: readonly TruncatedPhoneRekeyCandidate[],
): Promise<TruncatedPhoneRekeyResult> {
  const result = emptyResult();

  if (candidates.length === 0) {
    return result;
  }

  const probe = candidates.map((c, index) => ({
    candidate: index,
    entity_type: c.input.entityType,
    linked_table: `import:${c.input.sourceSystem}`,
    data_source: c.dataSource,
    staged_type: c.stagedType,
    old_linked_id: GraphIngestService.linkedIdFor(c.proof.legacyKey),
    new_linked_id: GraphIngestService.linkedIdFor(c.input.key),
    old_key: c.proof.truncatedHandle,
  }));

  return dataSource.transaction(async (manager) => {
    // Step 4 and the database's checks (see the module doc). Locked, so what
    // the repair below acts on stays as found until commit.
    const found = (await manager.query(
      `WITH c AS (
         SELECT *
           FROM jsonb_to_recordset($3::jsonb) AS c(
                  candidate int, entity_type text, linked_table text, data_source text, staged_type text,
                  old_linked_id uuid, new_linked_id uuid, old_key text)
       )
       SELECT c.candidate,
              e.entity_id,
              e.name,
              e.properties -> 'names' AS names,
              e.merged_into_entity_id IS NOT NULL AS is_tombstone,
              EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = e.entity_id) AS is_survivor,
              COALESCE(e.is_active, true) AS is_active,
              EXISTS (SELECT 1
                        FROM ci.entities t
                       WHERE t.owner_user_id = $1::uuid
                         AND t.entity_type = c.entity_type
                         AND t.linked_table = c.linked_table
                         AND t.linked_id = c.new_linked_id) AS destination_occupied,
              -- The fixed rule still keys some card in this run onto the OLD
              -- coordinate: one whose real number is those ten digits, or that
              -- is named them. Every status, so a resumed push that already
              -- sent that card still sees it.
              EXISTS (SELECT 1
                        FROM ci_import.staged_entities s
                       WHERE s.run_id = $2::uuid
                         AND s.data_source IS NOT DISTINCT FROM c.data_source
                         AND s.type IS NOT DISTINCT FROM c.staged_type
                         AND (s.identity_key = c.old_key
                              OR (s.identity_key IS NULL AND lower(btrim(s.name)) = c.old_key))) AS still_claimed
         FROM c
         JOIN ci.entities e
           ON e.owner_user_id = $1::uuid
          AND e.entity_type = c.entity_type
          AND e.linked_table = c.linked_table
          AND e.linked_id = c.old_linked_id
        -- One lock order for every push, so two runs of one source cannot
        -- deadlock on the rows they both prove.
        ORDER BY e.entity_id
          FOR UPDATE OF e`,
      [scope.userId, scope.runId, JSON.stringify(probe)],
    )) as ProbeRow[];

    const byCandidate = new Map(found.map((row) => [Number(row.candidate), row]));
    const claimsOnRow = new Map<string, number>();

    for (const row of found) {
      claimsOnRow.set(row.entity_id, (claimsOnRow.get(row.entity_id) ?? 0) + 1);
    }

    const working: Array<Record<string, unknown>> = [];

    candidates.forEach((candidate, index) => {
      const row = byCandidate.get(index);

      if (row == null) {
        result.skipped.absent += 1;

        return;
      }

      const skip: TruncatedPhoneRekeySkip | null = row.destination_occupied
        ? 'destination_occupied'
        : row.still_claimed
          ? 'still_claimed'
          : (claimsOnRow.get(row.entity_id) ?? 0) > 1
            ? 'ambiguous'
            : !rowNameAgrees({ name: cardNameOf(candidate.input) }, row, candidate.proof.truncatedHandle)
              ? 'name_mismatch'
              : null;

      if (skip != null) {
        result.skipped[skip] += 1;

        return;
      }

      const handle = candidate.proof.handle;

      working.push({
        candidate: index,
        entity_id: row.entity_id,
        owner_user_id: scope.userId,
        entity_type: probe[index].entity_type,
        linked_table: probe[index].linked_table,
        old_linked_id: probe[index].old_linked_id,
        new_linked_id: probe[index].new_linked_id,
        old_key: candidate.proof.truncatedHandle,
        new_key: handle,
        new_key_kind: handle == null ? null : handle.includes('@') ? 'email' : 'phone',
        is_tombstone: row.is_tombstone,
        is_survivor: row.is_survivor,
        // Every artifact a live, unmerged, un-merged-into row holds is its own.
        is_live: !row.is_tombstone && row.is_active && !row.is_survivor,
      });
    });

    if (working.length === 0) {
      return result;
    }

    await manager.query(CREATE_WORKING_SET, [JSON.stringify(working)]);

    const moved = ((await manager.query(REPAIR.move)) as Array<{ entity_id: string }>).map(
      (row) => row.entity_id,
    );

    // Lost to a writer between the probe and here — counted where the probe
    // would have put it had it run a moment later.
    result.skipped.destination_occupied += working.length - moved.length;

    if (moved.length === 0) {
      return result;
    }

    await manager.query(REPAIR.keepMoved, [moved]);

    for (const entry of working) {
      if (!moved.includes(String(entry.entity_id))) {
        continue;
      }

      result.moved.push({
        entityId: String(entry.entity_id),
        candidate: Number(entry.candidate),
        standing: entry.is_tombstone
          ? 'tombstone'
          : entry.is_survivor
            ? 'survivor'
            : entry.is_live
              ? 'live'
              : 'inactive',
      });
    }

    await manager.query(REPAIR.changedTable);
    await manager.query(REPAIR.properties);
    result.identifiersDeleted = await count(manager, REPAIR.identifiers);
    result.selfClaimsDeleted = await count(manager, REPAIR.selfClaims);

    await manager.query(REPAIR.links);
    result.linksWithdrawn = await count(manager, REPAIR.countLinks);

    if (result.linksWithdrawn > 0) {
      await manager.query(REPAIR.communicationFrom);
      await manager.query(REPAIR.communicationTo);
      await manager.query(REPAIR.eventOrganizer);
      await manager.query(REPAIR.eventParticipants);
      result.edgesDeleted = await count(manager, REPAIR.edges);
    }

    await manager.query(REPAIR.claims);
    result.freedIdentifiersIndexed = await count(manager, REPAIR.freed, [
      TRUNCATED_PHONE_REKEY_SOURCE,
      scope.userId,
      PHONE_EXTENSION_PATTERN,
    ]);

    await manager.query(REPAIR.searchEmbeddings);
    await manager.query(REPAIR.searchVectors);
    await manager.query(REPAIR.searchSkips);
    await manager.query(REPAIR.ledger);

    return result;
  });
}
