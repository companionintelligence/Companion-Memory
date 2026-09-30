/**
 * What a contact's TRUNCATED phone key reached, undone once its row is back
 * under the card's own key.
 *
 * ## The rows this exists for
 *
 * The shared phone join key used to keep the last ten digits of line AND
 * extension, so an office line `(212) 555-0147;229` keyed as `5550147229` — a
 * well-formed number belonging to nobody on the card. `normalizeHandle` now
 * refuses such a value, and migration 20260930020117 repaired every row it
 * could PROVE held one: vCard Persons, whose `properties.Phones` kept the typed
 * value. Apple Contacts and CSV contact lists kept nothing but the truncation,
 * so their rows were left as they were: at `contact:5550147229`, holding the
 * fabricated `ci.entity_identifiers` phone, self claim, and whatever calls and
 * messages that number had been matched to.
 *
 * ## Who moves the row, and what is left for this module
 *
 * Moving the row is `push/legacyKeys.ts`'s job. Staging records the key the
 * card was minted under (`legacyEntityIdentityKey`, which reads handles with
 * the pre-fix `legacyNormalizeHandle`), and the push moves the row from there
 * onto the card's current key before ingest — the same move that separates
 * colleagues collapsed onto one office line, with the same guard on who
 * inherits a row.
 *
 * A move keeps the row's id, and with it everything the truncation reached. So
 * once the row sits under the card's key, this module undoes those — the
 * statements migration 20260930020117 ran for the vCard rows it could prove —
 * on the proof the card carries and the row could not:
 *
 *  1. the card was minted under a truncation: its staged `legacy_identity_key`
 *     is the old rule's reading of one of its own typed phones, a single line
 *     followed by an extension ({@link isLineWithExtension});
 *  2. the truncation is not also one of the card's real numbers: no typed
 *     value keys those digits under the current rule.
 *
 * It acts on the row at the card's CURRENT coordinate, not on "the row that
 * moved", so a push that died between the move and this repair finishes it on
 * the next attempt; and it touches only what the truncation itself reached —
 * a row with no trace of it is left as it is.
 */
import type { DataSource, EntityManager } from 'typeorm';

import { type GraphEntityInputDto, GraphIngestService, PHONE_EXTENSION_PATTERN } from '@ci/domains/graph';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import { legacyNormalizeHandle, normalizeHandle } from '../staging/identity';

/**
 * Entity-metadata keys a contact parser keeps its identity handles under, AS
 * TYPED. vcard.ts, applecontacts.ts and contactlist.ts all write them.
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
 * OWN second number. Dropping that identifier and withdrawing the links it made
 * would unlink real calls. So the digits after the marker must be an
 * extension's worth, and the digits before it one line's.
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

/** Why a staged card's old key was a truncation. */
export interface TruncatedPhoneKey {
  /** The handle the card was minted under: the last ten digits of line + extension. */
  truncatedHandle: string;
  /** The card's current handle — its staged identity key — or null when it keys on its name. */
  handle: string | null;
  /** The typed values on the card that truncate to {@link truncatedHandle}. */
  typed: string[];
  /** Why, in words, the way `EntityTypeAuditService` files its evidence. */
  evidence: string[];
}

/**
 * The proof (see the module doc) for one staged entity, or null when its old
 * key was not a truncation of its own — including every row staged before
 * `legacy_identity_key` existed, which carries none.
 */
export function truncatedPhoneKeyFor(
  staged: Pick<StagedEntity, 'identityKey' | 'legacyIdentityKey' | 'metadata'>,
): TruncatedPhoneKey | null {
  const truncatedHandle = staged.legacyIdentityKey?.trim();
  const handle = staged.identityKey?.trim() || null;

  if (!truncatedHandle || truncatedHandle === handle) {
    return null;
  }

  const typed = typedHandlesOf(staged.metadata);
  const lines = typed.filter(
    (value) =>
      !value.includes('@') && isLineWithExtension(value) && legacyNormalizeHandle(value) === truncatedHandle,
  );

  // A card that also lists those ten digits as a plain number really has them:
  // the migration's "second half", and the row's identifier for them is real.
  if (lines.length === 0 || typed.some((value) => normalizeHandle(value) === truncatedHandle)) {
    return null;
  }

  return {
    truncatedHandle,
    handle,
    typed: lines,
    evidence: [
      `typed phone ${lines.join(', ')} carries an extension; the pre-fix rule keyed the card as ${truncatedHandle}`,
      `no typed value keys ${truncatedHandle} under the current rule, so no number on the card is those digits`,
      `the card keys as ${handle ?? 'its name'} now`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

/** One card whose old key was a truncation, and where its row sits now. */
export interface TruncatedPhoneRepair {
  /** The coordinate the push resolves the card under — its row's, once any move is done. */
  input: Pick<GraphEntityInputDto, 'key' | 'entityType' | 'sourceSystem'>;
  /** The staged row's `type` and `data_source`, for the still-claimed check. */
  stagedType: string | null;
  dataSource: string | null;
  proof: TruncatedPhoneKey;
}

/** Why a card's row was left as it is. */
export type TruncatedPhoneRepairSkip =
  /** No row sits under the card's current key yet: the card was never imported, or its old row stayed put. */
  | 'absent'
  /** A staged card in this run keys onto those ten digits for real, so what they reached may be real. */
  | 'still_claimed';

export interface TruncatedPhoneRepairResult {
  /** Rows the repair looked at, by standing. */
  repaired: Array<{ entityId: string; standing: 'live' | 'tombstone' | 'survivor' | 'inactive' }>;
  skipped: Record<TruncatedPhoneRepairSkip, number>;
  /** Rows whose name or properties still carried the truncation. */
  rewritten: number;
  identifiersDeleted: number;
  selfClaimsDeleted: number;
  linksWithdrawn: number;
  edgesDeleted: number;
  freedIdentifiersIndexed: number;
}

/** `ci.entity_identifiers.source` for a number {@link repairTruncatedPhoneKeys} freed and re-indexed. */
export const TRUNCATED_PHONE_REKEY_SOURCE = 'import:truncated_phone_rekey';

function emptyResult(): TruncatedPhoneRepairResult {
  return {
    repaired: [],
    skipped: { absent: 0, still_claimed: 0 },
    rewritten: 0,
    identifiersDeleted: 0,
    selfClaimsDeleted: 0,
    linksWithdrawn: 0,
    edgesDeleted: 0,
    freedIdentifiersIndexed: 0,
  };
}

interface ProbeRow {
  candidate: number;
  entity_id: string;
  is_tombstone: boolean;
  is_survivor: boolean;
  is_active: boolean;
  still_claimed: boolean;
}

/**
 * The row under each card's current key. Locked, in one order for every push,
 * so what the repair acts on stays as found until commit and two runs of one
 * source cannot deadlock on it.
 */
const PROBE = `
  WITH c AS (
    SELECT *
      FROM jsonb_to_recordset($3::jsonb) AS c(
             candidate int, entity_type text, linked_table text, data_source text, staged_type text,
             linked_id uuid, old_key text)
  )
  SELECT c.candidate,
         e.entity_id,
         e.merged_into_entity_id IS NOT NULL AS is_tombstone,
         EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = e.entity_id) AS is_survivor,
         COALESCE(e.is_active, true) AS is_active,
         -- The current rule still keys some card in this run on those ten
         -- digits: one whose real number they are, or that is named them. Every
         -- push status, so a resumed push that already sent it still sees it.
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
     AND e.linked_id = c.linked_id
   ORDER BY e.entity_id
     FOR UPDATE OF e`;

/** Rows the repair acts on. Mirrors migration 20260930020117's `_ext_vcard`. */
const CREATE_WORKING_SET = `
  CREATE TEMP TABLE _tpr ON COMMIT DROP AS
  SELECT *
    FROM jsonb_to_recordset($1::jsonb) AS t(
           entity_id uuid, owner_user_id uuid, old_key text, new_key text, new_key_kind text,
           is_tombstone boolean, is_survivor boolean, is_live boolean)`;

/**
 * The repair, in the migration's order and with its statements — every one of
 * them written against `_tpr` where the migration read `_ext_vcard`, and each
 * wrapped so it reports a count rather than TypeORM's `[rows, affected]` pair.
 * Two the migration made are left to the push itself: the move (legacyKeys.ts)
 * and indexing the card's new handle (the ingest that follows).
 */
const REPAIR = {
  changedTable: `CREATE TEMP TABLE _tpr_changed (entity_id uuid PRIMARY KEY) ON COMMIT DROP`,

  // (A2) What the fixed parser writes, on a row still showing the truncation —
  // never a merge survivor's, because `PersonMergeService` unions `phones`, so a
  // survivor's truncated digits may also be a merged-in record's real number.
  // Remembered: these are the rows whose search index and ledger are reset at
  // the end.
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
         AND (e.name = t.old_key
              OR e.properties ->> 'phone' = t.old_key
              OR COALESCE(e.properties -> 'phones', '[]'::jsonb) @> to_jsonb(t.old_key))
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

  countChanged: `SELECT count(*)::int AS n FROM _tpr_changed`,

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
 * Undo, on the row under each card's current key, what the card's truncated
 * key reached — the statements migration 20260930020117 ran for the vCard rows
 * it could prove. One transaction. Run after the legacy-key moves and before
 * the ingest that refreshes those rows.
 *
 * Idempotent: every statement is scoped to the truncation, so once it is gone
 * from a row a second run changes nothing.
 */
export async function repairTruncatedPhoneKeys(
  dataSource: Pick<DataSource, 'transaction'>,
  scope: { userId: string; runId: string },
  repairs: readonly TruncatedPhoneRepair[],
): Promise<TruncatedPhoneRepairResult> {
  const result = emptyResult();

  if (repairs.length === 0) {
    return result;
  }

  const probe = repairs.map((repair, index) => ({
    candidate: index,
    entity_type: repair.input.entityType,
    linked_table: `import:${repair.input.sourceSystem}`,
    data_source: repair.dataSource,
    staged_type: repair.stagedType,
    linked_id: GraphIngestService.linkedIdFor(repair.input.key),
    old_key: repair.proof.truncatedHandle,
  }));

  return dataSource.transaction(async (manager) => {
    const found = (await manager.query(PROBE, [
      scope.userId,
      scope.runId,
      JSON.stringify(probe),
    ])) as ProbeRow[];
    const byCandidate = new Map(found.map((row) => [Number(row.candidate), row]));
    const working: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    repairs.forEach((repair, index) => {
      const row = byCandidate.get(index);

      if (row == null) {
        result.skipped.absent += 1;

        return;
      }

      if (row.still_claimed) {
        result.skipped.still_claimed += 1;

        return;
      }

      if (seen.has(row.entity_id)) {
        return;
      }

      seen.add(row.entity_id);

      const handle = repair.proof.handle;
      // Every artifact a live, unmerged, un-merged-into row holds is its own.
      const isLive = !row.is_tombstone && row.is_active && !row.is_survivor;

      working.push({
        entity_id: row.entity_id,
        owner_user_id: scope.userId,
        old_key: repair.proof.truncatedHandle,
        new_key: handle,
        new_key_kind: handle == null ? null : handle.includes('@') ? 'email' : 'phone',
        is_tombstone: row.is_tombstone,
        is_survivor: row.is_survivor,
        is_live: isLive,
      });
      result.repaired.push({
        entityId: row.entity_id,
        standing: row.is_tombstone
          ? 'tombstone'
          : row.is_survivor
            ? 'survivor'
            : isLive
              ? 'live'
              : 'inactive',
      });
    });

    if (working.length === 0) {
      return result;
    }

    await manager.query(CREATE_WORKING_SET, [JSON.stringify(working)]);
    await manager.query(REPAIR.changedTable);
    await manager.query(REPAIR.properties);
    result.rewritten = await count(manager, REPAIR.countChanged);
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
